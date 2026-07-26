# Infrastructure (Terraform)

AWS resources for this app, in account `703323013899`, region `eu-west-1`.

Today this covers only the database-backup bucket and its OIDC role. The site
bucket, CloudFront distribution, deploy role and SES configuration still exist
outside Terraform and are being adopted in a follow-up — see
[Adopting existing resources](#adopting-existing-resources).

## Prerequisites

- Terraform `~> 1.15` (`terraform version`).
- AWS credentials with permission to manage S3 and IAM in the account.

## Usage

```bash
cd infra
terraform init
terraform plan      # always read this before applying
terraform apply
```

`terraform plan` is safe to run any time and is the quickest way to see whether
anything has drifted.

## What is managed

| Resource | Name | Purpose |
| --- | --- | --- |
| S3 bucket | `run-app-db-backups` | Daily database dumps from `db-backup.yml`. Private, versioned, SSE. |
| IAM role | `GitHub-Actions-RunApp-backup` | Assumed via OIDC by `db-backup.yml`. |
| IAM inline policy | `GitHubAction-RunApp-Backup` | Put/Get/Delete on the bucket's objects, List on the bucket. |

Two deliberate non-decisions worth knowing before you change them:

- **The backup bucket has no object-expiry lifecycle rule.** Retention belongs
  to the workflow, which always keeps the 7 most recent backups regardless of
  age (`MIN_KEEP`). A lifecycle rule cannot express that and would empty the
  bucket after a long run of failed jobs.
- **The GitHub OIDC provider is a `data` source, not a resource.** It is
  account-wide and shared with unrelated projects, so this configuration must
  not be able to destroy it.

## State

State lives at `s3://run-app-tfstate/run-app/terraform.tfstate`, with native S3
locking (`use_lockfile = true` — no DynamoDB table).

That bucket cannot be managed by Terraform, because it must exist before
`terraform init` can run. It was created once with the AWS CLI:

```bash
aws s3api create-bucket --bucket run-app-tfstate --region eu-west-1 \
  --create-bucket-configuration LocationConstraint=eu-west-1
aws s3api put-public-access-block --bucket run-app-tfstate \
  --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
aws s3api put-bucket-versioning --bucket run-app-tfstate \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket run-app-tfstate \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
```

Versioning is on, so a corrupted state file can be rolled back to a previous
version.

State is not secret for this configuration (bucket names and role ARNs), but the
bucket is private and encrypted regardless — Terraform state generally does
capture resource attributes verbatim, so keep it that way if you add resources.

## GitHub Actions secrets

`db-backup.yml` reads three secrets. Two come straight from the outputs here:

```bash
gh secret set BACKUP_S3_BUCKET    --body "$(terraform output -raw backup_bucket)"
gh secret set AWS_BACKUP_ROLE_ARN --body "$(terraform output -raw backup_role_arn)"
```

The third, `SUPABASE_DB_URL`, is not in Terraform: it carries the database
password and comes from the Supabase dashboard (Connect → **Session pooler** →
URI). Use the pooler host, not `db.<ref>.supabase.co`, which is IPv6-only while
GitHub runners are IPv4-only.

## OIDC trust

Both roles are assumed from GitHub Actions via the account's OIDC provider. Two
things about this repository's `sub` claim are easy to get wrong:

- GitHub mints it in the **ID-suffixed format**
  `repo:theodiablo@8282971/running-coach@1261827846:...` even though the OIDC
  customization API reports `use_default: true`. A trust condition on the plain
  `repo:owner/name:*` form alone does not match. Both are allowed here.
- The backup role is restricted to the **default branch**
  (`github_allowed_subjects`). Scheduled runs always use it, and the role can
  delete objects, so a pull-request branch should not be able to assume it. If
  you need to `workflow_dispatch` from a topic branch, widen that variable
  temporarily.

If an assume-role call fails, decode the real token claims rather than guessing:
add a throwaway workflow that curls
`$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com` and prints `sub`.

## Adopting existing resources

Resources created before Terraform are adopted with `import` blocks, never by
hand-writing config and hoping it matches:

```hcl
import {
  to = aws_s3_bucket.site
  id = "run.camboulive.solutions"
}
```

```bash
terraform plan -generate-config-out=generated.tf   # writes the HCL for you
# fold generated.tf into the real files, then:
terraform plan                                     # iterate until "No changes"
```

**Do not apply until the plan is empty.** An empty plan is the proof that the
config matches what is live; applying before that point rewrites live resources
to match whatever the config happens to say. That matters most for the deploy
role and the CloudFront distribution, which are in the path of every push to
`main`.

Still to adopt: the site bucket, CloudFront distribution `E42OGU5IVYJ14`, the
`GitHub-Actions-RunApp-deploy` role and its policies, and the SES
configuration.

## Related

- `../.github/workflows/db-backup.yml` — the job these resources exist for.
- `../docs/backups.md` — what the backup contains and how to restore it.
