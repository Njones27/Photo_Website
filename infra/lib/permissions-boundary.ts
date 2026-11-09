// Every IAM role this app creates carries the `Photo-RoleBoundary` permissions boundary. The CDK bootstrap's
// CloudFormation execution role is bootstrapped with infra/policies/cfn-exec-policy.json, which only lets it create
// `Photo-*` roles that have this boundary, so no deploy can mint a role more powerful than the boundary allows.
// Both managed policies are created by script/setup_initial.sh from infra/policies/*.json. See infra/README.md,
// "Least-privilege bootstrap".

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { IConstruct } from 'constructs';

/** Customer-managed policy used as the permissions boundary of every app role (infra/policies/role-boundary.json). */
export const ROLE_BOUNDARY_POLICY_NAME = 'Photo-RoleBoundary';
/**
 * Boundary of the GitHub deploy role only (infra/policies/deploy-role-boundary.json): assume the CDK deploy and
 * file-publishing roles, read two SSM parameters. Set on the role itself in stack/cicd-stack.ts.
 */
export const DEPLOY_ROLE_BOUNDARY_POLICY_NAME = 'Photo-DeployRoleBoundary';
/** Customer-managed policy attached to the CDK CloudFormation execution role (infra/policies/cfn-exec-policy.json). */
export const CFN_EXEC_POLICY_NAME = 'Photo-CdkCfnExec';
/** The exec policy only allows creating and changing roles whose names start with this. */
export const ROLE_NAME_PREFIX = 'Photo-';

/**
 * Adds Photo-RoleBoundary to every `AWS::IAM::Role` in every stack of the app that does not set a boundary itself
 * (only the GitHub deploy role does, with Photo-DeployRoleBoundary). The aspect matches on the CloudFormation type,
 * so it also covers roles created as plain `CfnResource`s, such as the autoDeleteObjects custom resource provider
 * role, not just `iam.Role`. It is applied per stack so the ARN uses that stack's own account.
 */
export function applyRoleBoundary(app: cdk.App): void {
    for (const stack of app.node.children.filter((child): child is cdk.Stack => cdk.Stack.isStack(child))) {
        const boundaryArn = iam.ManagedPolicy.fromManagedPolicyName(stack, 'PhotoRoleBoundary', ROLE_BOUNDARY_POLICY_NAME).managedPolicyArn;
        cdk.Aspects.of(stack).add({
            visit(node: IConstruct) {
                if (!cdk.CfnResource.isCfnResource(node) || node.cfnResourceType !== iam.CfnRole.CFN_RESOURCE_TYPE_NAME) return;
                if (node instanceof iam.CfnRole && node.permissionsBoundary !== undefined) return;
                node.addPropertyOverride('PermissionsBoundary', boundaryArn);
            },
        });
    }
}
