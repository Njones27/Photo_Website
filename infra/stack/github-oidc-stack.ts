// Account-level stack (config/app-config-account-<beta|prod>.json): the GitHub Actions OIDC provider and the AWS Budgets.
// Deployed by hand once per account by script/setup_initial.sh, never by CI, with the caller's own credentials
// (CliCredentialsStackSynthesizer): the CDK exec role is denied every OIDC provider write.

import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as iam from 'aws-cdk-lib/aws-iam';

import { AppContext } from '../lib/template/app-context';
import { StackConfig } from '../lib/template/app-config';
import { BaseStack } from '../lib/template/stack/base/base-stack';
import { configBoolean, configNumberList, configString } from '../lib/config-values';

export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';

export class GitHubOidcStack extends BaseStack {
    public readonly provider: iam.IOidcProvider;

    constructor(appContext: AppContext, stackConfig: StackConfig) {
        super(appContext, stackConfig, { synthesizer: new cdk.CliCredentialsStackSynthesizer() });

        // An account can hold only one provider per URL: set CreateProvider false to import an existing one.
        if (configBoolean(stackConfig, 'CreateProvider')) {
            this.provider = new iam.OidcProviderNative(this, 'GitHubOidc', {
                url: GITHUB_OIDC_URL,
                clientIds: ['sts.amazonaws.com'],
            });
        } else {
            const existingArn = configString(stackConfig, 'ExistingProviderArn');
            if (existingArn.length === 0) {
                throw new Error('[config] GitHubOidc.ExistingProviderArn is required when CreateProvider is false');
            }
            this.provider = iam.OidcProviderNative.fromOidcProviderArn(this, 'GitHubOidc', existingArn);
        }

        // Monthly cost budgets. They are always created (budgets without actions are free); the email
        // notification at 100% of actual spend is added only when BudgetEmail is set.
        const budgetEmail = configString(stackConfig, 'BudgetEmail', '');
        for (const limit of configNumberList(stackConfig, 'BudgetLimitsUsd')) {
            new budgets.CfnBudget(this, `MonthlyBudget${limit}Usd`, {
                budget: {
                    budgetName: `${this.projectPrefix}-Monthly-${limit}USD`,
                    budgetType: 'COST',
                    timeUnit: 'MONTHLY',
                    budgetLimit: { amount: limit, unit: 'USD' },
                },
                notificationsWithSubscribers: budgetEmail.length > 0 ? [{
                    notification: {
                        notificationType: 'ACTUAL',
                        comparisonOperator: 'GREATER_THAN',
                        threshold: 100,
                        thresholdType: 'PERCENTAGE',
                    },
                    subscribers: [{ subscriptionType: 'EMAIL', address: budgetEmail }],
                }] : undefined,
            });
        }

        new cdk.CfnOutput(this, 'GitHubOidcProviderArn', { value: this.provider.openIdConnectProviderArn });
    }
}
