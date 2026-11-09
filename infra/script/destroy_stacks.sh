#!/usr/bin/env bash
# Tears down every stack of one config (all stages stacks including Cicd, or the account stack).
# Adapted from aws-samples/aws-cdk-project-template-for-devops script/destroy_stacks.sh.
#
#   infra/script/destroy_stacks.sh config/app-config-beta.json
#
# Kept on purpose, delete by hand when sure:
# - every stage's media bucket (the photos, RETAIN) and prod's site bucket (RETAIN)
# - the <Project>-<Stage>-OriginVerifySecret SSM parameter, the account's <Project>-Account-AlertEmail and its SES
#   email identity (created by setup_initial.sh, not by CDK)
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <config.json>" >&2
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

APP_CONFIG="$(abspath "$1")"
export APP_CONFIG
STAGE="$(config_get "$APP_CONFIG" Project.Stage)"
PREFIX="$(config_get "$APP_CONFIG" Project.Name)-$STAGE"
ACCOUNT="$(config_get "$APP_CONFIG" Project.Account)"
REGION="$(config_get "$APP_CONFIG" Project.Region)"
use_profile "$APP_CONFIG"
require_account "$APP_CONFIG"

cd "$SCRIPT_DIR/.."   # infra/

echo "==--------ListStacks---------=="
npx cdk list -c APP_CONFIG="$APP_CONFIG"
echo

echo "This destroys every stack above in account $ACCOUNT ($REGION)."
read -r -p "Type the stage name ($STAGE) to continue: " ANSWER
if [ "$ANSWER" != "$STAGE" ]; then
  echo "Aborted." >&2
  exit 1
fi

echo "==--------DestroyStacks---------=="
npx cdk destroy --all --force -c APP_CONFIG="$APP_CONFIG"
echo

echo "Left in place on purpose:"
if [ "$(echo "$STAGE" | tr '[:upper:]' '[:lower:]')" = "prod" ]; then
  echo "- the $PREFIX site bucket (retained): empty and delete it in the S3 console once unneeded."
fi
if [ -n "$(config_get "$APP_CONFIG" Stack.Web.Name)" ]; then
  echo "- the $PREFIX media bucket with the photos (retained): empty and delete it in the S3 console once unneeded."
fi
if [ -n "$(config_get "$APP_CONFIG" Stack.Api.Name)" ]; then
  echo "- SSM parameter $PREFIX-OriginVerifySecret:"
  echo "    aws ssm delete-parameter --name $PREFIX-OriginVerifySecret --region $REGION"
fi
