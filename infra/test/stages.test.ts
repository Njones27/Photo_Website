import { describe, expect, it } from 'vitest';
import { Match } from 'aws-cdk-lib/assertions';

import { API_ROUTES } from '../stack/api-stack';
import { contentSecurityPolicy, inlineScriptHashes } from '../stack/web-stack';
import { ACCOUNTS, configPath, FIXTURE_CSP, onlyResource, stackIds, synthConfig, templateOf, writeConfigCopy } from './helpers';

const expectations = {
    beta: {
        account: ACCOUNTS.beta, prefix: 'Photo-Beta', namespace: 'Photo/Beta', retention: 14, retainSite: false, api5xx: 5,
    },
    prod: {
        account: ACCOUNTS.prod, prefix: 'Photo-Prod', namespace: 'Photo/Prod', retention: 30, retainSite: true, api5xx: 1,
    },
} as const;

describe.each(Object.entries(expectations))('%s config', (stage, want) => {
    const result = synthConfig(configPath(stage as 'beta' | 'prod'));
    const { stacks } = result;

    it('creates the four stage stacks, ordered Api -> Web -> Ops', () => {
        expect(stackIds(result)).toEqual(['Cicd', 'Api', 'Web', 'Ops'].map((s) => `${want.prefix}-${s}`));
        expect(stacks.api!.dependencies).toEqual([]);
        expect(stacks.web!.dependencies).toEqual([stacks.api]);
        expect(stacks.ops!.dependencies).toEqual([stacks.web]);
        expect(stacks.cicd!.dependencies).toEqual([]);
    });

    describe('Cicd', () => {
        const template = templateOf(stacks.cicd);

        it('trusts only this repo and GitHub environment through the account OIDC provider', () => {
            // Exact subject in GitHub's immutable format (owner and repo ids), no wildcard.
            template.hasResourceProperties('AWS::IAM::Role', {
                RoleName: `${want.prefix}-GitHubDeploy`,
                MaxSessionDuration: 7200,
                AssumeRolePolicyDocument: {
                    Statement: [Match.objectLike({
                        Action: 'sts:AssumeRoleWithWebIdentity',
                        Principal: { Federated: `arn:aws:iam::${want.account}:oidc-provider/token.actions.githubusercontent.com` },
                        Condition: {
                            StringEquals: {
                                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                                'token.actions.githubusercontent.com:sub': `repo:Njones27@153565100/Photo_Website@1448968508:environment:${stage}`,
                            },
                        },
                    })],
                },
            });
        });

        it('may only assume the CDK deploy and file-publishing roles and read two SSM parameters', () => {
            const role = onlyResource(template, 'AWS::IAM::Role');
            expect(role.Properties.ManagedPolicyArns).toBeUndefined();
            const statements = role.Properties.Policies[0].PolicyDocument.Statement;
            expect(statements.map((s: { Action: string }) => s.Action)).toEqual(['sts:AssumeRole', 'ssm:GetParameter', 'ssm:GetParameter']);
            expect(statements[0].Resource).toEqual(['deploy', 'file-publishing'].map(
                (kind) => `arn:aws:iam::${want.account}:role/cdk-hnb659fds-${kind}-role-${want.account}-us-east-1`,
            ));
            expect(statements[1].Resource).toBe(`arn:aws:ssm:us-east-1:${want.account}:parameter/cdk-bootstrap/hnb659fds/version`);
            expect(statements[2].Resource).toBe(`arn:aws:ssm:us-east-1:${want.account}:parameter/${want.prefix}-DistributionDomain`);
        });
    });

    describe('Api', () => {
        const template = templateOf(stacks.api);

        it('runs the handler on Node 24, arm64, JSON logs, emailing the account address', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Runtime: 'nodejs24.x',
                Architectures: ['arm64'],
                Timeout: 10,
                ReservedConcurrentExecutions: Match.absent(),
                LoggingConfig: Match.objectLike({ LogFormat: 'JSON' }),
                Environment: {
                    Variables: Match.objectLike({
                        STAGE: stage,
                        ORIGIN_VERIFY_SECRET: { Ref: Match.stringLikeRegexp('OriginVerifySecret') },
                        BOOKING_EMAIL: { Ref: Match.stringLikeRegexp('PhotoAccountAlertEmail') },
                    }),
                },
            });
            const params = template.toJSON().Parameters ?? {};
            expect(Object.values(params).map((p: any) => p.Default)).toContain('Photo-Account-AlertEmail');
        });

        it('exposes exactly the health and booking routes, without CORS', () => {
            const routeKeys = Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map((r) => r.Properties.RouteKey);
            expect(routeKeys.sort()).toEqual(API_ROUTES.map((r) => `${r.method} ${r.path}`).sort());
            expect(routeKeys.sort()).toEqual(['GET /api/health', 'POST /api/booking']);
            template.hasResourceProperties('AWS::ApiGatewayV2::Api', { CorsConfiguration: Match.absent() });
        });

        it('throttles the stage, and the booking route tighter (burst 2x rate)', () => {
            const stageProps = onlyResource(template, 'AWS::ApiGatewayV2::Stage').Properties;
            expect(stageProps.DefaultRouteSettings).toEqual({ ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 });
            expect(stageProps.RouteSettings).toEqual({ 'POST /api/booking': { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 4 } });
            expect(stageProps.AccessLogSettings.Format).toMatch(/requestId/);
        });

        it('grants the function only ses:SendEmail on this account\'s identities', () => {
            const statements = Object.values(template.findResources('AWS::IAM::Policy'))
                .map((r) => r.Properties.PolicyDocument.Statement).flat();
            const send = statements.find((st: { Sid?: string }) => st.Sid === 'SendBookingEmail');
            expect(send.Action).toBe('ses:SendEmail');
            expect(send.Resource).toBe(`arn:aws:ses:us-east-1:${want.account}:identity/*`);
        });

        it('counts logged error lines and throttled requests into custom metrics', () => {
            template.hasResourceProperties('AWS::Logs::MetricFilter', {
                FilterPattern: '{ ($.level = "ERROR") || ($.level = "error") }',
                LogGroupName: { Ref: Match.stringLikeRegexp('ApiFunctionLogs') },
                MetricTransformations: [{ MetricNamespace: want.namespace, MetricName: 'ApiLoggedErrors', MetricValue: '1' }],
            });
            template.hasResourceProperties('AWS::Logs::MetricFilter', {
                FilterPattern: '{ $.status = "429" }',
                LogGroupName: { Ref: Match.stringLikeRegexp('ApiAccessLogs') },
                MetricTransformations: [{ MetricNamespace: want.namespace, MetricName: 'ApiThrottled', MetricValue: '1' }],
            });
        });

        it(`keeps logs for ${want.retention} days`, () => {
            template.resourcePropertiesCountIs('AWS::Logs::LogGroup', { RetentionInDays: want.retention }, 2);
        });
    });

    describe('Web', () => {
        const template = templateOf(stacks.web);
        const config = onlyResource(template, 'AWS::CloudFront::Distribution').Properties.DistributionConfig;

        it('keeps both buckets private, and keeps the media bucket on delete in every stage', () => {
            const buckets = Object.entries(template.findResources('AWS::S3::Bucket'));
            expect(buckets).toHaveLength(2);
            for (const [, bucket] of buckets) {
                expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
                    BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
                });
            }
            const byId = Object.fromEntries(buckets.map(([id, b]) => [id.replace(/[A-F0-9]{8}$/, ''), b]));
            expect(byId.MediaBucket.DeletionPolicy).toBe('Retain');
            expect(byId.SiteBucket.DeletionPolicy).toBe(want.retainSite ? 'Retain' : 'Delete');
        });

        it('opens gallery.html at / and has no custom error responses', () => {
            expect(config.DefaultRootObject).toBe('gallery.html');
            expect(config.CustomErrorResponses).toBeUndefined();
            expect(config.HttpVersion).toBe('http2and3');
            expect(config.PriceClass).toBe('PriceClass_100');
        });

        it('routes /p, /k and /t to the media bucket and /api/* to the API', () => {
            expect(config.CacheBehaviors.map((b: { PathPattern: string }) => b.PathPattern)).toEqual(['/p/*', '/k/*', '/t/*', '/api/*']);
            const originOf = (id: string) => config.Origins.find((o: { Id: string }) => o.Id === id);
            const mediaOrigins = new Set(config.CacheBehaviors.slice(0, 3).map((b: { TargetOriginId: string }) => b.TargetOriginId));
            expect(mediaOrigins.size).toBe(1);
            const media = originOf([...mediaOrigins][0] as string);
            expect(JSON.stringify(media.DomainName)).toMatch(/MediaBucket/);
            expect(JSON.stringify(originOf(config.DefaultCacheBehavior.TargetOriginId).DomainName)).toMatch(/SiteBucket/);
            expect(config.CacheBehaviors[3]).toMatchObject({
                PathPattern: '/api/*',
                ViewerProtocolPolicy: 'https-only',
                CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // Managed-CachingDisabled
                OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac', // Managed-AllViewerExceptHostHeader
            });
        });

        it('sends the origin-verify header to the API origin only', () => {
            const withHeader = config.Origins.filter((o: { OriginCustomHeaders?: unknown[] }) => o.OriginCustomHeaders);
            expect(withHeader).toHaveLength(1);
            expect(withHeader[0].OriginCustomHeaders).toEqual([{
                HeaderName: 'x-origin-verify',
                HeaderValue: { Ref: expect.stringMatching(/OriginVerifySecret/) },
            }]);
        });

        it('sends HSTS, nosniff, frame DENY, referrer policy and an enforced CSP with the page\'s script hashes', () => {
            const policy = onlyResource(template, 'AWS::CloudFront::ResponseHeadersPolicy').Properties.ResponseHeadersPolicyConfig;
            expect(policy.SecurityHeadersConfig.StrictTransportSecurity).toMatchObject({ AccessControlMaxAgeSec: 63072000, IncludeSubdomains: true });
            expect(policy.SecurityHeadersConfig.ContentTypeOptions).toEqual({ Override: true });
            expect(policy.SecurityHeadersConfig.FrameOptions).toEqual({ FrameOption: 'DENY', Override: true });
            expect(policy.SecurityHeadersConfig.ReferrerPolicy.ReferrerPolicy).toBe('strict-origin-when-cross-origin');
            expect(policy.SecurityHeadersConfig.ContentSecurityPolicy).toEqual({ ContentSecurityPolicy: FIXTURE_CSP, Override: true });
            expect(policy.CustomHeadersConfig).toBeUndefined();
            for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "form-action 'self'", "connect-src 'self'"]) {
                expect(FIXTURE_CSP).toContain(directive);
            }
            expect(FIXTURE_CSP).not.toContain("'unsafe-inline' 'sha256");
            expect(FIXTURE_CSP).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/]+=*'/);
        });

        it('uploads the site as revalidate, invalidating CloudFront, never pruning', () => {
            const deployment = onlyResource(template, 'Custom::CDKBucketDeployment').Properties;
            expect(deployment.SystemMetadata).toEqual({ 'cache-control': 'public, max-age=0, s-maxage=86400, must-revalidate' });
            expect(deployment.DistributionPaths).toEqual(['/*']);
            expect(deployment.Prune).toBe(false);
        });

        it('publishes the bucket names and distribution to SSM for the photo script and smoke test', () => {
            for (const key of ['WebBucketName', 'MediaBucketName', 'DistributionId', 'DistributionDomain']) {
                template.hasResourceProperties('AWS::SSM::Parameter', { Name: `${want.prefix}-${key}` });
            }
        });

        it('creates no DNS records or certificate while DomainName is empty', () => {
            template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
            template.resourceCountIs('AWS::Route53::RecordSet', 0);
            expect(config.Aliases).toBeUndefined();
        });
    });

    describe('Ops', () => {
        const template = templateOf(stacks.ops);

        it('alarms on errors, throttles and 5xx, all to SNS', () => {
            const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map((r) => r.Properties);
            expect(alarms.map((a) => a.MetricName).sort()).toEqual([
                '5xx', '5xxErrorRate', 'ApiLoggedErrors', 'ApiThrottled', 'Errors', 'Throttles',
            ]);
            for (const alarm of alarms) {
                expect(alarm.AlarmActions).toEqual([{ Ref: expect.stringMatching(/AlarmTopic/) }]);
                expect(alarm.ComparisonOperator).toBe('GreaterThanOrEqualToThreshold');
                expect(alarm.Period).toBe(300);
            }
            const byMetric = Object.fromEntries(alarms.map((a) => [a.MetricName, a]));
            expect(byMetric['5xx'].Threshold).toBe(want.api5xx);
            expect(byMetric.ApiLoggedErrors).toMatchObject({ Namespace: want.namespace, Threshold: 1, Statistic: 'Sum' });
            expect(byMetric.ApiThrottled).toMatchObject({ Namespace: want.namespace, Threshold: 50, Statistic: 'Sum' });
        });

        it('emails the account alert address from SSM, never one written in the repo', () => {
            template.resourceCountIs('AWS::SNS::Subscription', 1);
            template.hasResourceProperties('AWS::SNS::Subscription', {
                Protocol: 'email',
                Endpoint: { Ref: Match.stringLikeRegexp('PhotoAccountAlertEmail') },
            });
            template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
        });
    });
});

describe('inline script hashes', () => {
    it('hashes inline scripts only, matching what browsers compute', () => {
        const html = '<script src="a.js"></script><script>alert(1)</script>\n<script type="module">\nlet x = 2;\n</script>';
        expect(inlineScriptHashes(html)).toEqual([
            "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='",
            "'sha256-/VgBlHAuGaZUAqy9ftFcHhKhtDNQZMaIC38jpkM8ZCI='",
        ]);
        expect(contentSecurityPolicy([])).toContain("script-src 'self';");
    });
});

describe('config switches', () => {
    it('can send the CSP report-only by setting Web.CspReportOnly, keeping the other headers', () => {
        const file = writeConfigCopy('prod', (config) => { config.Stack.Web.CspReportOnly = true; });
        const policy = onlyResource(templateOf(synthConfig(file).stacks.web), 'AWS::CloudFront::ResponseHeadersPolicy')
            .Properties.ResponseHeadersPolicyConfig;
        expect(policy.SecurityHeadersConfig.ContentSecurityPolicy).toBeUndefined();
        expect(policy.SecurityHeadersConfig.FrameOptions).toEqual({ FrameOption: 'DENY', Override: true });
        expect(policy.CustomHeadersConfig.Items).toEqual([
            { Header: 'Content-Security-Policy-Report-Only', Value: FIXTURE_CSP, Override: true },
        ]);
    });

    it('reserves concurrency when Api.ReservedConcurrency is set', () => {
        const file = writeConfigCopy('prod', (config) => { config.Stack.Api.ReservedConcurrency = 5; });
        templateOf(synthConfig(file).stacks.api).hasResourceProperties('AWS::Lambda::Function', {
            ReservedConcurrentExecutions: 5,
        });
    });

    it('serves a custom domain with a DNS-validated certificate and A/AAAA aliases once one is set', () => {
        const file = writeConfigCopy('prod', (config) => {
            config.Stack.Web.DomainName = 'nathanjonesphoto.co';
            config.Stack.Web.HostedZoneId = 'Z0000000000000000000';
        });
        const template = templateOf(synthConfig(file).stacks.web);
        template.hasResourceProperties('AWS::CertificateManager::Certificate', {
            DomainName: 'nathanjonesphoto.co',
            ValidationMethod: 'DNS',
        });
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: Match.objectLike({ Aliases: ['nathanjonesphoto.co'] }),
        });
        template.resourcePropertiesCountIs('AWS::Route53::RecordSet', { Type: 'A' }, 1);
        template.resourcePropertiesCountIs('AWS::Route53::RecordSet', { Type: 'AAAA' }, 1);
    });
});
