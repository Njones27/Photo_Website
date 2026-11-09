# Shared helpers for the infra scripts. Sourced, not run.
# Config values are read with node (already required for CDK), so jq is not needed.

# Absolute path of a file, resolved against the caller's working directory.
abspath() {
  node -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$1"
}

# config_get <config.json> <dotted.key>  -> prints the value ('' when missing)
config_get() {
  node -e '
    const config = require(process.argv[1]);
    const value = process.argv[2].split(".").reduce((o, k) => (o == null ? undefined : o[k]), config);
    process.stdout.write(value == null ? "" : String(value));
  ' "$1" "$2"
}

# use_profile <config.json>: export AWS_PROFILE when the config names one (cdk and aws both honour it).
use_profile() {
  local profile
  profile="$(config_get "$1" Project.Profile)"
  if [ -n "$profile" ]; then
    export AWS_PROFILE="$profile"
    echo "Using AWS profile: $AWS_PROFILE"
  fi
}

# The stage stacks CI deploys. Cicd is left out on purpose: it holds the role CI runs as, so only
# setup_initial.sh changes it. Keep in step with .github/workflows/deploy-stage.yml.
stage_stack_patterns() {
  local prefix="$1"
  echo "$prefix-Api $prefix-Web $prefix-Ops"
}

# require_account <config.json>: stop unless the current credentials belong to the config's account.
require_account() {
  local expected actual
  expected="$(config_get "$1" Project.Account)"
  if ! actual="$(aws sts get-caller-identity --query Account --output text)"; then
    echo "No valid AWS credentials${AWS_PROFILE:+ for profile $AWS_PROFILE}. For an SSO profile run: aws sso login${AWS_PROFILE:+ --profile $AWS_PROFILE}" >&2
    exit 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "Credentials are for account $actual but $1 targets $expected. Fix the profile or the config." >&2
    exit 1
  fi
}

# render_policy <policy.json> <account> <region>: the document with ${ACCOUNT_ID} and ${REGION} filled in, minified.
render_policy() {
  node -e '
    const [file, account, region] = process.argv.slice(1);
    const text = require("fs").readFileSync(file, "utf8").replaceAll("${ACCOUNT_ID}", account).replaceAll("${REGION}", region);
    if (text.includes("${")) throw new Error(`${file} has a placeholder other than \${ACCOUNT_ID} or \${REGION}`);
    process.stdout.write(JSON.stringify(JSON.parse(text)));
  ' "$1" "$2" "$3"
}

# ensure_managed_policy <account> <region> <name> <policy.json> <description>
# Creates the customer-managed policy, or, when its default version differs from the file, adds a new default
# version. IAM keeps at most 5 versions, so the oldest non-default version is deleted first when 5 exist.
ensure_managed_policy() {
  local account="$1" region="$2" name="$3" file="$4" description="$5"
  local arn="arn:aws:iam::$account:policy/$name" document default_version current oldest
  document="$(render_policy "$file" "$account" "$region")"

  if ! default_version="$(aws iam get-policy --policy-arn "$arn" --query Policy.DefaultVersionId --output text 2>/dev/null)"; then
    aws iam create-policy --policy-name "$name" --description "$description" --policy-document "$document" >/dev/null
    echo "Created $arn from $(basename "$file")."
    return
  fi

  current="$(aws iam get-policy-version --policy-arn "$arn" --version-id "$default_version" --query PolicyVersion.Document --output json)"
  if node -e 'process.exit(JSON.stringify(JSON.parse(process.argv[1])) === JSON.stringify(JSON.parse(process.argv[2])) ? 0 : 1)' "$current" "$document"; then
    echo "$arn is up to date (version $default_version)."
    return
  fi

  if [ "$(aws iam list-policy-versions --policy-arn "$arn" --query 'length(Versions)' --output text)" -ge 5 ]; then
    oldest="$(aws iam list-policy-versions --policy-arn "$arn" \
      --query 'sort_by(Versions[?!IsDefaultVersion], &CreateDate)[0].VersionId' --output text)"
    aws iam delete-policy-version --policy-arn "$arn" --version-id "$oldest"
    echo "Deleted the oldest version ($oldest) of $arn to stay within IAM's 5 versions."
  fi
  aws iam create-policy-version --policy-arn "$arn" --policy-document "$document" --set-as-default >/dev/null
  echo "Updated $arn from $(basename "$file") (new default version; was $default_version)."
}
