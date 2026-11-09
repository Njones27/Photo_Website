import { describe, expect, it } from 'vitest';
import { Match } from 'aws-cdk-lib/assertions';

import { ACCOUNTS, configPath, stackIds, synthConfig, templateOf, writeConfigCopy } from './helpers';

// One account config per AWS account: beta and prod live in separate AWS Organizations member accounts.
describe.each([
    { name: 'account-beta' as const, account: ACCOUNTS.beta, profile: 'photo-beta' },
    { name: 'account-prod' as const, account: ACCOUNTS.prod, profile: 'photo-prod' },
])('$name config', ({ name, account, profile }) => {
    const result = synthConfig(configPath(name));
    const template = templateOf(result.stacks.gitHubOidc);

    it('creates only the GitHubOidc stack, in its own account', () => {
        expect(stackIds(result)).toEqual(['Photo-Account-GitHubOidc']);
        expect(result.appContext.stackCommonProps.env).toEqual({ account, region: 'us-east-1' });
        expect(result.appContext.appConfig.Project.Profile).toBe(profile);
    });

    it('creates the GitHub OIDC provider for sts.amazonaws.com (a new account has none)', () => {
        template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
        template.hasResourceProperties('AWS::IAM::OIDCProvider', {
            Url: 'https://token.actions.githubusercontent.com',
            ClientIdList: ['sts.amazonaws.com'],
        });
        template.hasOutput('GitHubOidcProviderArn', {});
    });

    it('creates the monthly budgets without notifications while BudgetEmail is empty', () => {
        template.resourceCountIs('AWS::Budgets::Budget', 2);
        for (const limit of [10, 25]) {
            template.hasResourceProperties('AWS::Budgets::Budget', {
                Budget: Match.objectLike({ BudgetLimit: { Amount: limit, Unit: 'USD' }, TimeUnit: 'MONTHLY', BudgetType: 'COST' }),
                NotificationsWithSubscribers: Match.absent(),
            });
        }
    });

    it('adds an ACTUAL > 100% email notification once BudgetEmail is set, and can import an existing provider', () => {
        const providerArn = `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`;
        const file = writeConfigCopy(name, (config) => {
            config.Stack.GitHubOidc.BudgetEmail = 'owner@example.com';
            config.Stack.GitHubOidc.CreateProvider = false;
            config.Stack.GitHubOidc.ExistingProviderArn = providerArn;
        });

        const withEmail = templateOf(synthConfig(file).stacks.gitHubOidc);
        withEmail.resourceCountIs('AWS::IAM::OIDCProvider', 0);
        withEmail.hasOutput('GitHubOidcProviderArn', { Value: providerArn });
        withEmail.hasResourceProperties('AWS::Budgets::Budget', {
            NotificationsWithSubscribers: [{
                Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 100, ThresholdType: 'PERCENTAGE' },
                Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'owner@example.com' }],
            }],
        });
    });
});

describe('account and stage configs', () => {
    it('pair up: each stage config targets the same account, region and profile as its account config', () => {
        for (const stage of ['beta', 'prod'] as const) {
            const accountProject = synthConfig(configPath(`account-${stage}`)).appContext.appConfig.Project;
            const stageProject = synthConfig(configPath(stage)).appContext.appConfig.Project;
            expect(stageProject.Account).toBe(ACCOUNTS[stage]);
            expect({ ...stageProject, Stage: 'Account' }).toEqual(accountProject);
        }
        expect(ACCOUNTS.beta).not.toBe(ACCOUNTS.prod);
    });
});
