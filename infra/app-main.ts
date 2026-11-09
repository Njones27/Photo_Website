#!/usr/bin/env node
// CDK entry point (cdk.json: `npx tsx app-main.ts`). Shaped like aws-samples/aws-cdk-project-template-for-devops
// infra/app-main.ts: pick a config with `-c APP_CONFIG=config/app-config-<account-beta|account-prod|beta|prod>.json` or `export APP_CONFIG=...`.

import { AppContext, AppContextError, ProjectPrefixType } from './lib/template/app-context';
import { createStacks } from './lib/create-stacks';

try {
    const appContext = new AppContext({
        appConfigFileKey: 'APP_CONFIG',
        projectPrefixType: ProjectPrefixType.NameHyphenStage,
        contextArgs: ['Stack.Web.DistPath'],
    });

    createStacks(appContext);
} catch (error) {
    if (error instanceof AppContextError) {
        console.error('[AppContextError]:', error.message);
    } else {
        console.error('[Error]: not-handled-error', error);
    }
    process.exitCode = 1;
}
