#!/usr/bin/env bash
# Uploads the generated photo files to one stage's media bucket, from the Mac that has the Lightroom exports.
# They are not in git (see .gitignore), so CI never uploads them: run this after `python3 scripts/build_site_set.py`
# whenever the photo set changes, and once for each stage after its first deploy.
#
#   infra/script/publish_photos.sh config/app-config-beta.json
#   infra/script/publish_photos.sh config/app-config-prod.json
#
# Syncs site/p, site/k and site/t to the media bucket (named in the <Project>-<Stage>-MediaBucketName SSM parameter
# that the Web stack writes), removes files that are no longer in the set, then clears CloudFront's copies of them.
# Needs the stage's AWS profile (Project.Profile) signed in; the GitHub deploy role cannot write to the bucket.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <stage-config.json>" >&2
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

APP_CONFIG="$(abspath "$1")"
SITE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/site"
PREFIX="$(config_get "$APP_CONFIG" Project.Name)-$(config_get "$APP_CONFIG" Project.Stage)"
REGION="$(config_get "$APP_CONFIG" Project.Region)"
use_profile "$APP_CONFIG"
require_account "$APP_CONFIG"

for dir in p k t; do
  if [ ! -d "$SITE_DIR/$dir" ] || [ -z "$(ls -A "$SITE_DIR/$dir")" ]; then
    echo "$SITE_DIR/$dir is missing or empty. Build the photo set first: python3 scripts/build_site_set.py" >&2
    exit 1
  fi
done

BUCKET="$(aws ssm get-parameter --name "$PREFIX-MediaBucketName" --region "$REGION" --query Parameter.Value --output text)"
DISTRIBUTION="$(aws ssm get-parameter --name "$PREFIX-DistributionId" --region "$REGION" --query Parameter.Value --output text)"

echo "==--------SyncPhotos ($PREFIX -> s3://$BUCKET)---------=="
for dir in p k t; do
  # A week in browsers and at the edge; the invalidation below covers a re-edited photo that keeps its name.
  aws s3 sync "$SITE_DIR/$dir" "s3://$BUCKET/$dir" --delete --exclude ".DS_Store" \
    --cache-control "public, max-age=604800" --region "$REGION"
done
echo

echo "==--------InvalidateCloudFront---------=="
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" --paths "/p/*" "/k/*" "/t/*" \
  --query Invalidation.Id --output text
DOMAIN="$(aws ssm get-parameter --name "$PREFIX-DistributionDomain" --region "$REGION" --query Parameter.Value --output text)"
echo "Done. Photos are live at https://$DOMAIN within a few minutes."
