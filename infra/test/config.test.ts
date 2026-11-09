import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppContext, AppContextError, ProjectPrefixType } from '../lib/template/app-context';
import { ACCOUNTS, configPath, synthConfig, templateOf, writeConfigCopy } from './helpers';

describe('AppContext and config validation', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('fails clearly when APP_CONFIG is not set', () => {
        vi.stubEnv('APP_CONFIG', '');
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(() => new AppContext({ appConfigFileKey: 'APP_CONFIG' })).toThrow(AppContextError);
    });

    it('reads APP_CONFIG from the environment and prefixes stack names Name-Stage', () => {
        vi.stubEnv('APP_CONFIG', configPath('beta'));
        const appContext = new AppContext({ appConfigFileKey: 'APP_CONFIG', projectPrefixType: ProjectPrefixType.NameHyphenStage });
        expect(appContext.stackCommonProps.projectPrefix).toBe('Photo-Beta');
        expect(appContext.appConfig.Stack.Web.Name).toBe('Photo-Beta-Web');
        expect(appContext.appConfig.Stack.Web.ShortStackName).toBe('Web');
        expect(appContext.stackCommonProps.env).toEqual({ account: ACCOUNTS.beta, region: 'us-east-1' });
    });

    it('ignores a context override for a key the config does not have', () => {
        // synthConfig always passes Stack.Web.DistPath; the account config has no Web stack.
        expect(() => synthConfig(configPath('account-beta'))).not.toThrow();
    });

    it('rejects unknown stack keys', () => {
        const file = writeConfigCopy('beta', (config) => { config.Stack.Webb = { Name: 'Webb' }; });
        expect(() => synthConfig(file)).toThrow(/Unknown stack key\(s\) Webb/);
    });

    it('rejects a missing throttle instead of dropping it', () => {
        const file = writeConfigCopy('prod', (config) => { delete config.Stack.Api.BookingRateLimit; });
        expect(() => synthConfig(file)).toThrow(/Api\.BookingRateLimit must be a positive integer/);
    });

    it('rejects a negative reservation', () => {
        const file = writeConfigCopy('beta', (config) => { config.Stack.Api.ReservedConcurrency = -1; });
        expect(() => synthConfig(file)).toThrow(/Api\.ReservedConcurrency must be a non-negative integer/);
    });

    it('explains a missing site build', () => {
        expect(() => synthConfig(configPath('beta'), { 'Stack.Web.DistPath': '/nonexistent/dist' }))
            .toThrow(/run `npm run build` at the repo root first/);
    });

    it('rejects a log retention CloudWatch does not offer', () => {
        const file = writeConfigCopy('beta', (config) => { config.Stack.Api.LogRetentionDays = 15; });
        expect(() => synthConfig(file)).toThrow(/LogRetentionDays must be one of/);
    });

    it('defaults the OIDC subject prefix to repo:<owner>/<name> and rejects one without repo:', () => {
        const legacy = writeConfigCopy('beta', (config) => { delete config.Stack.Cicd.GitHubSubjectPrefix; });
        const role = templateOf(synthConfig(legacy).stacks.cicd).findResources('AWS::IAM::Role');
        const doc = JSON.stringify(Object.values(role)[0]);
        expect(doc).toContain('repo:Njones27/Photo_Website:environment:beta');

        const bad = writeConfigCopy('beta', (config) => { config.Stack.Cicd.GitHubSubjectPrefix = 'Njones27/Photo_Website'; });
        expect(() => synthConfig(bad)).toThrow(/GitHubSubjectPrefix must start with repo:/);
    });
});
