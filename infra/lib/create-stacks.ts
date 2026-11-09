// Instantiates whichever stacks the loaded config lists under `Stack`:
// - config/app-config-account-<beta|prod>.json: GitHubOidc (one per AWS account)
// - config/app-config-<stage>.json: Cicd, Api, Web, Ops
// Stacks share values through SSM parameters resolved at deploy time, so the explicit dependencies below are
// what makes `cdk deploy` run them in order: Api -> Web -> Ops. Cicd stands alone.

import * as cdk from 'aws-cdk-lib';

import { AppContext } from './template/app-context';
import { applyRoleBoundary } from './permissions-boundary';
import { ApiStack } from '../stack/api-stack';
import { CicdStack } from '../stack/cicd-stack';
import { GitHubOidcStack } from '../stack/github-oidc-stack';
import { OpsStack } from '../stack/ops-stack';
import { WebStack } from '../stack/web-stack';

export interface PhotoStacks {
    gitHubOidc?: GitHubOidcStack;
    cicd?: CicdStack;
    api?: ApiStack;
    web?: WebStack;
    ops?: OpsStack;
}

const KNOWN_STACKS = ['GitHubOidc', 'Cicd', 'Api', 'Web', 'Ops'];

export function createStacks(appContext: AppContext): PhotoStacks {
    const { Project, Stack } = appContext.appConfig;

    const unknown = Object.keys(Stack).filter((key) => !KNOWN_STACKS.includes(key));
    if (unknown.length > 0) {
        throw new Error(`[config] Unknown stack key(s) ${unknown.join(', ')}; expected some of ${KNOWN_STACKS.join(', ')}`);
    }

    const stacks: PhotoStacks = {
        gitHubOidc: Stack.GitHubOidc && new GitHubOidcStack(appContext, Stack.GitHubOidc),
        cicd: Stack.Cicd && new CicdStack(appContext, Stack.Cicd),
        api: Stack.Api && new ApiStack(appContext, Stack.Api),
        web: Stack.Web && new WebStack(appContext, Stack.Web),
        ops: Stack.Ops && new OpsStack(appContext, Stack.Ops),
    };

    const ordered = [stacks.api, stacks.web, stacks.ops].filter((s): s is NonNullable<typeof s> => s !== undefined);
    for (let i = 1; i < ordered.length; i++) {
        ordered[i].addStackDependency(ordered[i - 1], `${ordered[i - 1].stackName} writes SSM parameters it reads`);
    }

    cdk.Tags.of(appContext.cdkApp).add('Project', Project.Name);
    cdk.Tags.of(appContext.cdkApp).add('Stage', Project.Stage);
    // Every role gets the Photo-RoleBoundary permissions boundary (required by the bootstrap exec policy).
    applyRoleBoundary(appContext.cdkApp);

    return stacks;
}
