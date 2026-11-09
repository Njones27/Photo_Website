# Photo infrastructure (AWS CDK)

This CDK app hosts the gallery on AWS. It is ported from [AWS_Spark](https://github.com/Njones27/AWS_Spark), which
follows [aws-cdk-project-template-for-devops](https://github.com/aws-samples/aws-cdk-project-template-for-devops):
one JSON config per deploy target, an `AppContext` that loads it, and a `BaseStack` whose `putParameter` /
`getParameter` helpers pass values between stacks through SSM. The least-privilege bootstrap, the GitHub OIDC deploy
roles and the CI/CD workflows are the same as Spark's.

```
infra/
├── app-main.ts            entry point (cdk.json: npx tsx app-main.ts)
├── config/                app-config-account-{beta,prod}.json, app-config-beta.json, app-config-prod.json
├── lib/template/          AppContext, AppConfig, BaseStack, CommonHelper, CommonGuardian (MIT-0, adapted)
├── lib/create-stacks.ts   creates the stacks listed under "Stack" in the loaded config
├── policies/              least-privilege CDK exec policies and the role boundaries
├── stack/                 github-oidc, cicd, api, web, ops
├── script/                setup_initial.sh, deploy_stacks.sh, publish_photos.sh, destroy_stacks.sh (+ lib.sh)
└── test/                  vitest + aws-cdk-lib/assertions
```

## How a request flows

One CloudFront distribution per stage serves everything from one domain:

| Path | Goes to | Filled by |
|---|---|---|
| `/` and everything else | site bucket (`gallery.html` is the root object) | CI, from `dist/` (`npm run build`) |
| `/p/*`, `/k/*`, `/t/*` | media bucket (the generated photos) | `script/publish_photos.sh`, from the Mac |
| `/api/*` | HTTP API and the booking Lambda | CI |

The booking form posts JSON to `POST /api/booking`. The Lambda checks it and sends it with Amazon SES from and to the
AWS account's own email, with the visitor as Reply-To, so answering is just pressing Reply. A hidden `website` field
catches bots: a request that fills it is answered "sent" and dropped. `GET /api/health` is the deploy smoke test.

## Stacks

Stack names are `Photo-<Stage>-<Stack>`, for example `Photo-Beta-Web`. Each stage lives in its own AWS account.

| Config | Stack | What it holds | Deployed by |
|---|---|---|---|
| account-beta / account-prod | `Photo-Account-GitHubOidc` | GitHub Actions OIDC provider, monthly budgets ($10, $25) | `setup_initial.sh`, once per account |
| beta / prod | `Photo-<Stage>-Cicd` | IAM role `Photo-<Stage>-GitHubDeploy` that the deploy workflow assumes | `setup_initial.sh` only, never CI |
| beta / prod | `Photo-<Stage>-Api` | HTTP API (`/api/health`, `/api/booking`, throttled), the Node 24 arm64 Lambda, metric filters | CI |
| beta / prod | `Photo-<Stage>-Web` | site bucket, media bucket (kept on delete), CloudFront with security headers and CSP, site upload | CI |
| beta / prod | `Photo-<Stage>-Ops` | SNS topic emailing the account address, 6 alarms, a dashboard | CI |

| AWS account | Account ID | Profile (`Project.Profile`) | GitHub environment |
|---|---|---|---|
| Photo-BETA | `411626138124` | `photo-beta` | `beta` |
| Photo-PROD | `209662578564` | `photo-prod` | `prod` |

The deploy order is Api → Web → Ops. The stacks share values through SSM parameters named `Photo-<Stage>-<Key>`:

| SSM parameter | Written by | Read by |
|---|---|---|
| `ApiId`, `ApiDomain`, `FunctionName` | Api | Web (`ApiDomain`), Ops |
| `WebBucketName`, `MediaBucketName`, `DistributionId`, `DistributionDomain` | Web | Ops, `publish_photos.sh`, the smoke test |
| `OriginVerifySecret` | `setup_initial.sh` | Api (Lambda env), Web (CloudFront origin header) |
| `Photo-Account-AlertEmail` (one per account) | `setup_initial.sh` | Api (where bookings go), Ops (alarm emails) |
| `DeployRoleArn` | Cicd | `setup_initial.sh` (prints it) |

## Everyday commands

```bash
npm ci                              # at the repo root (npm workspaces install backend/ and infra/)
npm run typecheck:all
npm run test:all
npm run build                       # site/ -> dist/ (cdk synth uploads it in the Web stack)
cd infra
npx cdk synth --quiet -c APP_CONFIG=config/app-config-beta.json
npx cdk diff -c APP_CONFIG=config/app-config-prod.json
```

## One-time setup, per account

You need the AWS CLI v2, Node 24, `openssl`, and admin credentials for the account through the profile in the config.

```bash
npm ci
cd infra
aws sso login --profile photo-beta
script/setup_initial.sh config/app-config-account-beta.json config/app-config-beta.json

aws sso login --profile photo-prod
script/setup_initial.sh config/app-config-account-prod.json config/app-config-prod.json
```

The script is safe to re-run. It:

1. checks the credentials belong to the config's account
2. builds `dist/`, creates the four `Photo-*` managed policies from `policies/`, and runs `cdk bootstrap` with those
   exec policies instead of `AdministratorAccess`
3. finds the account's email (`ALERT_EMAIL` from the environment, then AWS Organizations, then the alternate contacts,
   then the organization's management email) and stores it in `Photo-Account-AlertEmail`
4. creates an SES email identity for that address. **AWS emails a confirmation link: click it**, or booking emails
   fail. SES starts in sandbox mode, which is fine here because it only ever sends to that same verified address
5. deploys `Photo-Account-GitHubOidc`, creates `Photo-<Stage>-OriginVerifySecret`, deploys `Photo-<Stage>-Cicd`, and
   prints the GitHub environment variables

To send bookings somewhere else, run it with `ALERT_EMAIL=you@example.com`.

### GitHub environments

In **Settings → Environments**, create `beta` and `prod`, each with these variables (printed by the script):
`AWS_DEPLOY_ROLE_ARN`, `AWS_REGION` (`us-east-1`), `AWS_ACCOUNT_ID`, `APP_CONFIG` (`config/app-config-beta.json` or
`config/app-config-prod.json`). On `prod`, limit deployment branches to `main` and add yourself as a required reviewer:
the prod role trusts any job that names the `prod` environment, and only that setting keeps other branches out.

The deploy roles trust the subject `repo:Njones27@153565100/Photo_Website@1448968508:environment:<stage>` (GitHub's
immutable format). If the role cannot be assumed, check the prefix with
`gh api repos/Njones27/Photo_Website/actions/oidc/customization/sub` and update `Cicd.GitHubSubjectPrefix`.

### Photos

The photo files are built on the Mac from the Lightroom folder and are not in git, so CI never uploads them. After the
first deploy of each stage, and whenever the photo set changes:

```bash
python3 scripts/build_site_set.py
infra/script/publish_photos.sh infra/config/app-config-beta.json
infra/script/publish_photos.sh infra/config/app-config-prod.json
```

It syncs `site/p`, `site/k` and `site/t` to the stage's media bucket (deleting photos that left the set) and clears
CloudFront's copies. Merge the matching `portfolio.js` change too, so the page and the photos agree.

## How deploys flow

```
push to a PR ──> ci.yml ──> verify: typecheck, test, build, cdk synth (all 4 configs, no AWS credentials)
                          ──> deploy-beta: deploy the PR to beta, smoke test   (branches of this repo only)
merge to main ──> deploy.yml ──> beta: deploy, smoke test ──> prod: waits for approval, deploy, smoke test
```

- PRs only ever reach beta. Prod is reachable only from `main`, after you approve the `prod` environment.
- Fork PRs and Dependabot run `verify` only and never get AWS credentials.
- The smoke test needs `GET /api/health` to report `"ok":true` and `HEAD /` to return 200.
- Cicd is never deployed by CI. It holds the role CI runs as, so only `setup_initial.sh` changes it.
- Break-glass deploy from a laptop: `script/deploy_stacks.sh config/app-config-beta.json`.

## Least-privilege bootstrap

Same design as Spark. The CloudFormation execution role runs with `Photo-CdkCfnExec` and `Photo-CdkCfnExecWebOps`
(`policies/cfn-exec*.json`), every app role carries the `Photo-RoleBoundary` permissions boundary, and the GitHub
deploy roles carry the narrower `Photo-DeployRoleBoundary`. `test/least-privilege.test.ts` checks that every resource
type the app deploys is covered by the exec policies, every role action is inside its boundary, and the account and
Cicd stacks deploy with the caller's own credentials. If a change adds an AWS service or permission, that test fails:
add the actions to the policy files, run `npm test -w infra`, then re-run `setup_initial.sh` for both accounts
**before** merging, or the next CI deploy fails with `AccessDenied`.

## Confirmation emails to visitors

After a booking reaches the account's address, the Lambda sends the visitor a short confirmation (session and date
only, never their own text) with Reply-To set to that address. If it fails, the request still succeeds and the log
gets a `Confirmation not sent` warning. Two things make it work and keep it out of junk folders, both once per account:

1. **SES production access.** In sandbox mode SES only sends to verified addresses, so confirmations fail. Request it
   (AWS reviews it, usually within a day):

   ```bash
   aws sesv2 put-account-details --profile photo-prod --production-access-enabled --mail-type TRANSACTIONAL \
     --website-url https://nathanjonesphoto.co --contact-language EN \
     --use-case-description "Booking form on my photography site. Each request emails me once and sends one confirmation to the person who filled it in. No marketing or lists."
   ```

2. **DKIM for the domain.** Mail sent from `@nathanjonesphoto.co` through SES lands in junk unless the domain signs
   it. Create the domain identity and add the three CNAME records it prints at the domain's DNS host, as
   `<token>._domainkey.nathanjonesphoto.co` pointing to `<token>.dkim.amazonses.com`:

   ```bash
   aws sesv2 create-email-identity --profile photo-prod --email-identity nathanjonesphoto.co \
     --query 'DkimAttributes.Tokens'
   ```

Beta can stay in the sandbox: its confirmations only reach verified addresses, which is enough for testing.

## Adding the domain

1. Create a public Route 53 hosted zone for `nathanjonesphoto.co` in the prod account and point the registrar's
   nameservers at it.
2. Set `Web.DomainName` and `Web.HostedZoneId` in `config/app-config-prod.json` and merge. The Web stack adds a
   DNS-validated certificate, the alias on the distribution, and A/AAAA records.

## Tearing down

`script/destroy_stacks.sh config/app-config-beta.json` asks you to type the stage name. Every media bucket and prod's
site bucket are kept, along with the SSM parameters and the SES identity; the script prints how to remove them.

## Troubleshooting

- **The form says the request didn't go through, and `ApiLoggedErrors` fires**: usually the SES identity is not
  verified yet. Click the link AWS emailed, or re-run `setup_initial.sh` to see the status.
- **`Unable to fetch parameters [Photo-Beta-OriginVerifySecret]`** (or `Photo-Account-AlertEmail`): run
  `setup_initial.sh` for that account first.
- **`Could not assume role with OIDC`**: the subject prefix does not match; see GitHub environments above.
- **CI: `Variable X is not set on the 'beta' environment`**: add it under **Settings → Environments**.
- **A booking arrived but the visitor got no confirmation**: look for `Confirmation not sent` in the function's log.
  `MessageRejected ... not verified` means SES is still in sandbox mode (see Confirmation emails above).
- **No booking email and no error**: every outcome is logged (`Booking rejected` with the field, `Booking dropped by
  the spam trap`, `Booking sent`). The log group is `aws lambda get-function-configuration --function-name <name>
  --query LoggingConfig.LogGroup`.
- **Photos missing on a fresh stage**: run `publish_photos.sh` for it.
