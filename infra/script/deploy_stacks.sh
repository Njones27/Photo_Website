#!/usr/bin/env bash
# Break-glass deploy of one stage from a laptop. Mirrors .github/workflows/deploy-stage.yml, which is the
# normal path. Adapted from aws-samples/aws-cdk-project-template-for-devops script/deploy_stacks.sh.
#
#   infra/script/deploy_stacks.sh config/app-config-beta.json
#
# Builds the site (dist/) at the repo root, then deploys the stage's Api, Web and Ops stacks in order.
# The Cicd stack is deployed only by setup_initial.sh. Run `npm ci` at the repo root first.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <stage-config.json>" >&2
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

APP_CONFIG="$(abspath "$1")"
export APP_CONFIG
export APP_VERSION="${APP_VERSION:-$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo local)}"
PREFIX="$(config_get "$APP_CONFIG" Project.Name)-$(config_get "$APP_CONFIG" Project.Stage)"

echo "==--------ConfigInfo---------=="
echo "Config:  $APP_CONFIG"
echo "Stacks:  $(stage_stack_patterns "$PREFIX")"
echo "Version: $APP_VERSION"
use_profile "$APP_CONFIG"
require_account "$APP_CONFIG"
echo

echo "==--------BuildFrontend---------=="
(cd "$SCRIPT_DIR/../.." && npm run build)
echo

cd "$SCRIPT_DIR/.."   # infra/
echo "==--------DeployStacks---------=="
# shellcheck disable=SC2046  # word-splitting the stack list is intended
npx cdk deploy $(stage_stack_patterns "$PREFIX") --require-approval never -c APP_CONFIG="$APP_CONFIG"
