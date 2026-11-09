// Alarms and a small dashboard for one stage. Resource names/IDs come from SSM (written by Api and Web);
// the logged-errors and throttled metrics come from metric filters in the Api stack. Alarms email the
// address in the account's `<Project>-Account-AlertEmail` SSM parameter (written by script/setup_initial.sh).

import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

import { AppContext } from '../lib/template/app-context';
import { StackConfig } from '../lib/template/app-config';
import { BaseStack } from '../lib/template/stack/base/base-stack';
import { configPositiveInt } from '../lib/config-values';
import {
    ALERT_EMAIL_KEY,
    alertEmailPrefix,
    API_LOGGED_ERRORS_METRIC,
    API_THROTTLED_METRIC,
    stageNamespace,
} from '../lib/metrics';

const FIVE_MINUTES = cdk.Duration.minutes(5);

export class OpsStack extends BaseStack {
    public readonly alarmTopic: sns.Topic;

    constructor(appContext: AppContext, stackConfig: StackConfig) {
        super(appContext, stackConfig);

        const functionName = this.getParameter('FunctionName');
        const apiId = this.getParameter('ApiId');
        const distributionId = this.getParameter('DistributionId');

        this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
            topicName: this.withProjectPrefix('Alarms'),
            displayName: `Photo ${this.stage} alarms`,
        });
        // The subscription stays "pending confirmation" until someone clicks the link AWS emails to this address.
        const projectName = this.commonProps.appConfig.Project.Name;
        const alertEmail = this.getParameter(ALERT_EMAIL_KEY, true, alertEmailPrefix(projectName));
        this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail));

        const lambdaMetric = (metricName: string, statistic = 'Sum') => new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName,
            dimensionsMap: { FunctionName: functionName },
            statistic,
            period: FIVE_MINUTES,
        });
        const apiMetric = (metricName: string, statistic = 'Sum') => new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName,
            dimensionsMap: { ApiId: apiId },
            statistic,
            period: FIVE_MINUTES,
        });
        // CloudFront publishes its metrics in us-east-1 with Region=Global.
        const cloudFrontMetric = (metricName: string, statistic = 'Average') => new cloudwatch.Metric({
            namespace: 'AWS/CloudFront',
            metricName,
            dimensionsMap: { DistributionId: distributionId, Region: 'Global' },
            statistic,
            period: FIVE_MINUTES,
        });

        const stageMetric = (metricName: string) => new cloudwatch.Metric({
            namespace: stageNamespace(projectName, this.commonProps.appConfig.Project.Stage),
            metricName,
            statistic: 'Sum',
            period: FIVE_MINUTES,
        });
        const loggedErrors = stageMetric(API_LOGGED_ERRORS_METRIC);
        const throttled = stageMetric(API_THROTTLED_METRIC);
        const api5xxThreshold = configPositiveInt(stackConfig, 'Api5xxThreshold');
        const throttledThreshold = configPositiveInt(stackConfig, 'ThrottledThreshold');

        const alarmAction = new cloudwatchActions.SnsAction(this.alarmTopic);
        const alarm = (id: string, metric: cloudwatch.Metric, threshold: number, description: string) => {
            const created = new cloudwatch.Alarm(this, id, {
                alarmName: this.withProjectPrefix(id),
                alarmDescription: description,
                metric,
                threshold,
                evaluationPeriods: 1,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            });
            created.addAlarmAction(alarmAction);
            return created;
        };

        // The handler answers exceptions with a 500, so LambdaErrors only fires on crashes and timeouts;
        // ApiLoggedErrors and Api5xx are the ones that see handled failures.
        alarm('LambdaErrors', lambdaMetric('Errors'), 1, 'API Lambda crashed or timed out at least once in 5 minutes');
        alarm('ApiLoggedErrors', loggedErrors, 1, 'API Lambda logged at least one error line in 5 minutes');
        alarm('LambdaThrottles', lambdaMetric('Throttles'), 1,
            'API Lambda hit its reserved concurrency; raise Api.ReservedConcurrency if this repeats');
        alarm('Api5xx', apiMetric('5xx'), api5xxThreshold, `HTTP API returned ${api5xxThreshold} or more 5xx responses in 5 minutes`);
        // Abuse signal: the booking form being hammered. The cue to consider AWS WAF per-IP rate limits.
        alarm('ApiThrottled', throttled, throttledThreshold,
            `${throttledThreshold} or more requests throttled in 5 minutes: someone may be using up the shared rate limits`);
        if (this.region === 'us-east-1') {
            alarm('CloudFront5xxRate', cloudFrontMetric('5xxErrorRate'), 5, 'CloudFront 5xx error rate at or above 5%');
        } else {
            cdk.Annotations.of(this).addWarningV2('photo:cloudfront-alarm',
                'CloudFront metrics live in us-east-1; the CloudFront 5xx alarm is skipped in other regions');
        }

        new cloudwatch.Dashboard(this, 'Dashboard', {
            dashboardName: this.withProjectPrefix('Overview'),
            defaultInterval: cdk.Duration.days(1),
            widgets: [
                [
                    new cloudwatch.GraphWidget({
                        title: 'API requests and errors',
                        left: [apiMetric('Count'), apiMetric('4xx'), apiMetric('5xx')],
                        width: 12,
                    }),
                    new cloudwatch.GraphWidget({
                        title: 'API latency (ms)',
                        left: [apiMetric('Latency', 'p50'), apiMetric('Latency', 'p95'), apiMetric('IntegrationLatency', 'p95')],
                        width: 12,
                    }),
                ],
                [
                    new cloudwatch.GraphWidget({
                        title: 'Lambda invocations, errors, throttles, logged errors',
                        left: [lambdaMetric('Invocations'), lambdaMetric('Errors'), lambdaMetric('Throttles'), loggedErrors],
                        right: [lambdaMetric('ConcurrentExecutions', 'Maximum')],
                        width: 12,
                    }),
                    new cloudwatch.GraphWidget({
                        title: 'CloudFront requests and error rates (%)',
                        left: [cloudFrontMetric('Requests', 'Sum')],
                        right: [cloudFrontMetric('4xxErrorRate'), cloudFrontMetric('5xxErrorRate')],
                        width: 12,
                    }),
                ],
                [
                    new cloudwatch.GraphWidget({
                        title: 'Throttled requests (booking form abuse signal)',
                        left: [throttled],
                        width: 24,
                    }),
                ],
            ],
        });
    }
}
