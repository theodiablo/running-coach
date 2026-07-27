# Infrastructure (Terraform)

AWS resources for this app, in account `703323013899`, region `eu-west-1`.

This covers the database-backup bucket and its OIDC role, the two Terraform CI
roles, and the pre-existing site (S3 + CloudFront), deploy role, and inbound
SES configuration — adopted via `import` blocks; see
[Adopting existing resources](#adopting-existing-resources).

## Prerequisites

- Terraform `~> 1.15` (`terraform version`).
- AWS credentials with permission to manage S3 and IAM in the account.

## How it gets deployed

CI, via `.github/workflows/terraform.yml`:

- **Pull requests** touching `infra/` get a `terraform plan` posted as a comment
  (replaced in place on each push, not appended). Read-only: the plan role
  cannot write to AWS at all.
- **Merges to `main`** run `terraform apply`. Merging is what changes AWS.

So the normal workflow is to open a PR and read the plan comment. Nothing is
applied until it merges.

### Running it locally

Still supported, and needed for anything CI cannot do (bootstrapping, imports,
inspecting state):

```bash
cd infra
terraform init
terraform plan      # always read this before applying
terraform apply
```

Local applies use your own AWS credentials, which are broader than the CI role.
Prefer letting CI apply, so that what ran is recorded against a merge commit.

### Destructive plans are blocked

Apply refuses any plan that destroys or replaces a resource. To go through with
one, dispatch the workflow manually with `allow_destroy: true`.

Everything here is either irreplaceable (the backup bucket) or in the path of a
live deploy (the roles), so an unattended destroy-on-merge is not a failure mode
worth having. The backup bucket additionally carries `prevent_destroy`, which
stops such a plan from being generated in the first place — deleting it means
removing that line in its own reviewed commit.

Note that "replace" counts as destructive. Renaming a resource, or changing an
attribute that forces replacement, will trip this guard. That is intended: on a
bucket, replacement means the data goes away.

### The CI roles, and what they can do

| Role | Secret | Trust | Can |
| --- | --- | --- | --- |
| `GitHub-Actions-RunApp-tf-plan` | `AWS_TF_PLAN_ROLE_ARN` | pull requests + `main` | read only |
| `GitHub-Actions-RunApp-tf-apply` | `AWS_TF_APPLY_ROLE_ARN` | `main` only | read/write, scoped |

Neither role can read the *contents* of any S3 object except the state file:
the read policy grants bucket-level actions against bucket ARNs, never
`bucket/*`. A CI role cannot download a backup tarball.

The apply role's S3 writes are confined to buckets named `run-app-*`, plus the
two adopted buckets that predate that naming convention
(`run.camboulive.solutions` and `ses-inbound-camboulive-solutions`), and its
IAM writes to roles named `GitHub-Actions-RunApp-*`. Three explicit Denys
apply on top: it cannot
modify either CI role (including itself), cannot attach `AdministratorAccess`,
`IAMFullAccess` or `PowerUserAccess` to anything, and cannot delete the state
bucket or either adopted bucket. Deleting one of those means a local apply —
deliberately, since bucket-level *configuration* on them is routine and
deletion never is.

CloudFront and SES writes (`ManageCloudFront`, `ManageSes` in
`terraform_roles.tf`) are mostly **not** resource-scoped: creates have no ARN
to name yet, origin access controls have no IAM resource type at all, and SES's
mutating actions don't take one either, so those statements grant on `*`.
Distributions are the exception and are treated as one: `UpdateDistribution`
and `DeleteDistribution` — the two that can break or delete a live site — are
pinned to this project's distribution (`ManageSiteDistribution`). Adding a
second distribution therefore means widening that statement first, from a
workstation, because of `DenySelfModification`.

**Be honest about the residual risk.** A role that can create IAM roles and
attach policies is close to an administrative credential, and those Denys close
the obvious escalation paths rather than proving containment. It could still
mint a new `GitHub-Actions-RunApp-*` role with a broad inline policy. The
CloudFront/SES widening adds a second, different kind of risk: for everything
that can't be pinned to an ARN, a bug in a future `infra/` change could touch
**any** SES identity or origin access control in the account, not just this
project's — there is no IAM-level backstop for that, only code review of what
merges. Accepting both risks is the price of applying from CI; the alternative
is plan-only in CI with apply staying manual. If the account ever holds
anything materially more sensitive than it does today, revisit this with a
permissions boundary or a dedicated account per project.

### Proving the policies

`infra/permissions-check.sh` asserts what each role can and cannot do via
`iam:SimulatePrincipalPolicy` — positive cases (the apply role can configure the
site bucket, update this distribution, manage the receipt rule) and the negative
ones that are security properties (no CI role can read a backup tarball; the
apply role cannot rewrite its own policy, delete a protected bucket, or touch
another distribution).

Simulation evaluates the policy that is **deployed**, not the one in the diff,
so `.github/workflows/terraform-permissions.yml` cannot usefully run on a pull
request — on a PR branch it would re-assert the live policy and pass regardless
of the change. It runs on `workflow_run` after the Terraform workflow completes
on `main` (the first moment the new policy exists), on a weekly cron to catch
drift from a local apply, and on demand. When you widen or narrow a policy,
extend the script in the same commit — a grant with no assertion is a grant
nobody is checking.

### Bootstrapping

Both CI roles are declared in `terraform_roles.tf` but had to exist before CI
could assume them, so they were applied once from a workstation. Same
chicken-and-egg as the state bucket, one level up. Nothing special is needed to
maintain them now.

## What is managed

| Resource | Name | Purpose |
| --- | --- | --- |
| S3 bucket | `run-app-db-backups` | Daily database dumps from `db-backup.yml`. Private, versioned, SSE. |
| IAM role | `GitHub-Actions-RunApp-backup` | Assumed via OIDC by `db-backup.yml`. |
| IAM inline policy | `GitHubAction-RunApp-Backup` | Put/Get/Delete on the bucket's objects, List on the bucket. |
| IAM role | `GitHub-Actions-RunApp-tf-plan` | Read-only role for `terraform plan` in CI. |
| IAM role | `GitHub-Actions-RunApp-tf-apply` | Scoped read/write role for `terraform apply` on `main`. |
| S3 bucket | `run.camboulive.solutions` | CloudFront origin for the built SPA. Private (OAC), world-readable only through CloudFront. Adopted. |
| CloudFront distribution | `E42OGU5IVYJ14` | Serves `run.camboulive.solutions`. Adopted. |
| IAM role | `GitHub-Actions-RunApp-deploy` | Assumed by the deploy workflow to push the build and invalidate CloudFront. Adopted. |
| SES domain identity | `camboulive.solutions` | Verified sending/receiving identity, DKIM enabled. Adopted. |
| SES receipt rule set | `camboulive-solutions-inbound` | Active; the one rule (`forward-all`) writes inbound mail to S3 and invokes the forwarder Lambda. Adopted. |
| S3 bucket | `ses-inbound-camboulive-solutions` | Inbound mail landing zone, 30-day expiry on `inbound/`. Adopted. |

Three deliberate non-decisions worth knowing before you change them:

- **The backup bucket has no object-expiry lifecycle rule.** Retention belongs
  to the workflow, which always keeps the 7 most recent backups regardless of
  age (`MIN_KEEP`). A lifecycle rule cannot express that and would empty the
  bucket after a long run of failed jobs.
- **The GitHub OIDC provider is a `data` source, not a resource.** It is
  account-wide and shared with unrelated projects, so this configuration must
  not be able to destroy it.
- **The distribution's response headers policy belongs to `deploy.yml`, not to
  Terraform.** That workflow creates/updates the custom
  `run-app-security-headers` policy (clickjacking protection, which a `<meta>`
  CSP cannot set) and attaches it on every push to `main`. Two writers on one
  field is the failure mode to avoid, so
  `default_cache_behavior[0].response_headers_policy_id` is under
  `ignore_changes` here and the ID in `site.tf` is only a from-scratch initial
  value — it is **not** the AWS-managed `SecurityHeadersPolicy`. Adopting the
  policy as an `aws_cloudfront_response_headers_policy` and dropping the
  workflow step would be a real improvement; it needs the deploy role's
  `CloudFrontFullAccess` narrowed in the same change, not before it.

Also deliberately unmanaged, referenced only by ARN/value where a resource
needs to point at them: the ACM certificate backing the CloudFront
distribution (DNS-validated certs need their validation records adopted too,
and nothing here needs to reissue or rotate it), the
`ses-forwarder-camboulive-solutions` Lambda and its role (not part of this
adoption's scope), and the Route 53 records for `camboulive.solutions` (MX,
DKIM, SPF, mail-from).

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

The third, `SUPABASE_DB_URL`, is deliberately **not** in Terraform. It carries
the database password, and Terraform state records resource attributes
verbatim, so putting it here would write the credential in plaintext into the
state bucket. It is strictly worse than a GitHub secret, which is encrypted at
rest and never printed. The Supabase provider could not supply it anyway: its
`supabase_pooler` data source returns the connection string with a
`[YOUR-PASSWORD]` placeholder, and no resource or data source can read or
rotate the password.

Build it by hand instead, connecting as the read-only `db_backup` role (created
by `supabase/migrations/20260726120000_db_backup_role.sql`, not as `postgres`).
The host and port come from the Supabase dashboard, Connect → **Session
pooler**; use the pooler host, not `db.<ref>.supabase.co`, which is IPv6-only
while GitHub runners are IPv4-only. Full procedure in `../docs/backups.md`.

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
- The deploy role is restricted to `pull_request` and the default branch
  (`github_deploy_subjects`) — production deploys and PR previews, which is all
  that assumes it. It can overwrite the live site, so trusting every ref put
  the whole gate in `deploy-pr.yml`'s `author_association` check, i.e. in YAML
  rather than in IAM. Same "widen temporarily" escape hatch as the backup role.

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

The site bucket (`site.tf`), CloudFront distribution, the
`GitHub-Actions-RunApp-deploy` role and its policies (`deploy_role.tf`), and
the SES domain identity/receipt rule/inbound bucket (`ses.tf`) were adopted
this way. Two things worth knowing if you touch them again:

- Adopting them required temporarily granting the local workstation IAM user
  a handful of read-only SES actions (`ses:DescribeReceiptRule`,
  `ses:ListTagsForResource`) and, once importing began writing tags,
  `ses:TagResource`/`ses:UntagResource` — CI's `tf-plan`/`tf-apply` roles
  already had the read actions via the wildcard `ReadAdoptionTargets`
  statement, but a workstation user doing the import needs them too.
- `terraform plan -generate-config-out` produced an invalid
  `aws_s3_bucket_lifecycle_configuration` block for the SES inbound bucket
  (both `days` and `expired_object_delete_marker` set on the same
  `expiration` block, which the provider rejects) — fixed by hand when
  folding the generated config into `ses.tf`.
- The site bucket and the CloudFront distribution both carry
  `lifecycle { prevent_destroy = true }`, same reasoning as the backup
  bucket: they are in the path of every push to `main`.

## Related

- `../.github/workflows/db-backup.yml` — the job these resources exist for.
- `../docs/backups.md` — what the backup contains and how to restore it.
