// HTTP API + one small Lambda that turns booking requests into an email to the AWS account's own address (SES).
// CloudFront (Web stack) is the only intended caller: it adds `x-origin-verify`, which the Lambda checks against
// ORIGIN_VERIFY_SECRET. The routes and env vars are listed in infra/README.md.

import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';

import { AppContext } from '../lib/template/app-context';
import { StackConfig } from '../lib/template/app-config';
import { BaseStack } from '../lib/template/stack/base/base-stack';
import { configOptionalNonNegativeInt, configPositiveInt } from '../lib/config-values';
import { ALERT_EMAIL_KEY, alertEmailPrefix, API_LOGGED_ERRORS_METRIC, API_THROTTLED_METRIC, stageNamespace } from '../lib/metrics';

const REPO_ROOT = path.join(__dirname, '..', '..');

/** Every route the Lambda serves. API Gateway answers anything else with its own 404. */
export const API_ROUTES: ReadonlyArray<{ method: apigwv2.HttpMethod; path: string }> = [
    { method: apigwv2.HttpMethod.GET, path: '/api/health' },
    { method: apigwv2.HttpMethod.POST, path: '/api/booking' },
];

/**
 * Routes with their own (tighter) throttle, and the config key that sets each rate in requests per second.
 * Burst is always twice the rate. Everything else gets the stage default (ThrottleRateLimit/ThrottleBurstLimit).
 */
export const ROUTE_THROTTLES: ReadonlyArray<{ routeKey: string; rateKey: string }> = [
    { routeKey: 'POST /api/booking', rateKey: 'BookingRateLimit' },
];

/**
 * Error-level log lines. The function logs in Lambda's JSON format, where every console.error line has
 * `"level":"ERROR"`; the lowercase form matches the handler's own `level` field if it ever writes raw JSON lines.
 */
export const LOGGED_ERROR_PATTERN = '{ ($.level = "ERROR") || ($.level = "error") }';

/** Access-log lines for requests API Gateway throttled. */
export const THROTTLED_PATTERN = '{ $.status = "429" }';

/** Map a day count from config onto the CloudWatch Logs retention enum (whose values are day counts). */
export function toRetentionDays(days: number): logs.RetentionDays {
    const allowed = Object.values(logs.RetentionDays).filter((v): v is number => typeof v === 'number');
    if (!allowed.includes(days)) {
        throw new Error(`[config] Api.LogRetentionDays must be one of ${allowed.join(', ')} (got ${days})`);
    }
    return days as logs.RetentionDays;
}

export class ApiStack extends BaseStack {
    public readonly httpApi: apigwv2.HttpApi;
    public readonly handler: lambdaNodejs.NodejsFunction;

    constructor(appContext: AppContext, stackConfig: StackConfig) {
        super(appContext, stackConfig);

        const rateLimit = configPositiveInt(stackConfig, 'ThrottleRateLimit');
        const burstLimit = configPositiveInt(stackConfig, 'ThrottleBurstLimit');
        const routeThrottles = ROUTE_THROTTLES.map(({ routeKey, rateKey }) => ({
            routeKey,
            rate: configPositiveInt(stackConfig, rateKey),
        }));
        // 0 or missing = no reservation. Lambda only accepts a reservation that leaves >= 100 unreserved
        // concurrency in the account, so a fresh account (quota often 10) cannot reserve anything.
        const reservedConcurrency = configOptionalNonNegativeInt(stackConfig, 'ReservedConcurrency');
        const retention = toRetentionDays(configPositiveInt(stackConfig, 'LogRetentionDays'));

        // All resolve at deploy time (CloudFormation SSM parameter types), so synth needs no AWS access.
        // OriginVerifySecret and the account's AlertEmail are created by script/setup_initial.sh, so a stage can't
        // deploy until that has run for it. AlertEmail is also the SES identity the setup script verifies.
        const originVerifySecret = this.getParameter('OriginVerifySecret');
        const bookingEmail = this.getParameter(ALERT_EMAIL_KEY, true, alertEmailPrefix(this.commonProps.appConfig.Project.Name));

        const functionLogGroup = new logs.LogGroup(this, 'ApiFunctionLogs', {
            retention,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        this.handler = new lambdaNodejs.NodejsFunction(this, 'ApiFunction', {
            entry: path.join(REPO_ROOT, 'backend', 'src', 'handler.ts'),
            handler: 'handler',
            projectRoot: REPO_ROOT,
            depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
            runtime: lambda.Runtime.NODEJS_24_X,
            architecture: lambda.Architecture.ARM_64,
            memorySize: 256,
            timeout: cdk.Duration.seconds(10),
            reservedConcurrentExecutions: reservedConcurrency > 0 ? reservedConcurrency : undefined,
            logGroup: functionLogGroup,
            // One JSON object per log line, so the error metric filter below can read `level`.
            loggingFormat: lambda.LoggingFormat.JSON,
            environment: {
                STAGE: this.stage,
                APP_VERSION: process.env.APP_VERSION ?? 'local',
                ORIGIN_VERIFY_SECRET: originVerifySecret,
                // Booking requests are sent from and to this address (the AWS account's own email).
                BOOKING_EMAIL: bookingEmail,
                NODE_OPTIONS: '--enable-source-maps',
            },
            bundling: {
                format: lambdaNodejs.OutputFormat.ESM,
                // The Node 24 runtime ships AWS SDK v3, including @aws-sdk/client-sesv2.
                externalModules: ['@aws-sdk/*'],
                minify: true,
                sourceMap: true,
                target: 'node24',
            },
        });

        // SESv2 SendEmail is authorized on the sending identity. The setup script verifies the account email as an
        // email identity, and SES sandbox also checks the recipient, which is the same address.
        this.handler.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SendBookingEmail',
            actions: ['ses:SendEmail'],
            resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
        }));

        // No CORS: the browser only ever calls the API same-origin through CloudFront.
        this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
            apiName: this.withProjectPrefix('Api'),
            description: `Photo ${this.stage} API (served under /api/* by CloudFront)`,
            createDefaultStage: true,
        });

        const integration = new HttpLambdaIntegration('ApiIntegration', this.handler);
        const routes = API_ROUTES.flatMap(({ method, path: routePath }) => this.httpApi.addRoutes({
            path: routePath,
            methods: [method],
            integration,
        }));

        const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
            retention,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Throttling and access logging live on the L1 stage. Per-route settings name route keys, which must
        // exist before the stage is updated, hence the explicit dependency on the routes.
        const cfnStage = this.httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
        cfnStage.defaultRouteSettings = {
            throttlingRateLimit: rateLimit,
            throttlingBurstLimit: burstLimit,
        };
        // RouteSettings is a raw JSON map in CloudFormation, so its keys are written in CloudFormation casing.
        cfnStage.routeSettings = Object.fromEntries(routeThrottles.map(({ routeKey, rate }) => [
            routeKey,
            { ThrottlingRateLimit: rate, ThrottlingBurstLimit: rate * 2 },
        ]));
        cfnStage.accessLogSettings = {
            destinationArn: accessLogs.logGroupArn,
            // No source IP: behind CloudFront it is an edge address anyway.
            format: JSON.stringify({
                requestId: '$context.requestId',
                requestTime: '$context.requestTime',
                routeKey: '$context.routeKey',
                status: '$context.status',
                protocol: '$context.protocol',
                responseLength: '$context.responseLength',
                responseLatency: '$context.responseLatency',
                integrationLatency: '$context.integrationLatency',
                integrationStatus: '$context.integrationStatus',
                errorMessage: '$context.error.message',
                integrationError: '$context.integrationErrorMessage',
            }),
        };
        for (const route of routes) {
            cfnStage.node.addDependency(route);
        }

        // The handler turns every exception into a 500 response, so Lambda's own Errors metric stays flat.
        // Count the error lines it logs instead; the Ops stack alarms on this metric.
        const namespace = stageNamespace(this.commonProps.appConfig.Project.Name, this.commonProps.appConfig.Project.Stage);
        new logs.MetricFilter(this, 'LoggedErrors', {
            logGroup: functionLogGroup,
            filterPattern: logs.FilterPattern.literal(LOGGED_ERROR_PATTERN),
            metricNamespace: namespace,
            metricName: API_LOGGED_ERRORS_METRIC,
            metricValue: '1',
        });
        new logs.MetricFilter(this, 'Throttled', {
            logGroup: accessLogs,
            filterPattern: logs.FilterPattern.literal(THROTTLED_PATTERN),
            metricNamespace: namespace,
            metricName: API_THROTTLED_METRIC,
            metricValue: '1',
        });

        this.putParameter('ApiId', this.httpApi.apiId);
        this.putParameter('ApiDomain', `${this.httpApi.apiId}.execute-api.${this.region}.amazonaws.com`);
        this.putParameter('FunctionName', this.handler.functionName);
    }
}
