#!/usr/bin/env bash
# One-time setup of one AWS account, run by hand from a shell with admin credentials for that account.
# Photo uses one account per stage (Photo-BETA and Photo-PROD), so run it once per account:
#
#   infra/script/setup_initial.sh config/app-config-account-beta.json config/app-config-beta.json
#   infra/script/setup_initial.sh config/app-config-account-prod.json config/app-config-prod.json
#
# Adapted from aws-samples/aws-cdk-project-template-for-devops script/setup_initial.sh. It:
# 1. checks the account's Lambda concurrency quota against what the stage config reserves (warns, never stops)
# 2. builds the site into dist/ (every cdk command synthesizes the Web stack, which uploads dist/)
# 3. creates or updates the managed policies in infra/policies/ (Photo-RoleBoundary, Photo-DeployRoleBoundary,
#    Photo-CdkCfnExec, Photo-CdkCfnExecWebOps), then runs `cdk bootstrap aws://<account>/<region>` with the two exec
#    policies as the CloudFormation execution policies, instead of the default AdministratorAccess
# 4. stores the account's alert email in the <Project>-Account-AlertEmail SSM parameter (see "AlertEmail" below),
#    which the stage's Ops stack emails alarms to and the booking form emails requests to, creates the SES email
#    identity for it (AWS emails a confirmation link), then deploys the account config (GitHub OIDC provider, budgets)
# 5. creates the <Project>-<Stage>-OriginVerifySecret SSM parameter (once, never replaced), deploys
#    <Project>-<Stage>-Cicd, and prints the GitHub environment variables to set
#
# The alert email is looked up, in order: ALERT_EMAIL from the environment, the account's own email in AWS
# Organizations (works from the management account), the account's operations, security or billing alternate
# contact, then the organization's management account email (readable from any member account). If none is found it
# asks (or stops, without a terminal). It is kept in SSM, never in this public repo.
# The account and Cicd stacks use CliCredentialsStackSynthesizer: they deploy with the credentials this script runs
# with, never through the CDK exec role (which is denied changes to the deploy role and the OIDC provider).
#
# Dependencies are not installed here: run `npm ci` at the repo root first. Safe to re-run; re-running it on an
# account that was bootstrapped with AdministratorAccess switches that account to the least-privilege policies.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <account-config.json> <stage-config.json>   (once per AWS account)" >&2
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

ACCOUNT_CONFIG="$(abspath "$1")"
STAGE_CONFIG="$(abspath "$2")"
POLICY_DIR="$SCRIPT_DIR/../policies"

cd "$SCRIPT_DIR/.."   # infra/, where cdk.json lives

# SETUP_YES=1 skips CDK's interactive IAM review (for automation or a non-TTY shell); the default keeps the prompt.
APPROVAL=(--require-approval broadening)
if [ "${SETUP_YES:-}" = "1" ]; then APPROVAL=(--require-approval never); fi

echo "==--------CheckDependencies---------=="
aws --version
node --version
npx cdk --version
openssl version
echo

ACCOUNT="$(config_get "$ACCOUNT_CONFIG" Project.Account)"
REGION="$(config_get "$ACCOUNT_CONFIG" Project.Region)"
use_profile "$ACCOUNT_CONFIG"

require_account "$ACCOUNT_CONFIG"

if [ "$(config_get "$STAGE_CONFIG" Project.Account)" != "$ACCOUNT" ] || [ "$(config_get "$STAGE_CONFIG" Project.Region)" != "$REGION" ]; then
  echo "$STAGE_CONFIG targets a different account or region than $ACCOUNT_CONFIG. Pass the account config and the" >&2
  echo "stage config of the same AWS account (account-beta + beta, or account-prod + prod)." >&2
  exit 1
fi

echo "==--------LambdaConcurrencyQuota---------=="
# Lambda refuses a reserved concurrency that would leave less than 100 unreserved in the account.
QUOTA="$(aws lambda get-account-settings --region "$REGION" --query AccountLimit.ConcurrentExecutions --output text)"
echo "ConcurrentExecutions quota in $REGION: $QUOTA"
RESERVED="$(config_get "$STAGE_CONFIG" Stack.Api.ReservedConcurrency)"
RESERVED="${RESERVED:-0}"
NEEDED=$((RESERVED + 100))
STAGE_NAME="$(config_get "$STAGE_CONFIG" Project.Name)-$(config_get "$STAGE_CONFIG" Project.Stage)"
if [ "$RESERVED" -eq 0 ]; then
  echo "OK: $STAGE_NAME reserves no concurrency, so any quota works."
  if [ "$QUOTA" -lt 1000 ]; then
    echo "Note: the quota is below the default 1000. Request it before setting Api.ReservedConcurrency:"
    echo "  aws service-quotas request-service-quota-increase --region $REGION --service-code lambda --quota-code L-B99A9384 --desired-value 1000"
  fi
elif [ "$QUOTA" -lt "$NEEDED" ]; then
  cat <<WARN
WARNING: $STAGE_NAME reserves $RESERVED (Api.ReservedConcurrency in $STAGE_CONFIG), which needs a quota of at
least $NEEDED (the reservation plus the 100 Lambda keeps unreserved). The quota is $QUOTA, so the Api stack will fail
to deploy until it is raised. Request it, or set Api.ReservedConcurrency to 0 meanwhile:
  aws service-quotas request-service-quota-increase --region $REGION \\
    --service-code lambda --quota-code L-B99A9384 --desired-value 1000
Continuing.
WARN
else
  echo "OK: covers the stage reservation ($RESERVED) plus 100 unreserved."
fi
echo

echo "==--------BuildSite---------=="
(cd .. && npm run build)
echo

echo "==--------LeastPrivilegePolicies---------=="
# The boundaries first: the exec policies only allow creating roles that carry Photo-RoleBoundary, and the Cicd
# stack's deploy role carries Photo-DeployRoleBoundary.
ensure_managed_policy "$ACCOUNT" "$REGION" Photo-RoleBoundary "$POLICY_DIR/role-boundary.json" \
  "Permissions boundary of every Photo app IAM role (infra/policies/role-boundary.json)"
ensure_managed_policy "$ACCOUNT" "$REGION" Photo-DeployRoleBoundary "$POLICY_DIR/deploy-role-boundary.json" \
  "Permissions boundary of the Photo GitHub deploy roles (infra/policies/deploy-role-boundary.json)"
ensure_managed_policy "$ACCOUNT" "$REGION" Photo-CdkCfnExec "$POLICY_DIR/cfn-exec-policy.json" \
  "CDK CloudFormation execution role, IAM and API services (infra/policies/cfn-exec-policy.json)"
ensure_managed_policy "$ACCOUNT" "$REGION" Photo-CdkCfnExecWebOps "$POLICY_DIR/cfn-exec-web-ops-policy.json" \
  "CDK CloudFormation execution role, data, web and ops services (infra/policies/cfn-exec-web-ops-policy.json)"
echo

echo "==--------BootstrapCDKEnvironment---------=="
# Replaces bootstrap's default AdministratorAccess on cdk-hnb659fds-cfn-exec-role-* with the two exec policies.
EXEC_POLICIES="arn:aws:iam::$ACCOUNT:policy/Photo-CdkCfnExec,arn:aws:iam::$ACCOUNT:policy/Photo-CdkCfnExecWebOps"
APP_CONFIG="$ACCOUNT_CONFIG" npx cdk bootstrap "aws://$ACCOUNT/$REGION" \
  --cloudformation-execution-policies "$EXEC_POLICIES" -c APP_CONFIG="$ACCOUNT_CONFIG"
echo

echo "==--------AlertEmail---------=="
# The Ops stack's alarms email this address. One per account, read at deploy time.
ALERT_PARAM="$(config_get "$ACCOUNT_CONFIG" Project.Name)-Account-AlertEmail"
looks_like_email() { [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; }
lookup_alert_email() {
  local found
  found="$(aws organizations describe-account --account-id "$ACCOUNT" --query Account.Email --output text 2>/dev/null || true)"
  if looks_like_email "$found"; then echo "$found"; return; fi
  for kind in OPERATIONS SECURITY BILLING; do
    found="$(aws account get-alternate-contact --alternate-contact-type "$kind" \
      --query AlternateContact.EmailAddress --output text 2>/dev/null || true)"
    if looks_like_email "$found"; then echo "$found"; return; fi
  done
  # A member account can't read its own email, but any account in an organization can read the owner's: the
  # management account's email.
  found="$(aws organizations describe-organization --query Organization.MasterAccountEmail --output text 2>/dev/null || true)"
  if looks_like_email "$found"; then echo "$found"; return; fi
}
CURRENT_EMAIL="$(aws ssm get-parameter --name "$ALERT_PARAM" --region "$REGION" --query Parameter.Value --output text 2>/dev/null || true)"
if [ -n "${ALERT_EMAIL:-}" ]; then
  WANT_EMAIL="$ALERT_EMAIL"
elif looks_like_email "$CURRENT_EMAIL"; then
  WANT_EMAIL="$CURRENT_EMAIL"
else
  WANT_EMAIL="$(lookup_alert_email)"
  if [ -z "$WANT_EMAIL" ] && [ -t 0 ]; then
    echo "No email found for account $ACCOUNT in AWS Organizations or its alternate contacts."
    read -r -p "Email for booking requests and alarms: " WANT_EMAIL
  fi
fi
if ! looks_like_email "$WANT_EMAIL"; then
  echo "No alert email for account $ACCOUNT. Re-run with ALERT_EMAIL=you@example.com $0 $*" >&2
  exit 1
fi
if [ "$WANT_EMAIL" = "$CURRENT_EMAIL" ]; then
  echo "SSM parameter $ALERT_PARAM already set, keeping it."
else
  aws ssm put-parameter --name "$ALERT_PARAM" --type String --overwrite --region "$REGION" \
    --description "Where booking requests and alarms for this account are emailed" \
    --value "$WANT_EMAIL" >/dev/null
  echo "Set SSM parameter $ALERT_PARAM. AWS will email that address a link to confirm the alarm subscription."
fi
echo

echo "==--------SesIdentity---------=="
# The booking Lambda sends from and to this address. SES only sends from a verified identity, and in the SES sandbox
# only to verified ones, which this same address is. Creating the identity makes AWS email a confirmation link.
SES_STATUS="$(aws sesv2 get-email-identity --email-identity "$WANT_EMAIL" --region "$REGION" \
  --query VerifiedForSendingStatus --output text 2>/dev/null || echo missing)"
if [ "$SES_STATUS" = "missing" ]; then
  aws sesv2 create-email-identity --email-identity "$WANT_EMAIL" --region "$REGION" >/dev/null
  echo "Created the SES identity $WANT_EMAIL. Click the link AWS just emailed there, or booking emails will fail."
elif [ "$SES_STATUS" = "True" ]; then
  echo "SES identity $WANT_EMAIL is verified."
else
  echo "SES identity $WANT_EMAIL exists but is not verified yet: click the link AWS emailed there."
  echo "To resend it: aws sesv2 delete-email-identity --email-identity $WANT_EMAIL --region $REGION, then re-run this script."
fi
echo

echo "==--------DeployAccountStacks---------=="
# With this shell's credentials (CliCredentialsStackSynthesizer), not the exec role.
npx cdk deploy --all "${APPROVAL[@]}" -c APP_CONFIG="$ACCOUNT_CONFIG"
echo

GITHUB_SETUP=""
PREFIX="$(config_get "$STAGE_CONFIG" Project.Name)-$(config_get "$STAGE_CONFIG" Project.Stage)"
SECRET_NAME="$PREFIX-OriginVerifySecret"
GITHUB_ENV_NAME="$(config_get "$STAGE_CONFIG" Stack.Cicd.GitHubEnvironment)"
GITHUB_REPO="$(config_get "$STAGE_CONFIG" Stack.Cicd.GitHubRepo)"
APP_CONFIG_REL="$(node -e 'process.stdout.write(require("path").relative(process.cwd(), process.argv[1]))' "$STAGE_CONFIG")"

echo "==--------Stage $PREFIX---------=="
if aws ssm get-parameter --name "$SECRET_NAME" --region "$REGION" --query Parameter.Name --output text >/dev/null 2>&1; then
  echo "SSM parameter $SECRET_NAME already exists, keeping it."
else
  # Plain String on purpose: the value also sits in the CloudFront and Lambda configs, so SecureString adds nothing.
  aws ssm put-parameter --name "$SECRET_NAME" --type String --region "$REGION" \
    --description "CloudFront -> API origin verify header for $PREFIX" \
    --value "$(openssl rand -hex 32)" >/dev/null
  echo "Created SSM parameter $SECRET_NAME."
fi


# With this shell's credentials (CliCredentialsStackSynthesizer): CI and the exec role cannot change this role.
npx cdk deploy "$PREFIX-Cicd" "${APPROVAL[@]}" -c APP_CONFIG="$STAGE_CONFIG"

ROLE_ARN="$(aws ssm get-parameter --name "$PREFIX-DeployRoleArn" --region "$REGION" --query Parameter.Value --output text)"
GITHUB_SETUP+="
GitHub environment '$GITHUB_ENV_NAME' (repo $GITHUB_REPO -> Settings -> Environments), variables:
  AWS_DEPLOY_ROLE_ARN = $ROLE_ARN
  AWS_REGION          = $REGION
  AWS_ACCOUNT_ID      = $ACCOUNT
  APP_CONFIG          = $APP_CONFIG_REL
or with the GitHub CLI:
  gh variable set AWS_DEPLOY_ROLE_ARN --repo $GITHUB_REPO --env $GITHUB_ENV_NAME --body '$ROLE_ARN'
  gh variable set AWS_REGION          --repo $GITHUB_REPO --env $GITHUB_ENV_NAME --body '$REGION'
  gh variable set AWS_ACCOUNT_ID      --repo $GITHUB_REPO --env $GITHUB_ENV_NAME --body '$ACCOUNT'
  gh variable set APP_CONFIG          --repo $GITHUB_REPO --env $GITHUB_ENV_NAME --body '$APP_CONFIG_REL'
"
echo

echo "==--------GitHubEnvironments---------=="
echo "$GITHUB_SETUP"
