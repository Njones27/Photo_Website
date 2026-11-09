// Private S3 buckets + CloudFront for the gallery. Three origins behind one domain:
//   default        -> site bucket, filled from dist/ on every deploy (gallery.html, portfolio.js, shared/, est/)
//   /p/* /k/* /t/* -> media bucket, the generated photo files, filled from Nathan's Mac by script/publish_photos.sh
//   /api/*         -> the HTTP API (booking form), same origin so there is no CORS
// Optional custom domain when Web.DomainName and Web.HostedZoneId are set, plus its www name unless Web.IncludeWww is
// false (a subdomain such as dev.nathanjonesphoto.co has no www). Outside prod every response says noindex.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

import { AppContext } from '../lib/template/app-context';
import { StackConfig } from '../lib/template/app-config';
import { BaseStack } from '../lib/template/stack/base/base-stack';
import { configBoolean, configOptionalBoolean, configString } from '../lib/config-values';

/** The page CloudFront serves at `/`. */
export const ROOT_OBJECT = 'gallery.html';

/** Path prefixes served from the media bucket (see scripts/build_site_set.py for what each holds). */
export const MEDIA_PREFIXES = ['p', 'k', 't'] as const;

/**
 * `'sha256-…'` sources for every inline `<script>` in the page, so the CSP can allow exactly those scripts and no
 * others. They are computed from the file this deploy uploads, so they always match it.
 */
export function inlineScriptHashes(html: string): string[] {
    const hashes: string[] = [];
    for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
        hashes.push(`'sha256-${crypto.createHash('sha256').update(match[1], 'utf8').digest('base64')}'`);
    }
    return hashes;
}

export function contentSecurityPolicy(scriptHashes: readonly string[]): string {
    return [
        "default-src 'self'",
        ['script-src', "'self'", ...scriptHashes].join(' '),
        // Inline style attributes are used throughout the page; the web fonts come from Google Fonts.
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'self'",
    ].join('; ');
}

/** Nothing in dist/ is content-hashed, so edges keep files a day (invalidated per deploy) and browsers revalidate. */
const REVALIDATE = 'public, max-age=0, s-maxage=86400, must-revalidate';

export class WebStack extends BaseStack {
    public readonly bucket: s3.Bucket;
    public readonly mediaBucket: s3.Bucket;
    public readonly distribution: cloudfront.Distribution;

    constructor(appContext: AppContext, stackConfig: StackConfig) {
        super(appContext, stackConfig);

        const domainName = configString(stackConfig, 'DomainName', '');
        const hostedZoneId = configString(stackConfig, 'HostedZoneId', '');
        const cspReportOnly = configBoolean(stackConfig, 'CspReportOnly');
        const includeWww = configOptionalBoolean(stackConfig, 'IncludeWww', true);
        // Relative paths are relative to infra/. Overridable with `-c Stack.Web.DistPath=...` (tests do).
        const distDir = path.resolve(__dirname, '..', configString(stackConfig, 'DistPath', '../dist'));
        const rootFile = path.join(distDir, ROOT_OBJECT);
        if (!fs.existsSync(rootFile)) {
            throw new Error(`[web] ${distDir} has no ${ROOT_OBJECT}: run \`npm run build\` at the repo root first `
                + '(every cdk command synthesizes this stack, even when deploying another one)');
        }
        const csp = contentSecurityPolicy(inlineScriptHashes(fs.readFileSync(rootFile, 'utf8')));
        const isProd = this.stage === 'prod';
        const customHeaders: cloudfront.ResponseCustomHeader[] = [];
        if (cspReportOnly) customHeaders.push({ header: 'Content-Security-Policy-Report-Only', value: csp, override: true });
        // Beta is a full copy of the site: keep it out of search results so it never competes with the real one.
        if (!isProd) customHeaders.push({ header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true });

        // Everything in the site bucket is rebuilt from git on each deploy, so beta can be torn down completely.
        this.bucket = new s3.Bucket(this, 'SiteBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            versioned: false,
            removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: !isProd,
        });

        // The photos are not in git: only a run of script/publish_photos.sh puts them back, so this bucket is kept
        // in every stage when the stack is deleted.
        this.mediaBucket = new s3.Bucket(this, 'MediaBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
            responseHeadersPolicyName: this.withProjectPrefix('SecurityHeaders'),
            comment: `Photo ${this.stage}: HSTS, nosniff, frame DENY, referrer policy, CSP${cspReportOnly ? ' (report-only)' : ''}`,
            securityHeadersBehavior: {
                strictTransportSecurity: {
                    accessControlMaxAge: cdk.Duration.days(730),
                    includeSubdomains: true,
                    override: true,
                },
                contentTypeOptions: { override: true },
                frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
                referrerPolicy: {
                    referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
                    override: true,
                },
                contentSecurityPolicy: cspReportOnly ? undefined : { contentSecurityPolicy: csp, override: true },
            },
            customHeadersBehavior: customHeaders.length > 0 ? { customHeaders } : undefined,
        });

        // Resolved at deploy time from SSM: the Api stack's domain and the secret created by setup_initial.sh.
        const apiDomain = this.getParameter('ApiDomain');
        const originVerifySecret = this.getParameter('OriginVerifySecret');

        const customDomain = domainName.length > 0 && hostedZoneId.length > 0;
        // The apex and www both serve the site, so either one people type works.
        const hostNames = customDomain ? (includeWww ? [domainName, `www.${domainName}`] : [domainName]) : [];
        let certificate: acm.ICertificate | undefined;
        let zone: route53.IHostedZone | undefined;
        if (customDomain) {
            if (this.region !== 'us-east-1') {
                throw new Error(`[config] CloudFront certificates must be in us-east-1; this stage is in ${this.region}`);
            }
            zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
                hostedZoneId,
                zoneName: domainName,
            });
            certificate = new acm.Certificate(this, 'Certificate', {
                domainName,
                subjectAlternativeNames: hostNames.length > 1 ? hostNames.slice(1) : undefined,
                validation: acm.CertificateValidation.fromDns(zone),
            });
        }

        // One origin per bucket, shared by every behavior that reads from it.
        const siteOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);
        const mediaOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.mediaBucket);
        const staticBehavior = (origin: cloudfront.IOrigin): cloudfront.BehaviorOptions => ({
            origin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            compress: true,
            cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            responseHeadersPolicy: securityHeaders,
        });

        // No errorResponses: the gallery uses hash routing, and custom 403/404 pages would mask API errors.
        this.distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: `Photo ${this.stage}`,
            defaultRootObject: ROOT_OBJECT,
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            domainNames: customDomain ? hostNames : undefined,
            certificate,
            defaultBehavior: staticBehavior(siteOrigin),
            additionalBehaviors: {
                ...Object.fromEntries(MEDIA_PREFIXES.map((prefix) => [`/${prefix}/*`, staticBehavior(mediaOrigin)])),
                '/api/*': {
                    origin: new origins.HttpOrigin(apiDomain, {
                        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
                        customHeaders: { 'x-origin-verify': originVerifySecret },
                    }),
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
                    compress: true,
                },
            },
        });

        if (zone) {
            const target = route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(this.distribution));
            new route53.ARecord(this, 'AliasA', { zone, recordName: domainName, target });
            new route53.AaaaRecord(this, 'AliasAAAA', { zone, recordName: domainName, target });
            if (includeWww) {
                new route53.ARecord(this, 'WwwAliasA', { zone, recordName: `www.${domainName}`, target });
                new route53.AaaaRecord(this, 'WwwAliasAAAA', { zone, recordName: `www.${domainName}`, target });
            }
        }

        // prune: false, so a file dropped from the site lingers instead of breaking a page someone still has open.
        new s3deploy.BucketDeployment(this, 'DeploySite', {
            sources: [s3deploy.Source.asset(distDir)],
            destinationBucket: this.bucket,
            prune: false,
            cacheControl: [s3deploy.CacheControl.fromString(REVALIDATE)],
            distribution: this.distribution,
            distributionPaths: ['/*'],
        });

        this.putParameter('WebBucketName', this.bucket.bucketName);
        this.putParameter('MediaBucketName', this.mediaBucket.bucketName);
        this.putParameter('DistributionId', this.distribution.distributionId);
        // Always the *.cloudfront.net name (it keeps working with a custom domain too): smoke tests, photo publishing.
        this.putParameter('DistributionDomain', this.distribution.distributionDomainName);

        const host = customDomain ? domainName : this.distribution.distributionDomainName;
        new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${host}` });
    }
}
