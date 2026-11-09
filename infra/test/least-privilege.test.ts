// The CDK bootstrap's CloudFormation execution role runs with infra/policies/cfn-exec-policy.json and
// cfn-exec-web-ops-policy.json instead of AdministratorAccess, every app role carries the Photo-RoleBoundary
// permissions boundary (infra/policies/role-boundary.json), and the GitHub deploy role carries the narrower
// Photo-DeployRoleBoundary (deploy-role-boundary.json). The account and Cicd stacks deploy with the caller's
// credentials, never through the exec role. These tests keep the app, the policies
// and the boundary in step. When one fails after adding an AWS service or a resource, read infra/README.md,
// "Least-privilege bootstrap", for how to extend the policies.

import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { describe, expect, it } from 'vitest';

import {
    CFN_EXEC_POLICY_NAME, DEPLOY_ROLE_BOUNDARY_POLICY_NAME, ROLE_BOUNDARY_POLICY_NAME, ROLE_NAME_PREFIX,
} from '../lib/permissions-boundary';
import { CONFIG_NAMES, ConfigName, INFRA_DIR, configPath, stacksOf, synthConfig, writeConfigCopy } from './helpers';

const POLICY_DIR = path.join(INFRA_DIR, 'policies');
const EXEC_POLICY_FILES = { [CFN_EXEC_POLICY_NAME]: 'cfn-exec-policy.json', 'Photo-CdkCfnExecWebOps': 'cfn-exec-web-ops-policy.json' };
const BOUNDARY_FILE = 'role-boundary.json';
const DEPLOY_BOUNDARY_FILE = 'deploy-role-boundary.json';
/** Every Photo-managed policy; the exec policies deny editing any of them. */
const PHOTO_POLICY_NAMES = [ROLE_BOUNDARY_POLICY_NAME, DEPLOY_ROLE_BOUNDARY_POLICY_NAME, ...Object.keys(EXEC_POLICY_FILES)];
/** The GitHub deploy roles: the only roles with Photo-DeployRoleBoundary instead of Photo-RoleBoundary. */
const isDeployRole = (props: Record<string, any>) => typeof props.RoleName === 'string' && /^Photo-[A-Za-z]+-GitHubDeploy$/.test(props.RoleName);
const README_HINT = 'see infra/README.md, "Least-privilege bootstrap"';

/** IAM's limit for a customer-managed policy, counted without whitespace. */
const MANAGED_POLICY_MAX_CHARS = 6144;

interface Statement {
    Sid?: string;
    Effect: 'Allow' | 'Deny';
    Action: string | string[];
    Resource: string | string[];
    Condition?: Record<string, Record<string, unknown>>;
}
interface PolicyDocument { Version: string; Statement: Statement[] }

const list = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function readPolicy(file: string, account = '111122223333', region = 'us-east-1'): PolicyDocument {
    const text = fs.readFileSync(path.join(POLICY_DIR, file), 'utf8')
        .replaceAll('${ACCOUNT_ID}', account)
        .replaceAll('${REGION}', region);
    return JSON.parse(text) as PolicyDocument;
}

/** IAM-style match: `*` is any run of characters, `?` one character; actions match case-insensitively. */
function iamMatch(pattern: string, value: string, ignoreCase = false): boolean {
    const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${re}$`, ignoreCase ? 'i' : '').test(value);
}

const allowActions = (doc: PolicyDocument) => doc.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => list(s.Action));
const execPolicies = Object.values(EXEC_POLICY_FILES).map((file) => readPolicy(file));
const execAllowActions = execPolicies.flatMap(allowActions);

type Resources = Record<string, { Type: string; Properties?: Record<string, any> }>;
interface SynthedStack {
    config: string;
    stackName: string;
    account: string;
    resources: Resources;
    stack: cdk.Stack;
    artifact: cxapi.CloudFormationStackArtifact;
}

/**
 * Every stack of every shipped config, plus variants that switch on the optional resources (custom domain:
 * certificate and DNS records; alarm email: SNS subscription; budget email; an imported OIDC provider), so the
 * coverage checks also see resources the shipped configs leave out.
 */
function synthAll(): SynthedStack[] {
    const variants: Array<{ config: string; file: string }> = [
        ...CONFIG_NAMES.map((name) => ({ config: name, file: configPath(name) })),
        ...(['beta', 'prod'] as const).map((name) => ({
            config: `${name}+domain`,
            file: writeConfigCopy(name, (config) => {
                config.Stack.Web.DomainName = `${name}.photo.example.com`;
                config.Stack.Web.HostedZoneId = 'Z0123456789ABCDEFGHIJ';
            }),
        })),
        ...(['account-beta', 'account-prod'] as ConfigName[]).map((name) => ({
            config: `${name}+email+imported-provider`,
            file: writeConfigCopy(name, (config) => {
                config.Stack.GitHubOidc.BudgetEmail = 'owner@example.com';
                config.Stack.GitHubOidc.CreateProvider = false;
                config.Stack.GitHubOidc.ExistingProviderArn = `arn:aws:iam::${config.Project.Account}:oidc-provider/token.actions.githubusercontent.com`;
            }),
        })),
    ];
    // One synth per app: the assembly gives both the templates and the deploy metadata (roles, asset manifests).
    return variants.flatMap(({ config, file }) => {
        const result = synthConfig(file);
        const assembly = result.appContext.cdkApp.synth();
        return stacksOf(result).map((stack) => {
            const artifact = assembly.getStackByName(stack.stackName);
            return { config, stackName: stack.stackName, account: stack.account, resources: artifact.template.Resources as Resources, stack, artifact };
        });
    });
}

const stacks = synthAll();
const roles = stacks.flatMap((stack) => Object.entries(stack.resources)
    .filter(([, r]) => r.Type === 'AWS::IAM::Role')
    .map(([logicalId, r]) => ({ stack, logicalId, props: r.Properties ?? {} })));

/**
 * The physical name CloudFormation generates for a resource without an explicit name: `<stack>-<logicalId>-<12 random>`,
 * cut to the 64 characters IAM allows by shortening the middle. Matches the names CloudFormation gave the Photo-Beta
 * roles in the retired single account (see the fixture below).
 */
function cfnGeneratedName(stackName: string, logicalId: string, max = 64): string {
    const suffix = '-XXXXXXXXXXXX';
    return `${stackName}-${logicalId}`.slice(0, max - suffix.length) + suffix;
}

describe('permissions boundary on every role', () => {
    it('covers the roles of every stack, including the custom resource provider roles', () => {
        const ids = roles.map((r) => r.logicalId);
        expect(ids).toEqual(expect.arrayContaining([
            'GitHubDeployRoleED73FD64',
            'ApiFunctionServiceRole52B9747B',
            'CustomCDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756CServiceRole89A01265',
            'CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092',
        ]));
    });

    it.each(roles.map((r) => [`${r.stack.config} ${r.stack.stackName}/${r.logicalId}`, r] as const))('%s has its boundary', (_, role) => {
        const name = isDeployRole(role.props) ? DEPLOY_ROLE_BOUNDARY_POLICY_NAME : ROLE_BOUNDARY_POLICY_NAME;
        expect(role.props.PermissionsBoundary).toBe(`arn:aws:iam::${role.stack.account}:policy/${name}`);
    });

    it('gives Photo-DeployRoleBoundary to exactly the two GitHub deploy roles', () => {
        const deployRoles = roles.filter((r) => JSON.stringify(r.props.PermissionsBoundary).includes(DEPLOY_ROLE_BOUNDARY_POLICY_NAME));
        expect([...new Set(deployRoles.map((r) => r.props.RoleName))].sort()).toEqual(['Photo-Beta-GitHubDeploy', 'Photo-Prod-GitHubDeploy']);
        expect(deployRoles.every((r) => r.stack.stackName.endsWith('-Cicd'))).toBe(true);
    });

    it('creates no IAM users, groups or managed policies (the exec policy cannot create them)', () => {
        const forbidden = stacks.flatMap((s) => Object.values(s.resources).map((r) => r.Type))
            .filter((type) => ['AWS::IAM::User', 'AWS::IAM::Group', 'AWS::IAM::ManagedPolicy', 'AWS::IAM::InstanceProfile'].includes(type));
        expect(forbidden).toEqual([]);
    });
});

describe('role names stay inside the exec policy\'s role/Photo-* scope', () => {
    const roleWrite = readPolicy(EXEC_POLICY_FILES[CFN_EXEC_POLICY_NAME]).Statement.find((s) => list(s.Action).includes('iam:CreateRole'))!;
    const rolePattern = list(roleWrite.Resource)[0].split(':role/')[1];

    it('the exec policy scopes role writes to Photo-* and requires the boundary on them', () => {
        expect(rolePattern).toBe(`${ROLE_NAME_PREFIX}*`);
        expect(roleWrite.Condition).toEqual({
            StringEquals: { 'iam:PermissionsBoundary': `arn:aws:iam::111122223333:policy/${ROLE_BOUNDARY_POLICY_NAME}` },
        });
    });

    it('models CloudFormation\'s generated names the way they were observed', () => {
        // Names CloudFormation generated for the same stacks in AWS_Spark (Spark-Dev-*), which this app is ported from.
        expect(cfnGeneratedName('Spark-Dev-Api', 'ApiFunctionServiceRole52B9747B'))
            .toBe('Spark-Dev-Api-ApiFunctionServiceRole52B9747B-XXXXXXXXXXXX'); // observed ...-jtkunY4cPKY1
        expect(cfnGeneratedName('Spark-Dev-Web', 'CustomCDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756CServiceRole89A01265'))
            .toBe('Spark-Dev-Web-CustomCDKBucketDeployment8693BB649689-XXXXXXXXXXXX'); // observed ...-dkbdHZ4JAVf2
        expect(cfnGeneratedName('Spark-Dev-Web', 'CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092'))
            .toBe('Spark-Dev-Web-CustomS3AutoDeleteObjectsCustomResour-XXXXXXXXXXXX'); // observed ...-mFrrt6cJLeIM
    });

    it.each(roles.map((r) => [`${r.stack.stackName}/${r.logicalId}`, r] as const))('%s gets a Photo-* name', (_, role) => {
        if (role.props.RoleName !== undefined) {
            expect(role.props.RoleName).toMatch(/^Photo-/);
            expect(iamMatch(rolePattern, role.props.RoleName)).toBe(true);
            return;
        }
        // No explicit RoleName: CloudFormation generates one that starts with the stack name. Keep stack names short
        // so the whole stack name (and with it the Photo- prefix) survives the 64-character cut.
        expect(role.stack.stackName.startsWith(ROLE_NAME_PREFIX)).toBe(true);
        expect(role.stack.stackName.length).toBeLessThanOrEqual(32);
        const generated = cfnGeneratedName(role.stack.stackName, role.logicalId);
        expect(generated.startsWith(`${role.stack.stackName}-`)).toBe(true);
        expect(iamMatch(rolePattern, generated)).toBe(true);
    });
});

describe('exec policy covers every resource type the app deploys', () => {
    /** CloudFormation service namespace -> IAM action prefix. Add a line here (and the actions) for a new service. */
    const IAM_PREFIX: Record<string, string> = {
        ApiGatewayV2: 'apigateway',
        Budgets: 'budgets',
        CertificateManager: 'acm',
        CloudFront: 'cloudfront',
        CloudWatch: 'cloudwatch',
        IAM: 'iam',
        Lambda: 'lambda',
        Logs: 'logs',
        Route53: 'route53',
        S3: 's3',
        SNS: 'sns',
        SSM: 'ssm',
    };
    const types = [...new Set(stacks.flatMap((s) => Object.values(s.resources).map((r) => r.Type)))].sort();

    it('sees the optional resource types too', () => {
        expect(types).toEqual(expect.arrayContaining([
            'AWS::CertificateManager::Certificate', 'AWS::Route53::RecordSet', 'AWS::SNS::Subscription', 'AWS::IAM::OIDCProvider',
        ]));
    });

    it.each(types.filter((t) => t.startsWith('AWS::') && t !== 'AWS::CDK::Metadata'))('%s', (type) => {
        const service = type.split('::')[1];
        const prefix = IAM_PREFIX[service];
        expect(prefix, `${type}: no IAM prefix mapped for CloudFormation service ${service}; ${README_HINT}`).toBeDefined();
        expect(execAllowActions.some((a) => a.toLowerCase().startsWith(`${prefix}:`)),
            `${type}: no ${prefix}:* action in infra/policies/cfn-exec*.json; ${README_HINT}`).toBe(true);
    });

    it.each(types.filter((t) => t.startsWith('Custom::')))('%s is backed by a Photo-* Lambda the exec role may invoke', (type) => {
        for (const stack of stacks) {
            for (const r of Object.values(stack.resources).filter((x) => x.Type === type)) {
                const target = r.Properties?.ServiceToken?.['Fn::GetAtt']?.[0];
                expect(stack.resources[target]?.Type, `${type} in ${stack.stackName} must be backed by a Lambda function`).toBe('AWS::Lambda::Function');
            }
        }
        const invoke = execPolicies.flatMap((d) => d.Statement)
            .find((s) => s.Effect === 'Allow' && list(s.Action).includes('lambda:InvokeFunction'));
        expect(list(invoke?.Resource)).toEqual(['arn:aws:lambda:us-east-1:111122223333:function:Photo-*']);
    });
});

describe('role boundary permits what the app roles do', () => {
    // AWS-managed policies the app attaches, and the actions they grant (from the policy documents).
    const MANAGED_POLICY_ACTIONS: Record<string, string[]> = {
        AWSLambdaBasicExecutionRole: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
    };
    // Actions a stack lists that are not IAM actions (none today).
    const NOT_IAM_ACTIONS: string[] = [];
    const boundaryActions = allowActions(readPolicy(BOUNDARY_FILE));
    const deployBoundaryActions = allowActions(readPolicy(DEPLOY_BOUNDARY_FILE));

    function actionsOf(stack: SynthedStack, logicalId: string, props: Record<string, any>): string[] {
        const refersToRole = (v: unknown) => JSON.stringify(v).includes(`"${logicalId}"`);
        const inline = (props.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement);
        const attached = Object.values(stack.resources)
            .filter((r) => r.Type === 'AWS::IAM::Policy' && refersToRole(r.Properties?.Roles))
            .flatMap((r) => r.Properties!.PolicyDocument.Statement);
        // Resource policies naming the role (the autoDeleteObjects bucket policy) are still capped by the boundary.
        const granted = Object.values(stack.resources)
            .filter((r) => r.Type === 'AWS::S3::BucketPolicy')
            .flatMap((r) => r.Properties!.PolicyDocument.Statement)
            .filter((s: any) => s.Effect === 'Allow' && refersToRole(s.Principal));
        const fromManaged = (props.ManagedPolicyArns ?? []).flatMap((arn: unknown) => {
            const name = /:policy\/(?:service-role\/)?([\w+=,.@-]+)/.exec(JSON.stringify(arn))?.[1] ?? JSON.stringify(arn);
            expect(MANAGED_POLICY_ACTIONS[name], `managed policy ${name}: add its actions to MANAGED_POLICY_ACTIONS`).toBeDefined();
            return MANAGED_POLICY_ACTIONS[name];
        });
        return [...inline, ...attached, ...granted]
            .filter((s: any) => s.Effect === 'Allow')
            .flatMap((s: any) => list(s.Action))
            .concat(fromManaged);
    }

    it.each(roles.map((r) => [`${r.stack.config} ${r.stack.stackName}/${r.logicalId}`, r] as const))('%s', (_, role) => {
        const actions = actionsOf(role.stack, role.logicalId, role.props).filter((a) => !NOT_IAM_ACTIONS.includes(a));
        expect(actions.length).toBeGreaterThan(0);
        const [file, allowed] = isDeployRole(role.props) ? [DEPLOY_BOUNDARY_FILE, deployBoundaryActions] : [BOUNDARY_FILE, boundaryActions];
        const uncovered = actions.filter((a) => !allowed.some((pattern) => iamMatch(pattern, a, true)));
        expect(uncovered, `not allowed by infra/policies/${file}; ${README_HINT}`).toEqual([]);
    });
});

describe('policy files', () => {
    const files = [...Object.values(EXEC_POLICY_FILES), BOUNDARY_FILE, DEPLOY_BOUNDARY_FILE];

    it.each(files)('%s parses, uses only ${ACCOUNT_ID}/${REGION} placeholders and fits a managed policy', (file) => {
        const raw = fs.readFileSync(path.join(POLICY_DIR, file), 'utf8');
        expect(raw.replaceAll('${ACCOUNT_ID}', '').replaceAll('${REGION}', '')).not.toContain('${');
        const doc = readPolicy(file, '166147842278', 'us-east-1');
        expect(doc.Version).toBe('2012-10-17');
        expect(JSON.stringify(doc).replace(/\s/g, '').length).toBeLessThanOrEqual(MANAGED_POLICY_MAX_CHARS);
        expect(new Set(doc.Statement.map((s) => s.Sid)).size).toBe(doc.Statement.length);
        for (const s of doc.Statement) {
            for (const action of list(s.Action)) expect(action, `${file} ${s.Sid}`).not.toMatch(/^\*$|^[a-z0-9-]+:\*$/);
            for (const resource of list(s.Resource)) expect(resource === '*' || resource.startsWith('arn:aws:'), `${file} ${s.Sid}`).toBe(true);
        }
    });

    it.each(Object.values(EXEC_POLICY_FILES))('%s denies removing boundaries and editing the Photo policies', (file) => {
        const doc = readPolicy(file);
        const denies = doc.Statement.filter((s) => s.Effect === 'Deny');
        expect(denies.find((s) => list(s.Action).includes('iam:DeleteRolePermissionsBoundary'))?.Resource).toBe('*');
        const edits = denies.find((s) => list(s.Action).includes('iam:CreatePolicyVersion'))!;
        expect(list(edits.Action).sort()).toEqual(['iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion']);
        expect(list(edits.Resource).sort()).toEqual(PHOTO_POLICY_NAMES.map((name) => `arn:aws:iam::111122223333:policy/${name}`).sort());
    });

    it('denies the exec role every change to the GitHub deploy roles and every OIDC provider write', () => {
        const denies = readPolicy(EXEC_POLICY_FILES[CFN_EXEC_POLICY_NAME]).Statement.filter((s) => s.Effect === 'Deny');
        const deployRole = denies.find((s) => list(s.Resource).includes('arn:aws:iam::111122223333:role/Photo-*-GitHubDeploy'))!;
        expect(list(deployRole.Action).sort()).toEqual([
            'iam:AttachRolePolicy', 'iam:CreateRole', 'iam:DeleteRole', 'iam:DeleteRolePolicy', 'iam:DetachRolePolicy',
            'iam:PutRolePermissionsBoundary', 'iam:PutRolePolicy', 'iam:UpdateAssumeRolePolicy',
        ]);
        const oidc = denies.find((s) => list(s.Resource).includes('arn:aws:iam::111122223333:oidc-provider/*'))!;
        expect(list(oidc.Action).sort()).toEqual([
            'iam:AddClientIDToOpenIDConnectProvider', 'iam:CreateOpenIDConnectProvider', 'iam:DeleteOpenIDConnectProvider',
            'iam:RemoveClientIDFromOpenIDConnectProvider', 'iam:TagOpenIDConnectProvider', 'iam:UntagOpenIDConnectProvider',
            'iam:UpdateOpenIDConnectProviderThumbprint',
        ]);
        expect(execAllowActions.filter((a) => /OpenIDConnect/i.test(a))).toEqual([]);
    });

    it('lets the exec role add Lambda permissions only for the principals the app uses', () => {
        const principals = [...new Set(stacks.flatMap((s) => Object.values(s.resources))
            .filter((r) => r.Type === 'AWS::Lambda::Permission')
            .map((r) => r.Properties!.Principal))];
        expect(principals).toEqual(['apigateway.amazonaws.com']);
        const allow = execPolicies.flatMap((d) => d.Statement)
            .filter((s) => s.Effect === 'Allow' && list(s.Action).some((a) => /^lambda:(AddPermission|RemovePermission)$/.test(a)));
        expect(allow).toHaveLength(1);
        expect(list(allow[0].Action).sort()).toEqual(['lambda:AddPermission', 'lambda:RemovePermission']);
        expect(list(allow[0].Condition?.StringEquals?.['lambda:Principal'] as string | string[]).sort()).toEqual(principals.sort());
    });

    it('only lets IAM roles be created or widened under Photo-* with the boundary, and passed only to Lambda', () => {
        const all = execPolicies.flatMap((d) => d.Statement).filter((s) => s.Effect === 'Allow');
        const escalating = ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:PutRolePermissionsBoundary', 'iam:UpdateAssumeRolePolicy'];
        for (const action of escalating) {
            const granting = all.filter((s) => list(s.Action).some((a) => iamMatch(a, action, true)));
            expect(granting, action).toHaveLength(1);
            expect(list(granting[0].Resource)).toEqual(['arn:aws:iam::111122223333:role/Photo-*']);
            expect(granting[0].Condition?.StringEquals?.['iam:PermissionsBoundary']).toBe(`arn:aws:iam::111122223333:policy/${ROLE_BOUNDARY_POLICY_NAME}`);
        }
        const passRole = all.filter((s) => list(s.Action).some((a) => iamMatch(a, 'iam:PassRole', true)));
        expect(passRole).toHaveLength(1);
        expect(passRole[0].Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } });
        // Nothing else in IAM: no users, groups, managed policies, access keys or OIDC providers.
        const iamActions = all.flatMap((s) => list(s.Action)).filter((a) => a.startsWith('iam:'));
        expect(iamActions.filter((a) => !/Role/.test(a))).toEqual([]);
    });

    it.each([BOUNDARY_FILE, DEPLOY_BOUNDARY_FILE])('%s grants no IAM or Organizations actions and no "*" resource', (file) => {
        const doc = readPolicy(file);
        expect(doc.Statement.every((s) => s.Effect === 'Allow')).toBe(true);
        expect(allowActions(doc).filter((a) => /^(iam|organizations|account):/.test(a))).toEqual([]);
        expect(doc.Statement.flatMap((s) => list(s.Resource))).not.toContain('*');
    });

    it('only the deploy-role boundary allows sts:AssumeRole, and only the CDK deploy and file-publishing roles', () => {
        expect(allowActions(readPolicy(BOUNDARY_FILE)).filter((a) => a.startsWith('sts:'))).toEqual([]);
        const doc = readPolicy(DEPLOY_BOUNDARY_FILE);
        expect(allowActions(doc).sort()).toEqual(['ssm:GetParameter', 'sts:AssumeRole']);
        const assume = doc.Statement.filter((s) => list(s.Action).includes('sts:AssumeRole'));
        expect(assume.flatMap((s) => list(s.Resource)).sort()).toEqual([
            'arn:aws:iam::111122223333:role/cdk-hnb659fds-deploy-role-111122223333-us-east-1',
            'arn:aws:iam::111122223333:role/cdk-hnb659fds-file-publishing-role-111122223333-us-east-1',
        ]);
    });
});

describe('the account and Cicd stacks deploy with the caller\'s credentials, never the exec role', () => {
    const byName = (suffix: string) => stacks.filter((s) => s.config in { 'account-beta': 1, 'account-prod': 1, beta: 1, prod: 1 }
        && s.stackName.endsWith(suffix));

    it.each([...byName('-GitHubOidc'), ...byName('-Cicd')].map((s) => [`${s.config} ${s.stackName}`, s] as const))('%s', (_, synthed) => {
        expect(synthed.stack.synthesizer).toBeInstanceOf(cdk.CliCredentialsStackSynthesizer);
        const artifact = synthed.artifact;
        expect(artifact.assumeRoleArn).toBeUndefined();
        expect(artifact.cloudFormationExecutionRoleArn).toBeUndefined();
        const assetManifests = artifact.dependencies.filter((d): d is cxapi.AssetManifestArtifact => d instanceof cxapi.AssetManifestArtifact);
        for (const manifest of assetManifests) {
            const contents = JSON.parse(fs.readFileSync(manifest.file, 'utf8'));
            expect(JSON.stringify(contents)).not.toContain('assumeRoleArn');
            expect(Object.keys(contents.dockerImages ?? {})).toEqual([]);
        }
    });

    it('every other stack still goes through the bootstrap deploy role (so CI uses the bounded path)', () => {
        const other = stacks.filter((s) => !s.stackName.endsWith('-Cicd') && !s.stackName.endsWith('-GitHubOidc'));
        expect(other.length).toBeGreaterThan(0);
        for (const s of other) expect(s.stack.synthesizer).toBeInstanceOf(cdk.DefaultStackSynthesizer);
    });

    it('no stack has Docker image assets or context lookups (CI cannot assume the image-publishing or lookup roles)', () => {
        for (const s of stacks) {
            const artifact = s.artifact;
            expect(artifact.assets.filter((a) => a.packaging === 'container-image')).toEqual([]);
            expect(artifact.assembly.manifest.missing ?? []).toEqual([]);
            for (const d of artifact.dependencies.filter((x): x is cxapi.AssetManifestArtifact => x instanceof cxapi.AssetManifestArtifact)) {
                expect(Object.keys(JSON.parse(fs.readFileSync(d.file, 'utf8')).dockerImages ?? {})).toEqual([]);
            }
        }
    });
});
