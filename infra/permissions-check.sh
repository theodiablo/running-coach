#!/usr/bin/env bash
#
# Asserts what the Terraform CI roles can and cannot do, using IAM policy
# simulation. Run by .github/workflows/terraform-permissions.yml, and runnable
# locally with any credentials that allow iam:SimulatePrincipalPolicy.
#
# Why this exists: a pull request only ever exercises the read-only plan role,
# so the apply role's policy gets its first real workout when something merges
# to main. Two permission bugs shipped that way (a Deny that also denied reads,
# and a lock that could be taken but not released) and both were only found by a
# failed apply on main. Simulation tests the policy without performing any
# writes, so the apply path can be checked before a merge depends on it.
#
# The negative cases matter as much as the positive ones. "CI cannot read a
# backup tarball" and "the apply role cannot rewrite its own policy" are
# security properties, and a policy edit that quietly grants either should fail
# here rather than be discovered later.

set -uo pipefail

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
PLAN_ROLE="arn:aws:iam::${ACCOUNT}:role/GitHub-Actions-RunApp-tf-plan"
APPLY_ROLE="arn:aws:iam::${ACCOUNT}:role/GitHub-Actions-RunApp-tf-apply"
BACKUP_ROLE="arn:aws:iam::${ACCOUNT}:role/GitHub-Actions-RunApp-backup"

STATE="arn:aws:s3:::run-app-tfstate/run-app/terraform.tfstate"
LOCK="${STATE}.tflock"
STATE_BUCKET="arn:aws:s3:::run-app-tfstate"
BACKUP_BUCKET="arn:aws:s3:::run-app-db-backups"
BACKUP_OBJECT="${BACKUP_BUCKET}/supabase/run-app-20260101T000000Z.tar.gz"
SITE_BUCKET="arn:aws:s3:::run.camboulive.solutions"
SES_BUCKET="arn:aws:s3:::ses-inbound-camboulive-solutions"
OTHER_BUCKET="arn:aws:s3:::luffashop-backups"
SITE_DISTRIBUTION="arn:aws:cloudfront::${ACCOUNT}:distribution/E42OGU5IVYJ14"
OTHER_DISTRIBUTION="arn:aws:cloudfront::${ACCOUNT}:distribution/E00000000000X"

pass=0
fail=0

# check <label> <role-arn> <action> <resource> <expected>
#
# expected is one of: allowed | explicitDeny | implicitDeny | denied
# "denied" accepts either kind, for cases where only the outcome matters.
#
# resource "*" means "this action takes no resource-level ARN" (several
# CloudFront and SES writes) — simulate against all resources by leaving the
# parameter off, which is what the API defaults to. The `${a[@]+...}` expansion
# is the form that survives an empty array under `set -u`.
check() {
  local label="$1" role="$2" action="$3" resource="$4" expected="$5"
  local actual
  local scope=()
  [ "$resource" = "*" ] || scope=(--resource-arns "$resource")

  actual="$(aws iam simulate-principal-policy \
    --policy-source-arn "$role" \
    --action-names "$action" \
    ${scope[@]+"${scope[@]}"} \
    --query 'EvaluationResults[0].EvalDecision' \
    --output text 2>/dev/null)"

  if [ -z "$actual" ] || [ "$actual" = "None" ]; then
    printf '  FAIL  %-58s simulation returned nothing\n' "$label"
    fail=$((fail + 1))
    return
  fi

  local ok=false
  case "$expected" in
    denied) [ "$actual" = "explicitDeny" ] || [ "$actual" = "implicitDeny" ] && ok=true ;;
    *)      [ "$actual" = "$expected" ] && ok=true ;;
  esac

  if [ "$ok" = true ]; then
    printf '  ok    %-58s %s\n' "$label" "$actual"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-58s expected %s, got %s\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

echo "Account: $ACCOUNT"
echo
echo "tf-apply: state and lock"
# The lock read is the regression test for the bug that left a stale lock behind
# and blocked every subsequent run.
check "read state"                 "$APPLY_ROLE" s3:GetObject    "$STATE" allowed
check "write state"                "$APPLY_ROLE" s3:PutObject    "$STATE" allowed
check "delete state"               "$APPLY_ROLE" s3:DeleteObject "$STATE" allowed
check "read lock"                  "$APPLY_ROLE" s3:GetObject    "$LOCK"  allowed
check "take lock"                  "$APPLY_ROLE" s3:PutObject    "$LOCK"  allowed
check "release lock"               "$APPLY_ROLE" s3:DeleteObject "$LOCK"  allowed

echo
echo "tf-apply: managing project resources"
check "configure the backup bucket" "$APPLY_ROLE" s3:PutBucketVersioning "$BACKUP_BUCKET"              allowed
check "create a run-app-* bucket"   "$APPLY_ROLE" s3:CreateBucket        "arn:aws:s3:::run-app-future" allowed
check "create a prefixed role"      "$APPLY_ROLE" iam:CreateRole   "arn:aws:iam::${ACCOUNT}:role/GitHub-Actions-RunApp-future" allowed
check "write the backup role policy" "$APPLY_ROLE" iam:PutRolePolicy "$BACKUP_ROLE" allowed

echo
echo "tf-apply: the adopted site, CloudFront and SES resources"
# Everything the adoption made writable. s3:DeleteBucketWebsite is the one that
# is easy to miss: unlike CORS or lifecycle, removing a website configuration
# does not map back to the matching Put*.
check "configure the site bucket"    "$APPLY_ROLE" s3:PutBucketPolicy     "$SITE_BUCKET" allowed
check "drop the site website config" "$APPLY_ROLE" s3:DeleteBucketWebsite "$SITE_BUCKET" allowed
check "configure the SES bucket"     "$APPLY_ROLE" s3:PutLifecycleConfiguration "$SES_BUCKET" allowed
check "update the site distribution" "$APPLY_ROLE" cloudfront:UpdateDistribution "$SITE_DISTRIBUTION" allowed
check "create a distribution"        "$APPLY_ROLE" cloudfront:CreateDistribution "*" allowed
check "manage the receipt rule"      "$APPLY_ROLE" ses:UpdateReceiptRule  "*" allowed
check "manage the email identity"    "$APPLY_ROLE" ses:CreateEmailIdentity "*" allowed

echo
echo "tf-apply: reading the roles it manages"
# Denying iam:* on these two is what broke plan: Terraform manages them, so it
# must be able to read them on every refresh.
check "read its own role"          "$APPLY_ROLE" iam:GetRole       "$APPLY_ROLE" allowed
check "read its own role policy"   "$APPLY_ROLE" iam:GetRolePolicy "$APPLY_ROLE" allowed
check "read the plan role"         "$APPLY_ROLE" iam:GetRole       "$PLAN_ROLE"  allowed

echo
echo "tf-apply: guardrails (must be explicitly denied)"
check "rewrite its own policy"     "$APPLY_ROLE" iam:PutRolePolicy         "$APPLY_ROLE"   explicitDeny
check "delete itself"              "$APPLY_ROLE" iam:DeleteRole            "$APPLY_ROLE"   explicitDeny
check "retrust the plan role"      "$APPLY_ROLE" iam:UpdateAssumeRolePolicy "$PLAN_ROLE"   explicitDeny
check "delete the state bucket"    "$APPLY_ROLE" s3:DeleteBucket           "$STATE_BUCKET" explicitDeny
# Adopted, and unrecoverable: the live CloudFront origin and the inbound-mail
# landing zone. Bucket-level configuration is writable, deletion is not.
check "delete the site bucket"     "$APPLY_ROLE" s3:DeleteBucket           "$SITE_BUCKET"  explicitDeny
check "delete the SES bucket"      "$APPLY_ROLE" s3:DeleteBucket           "$SES_BUCKET"   explicitDeny

echo
echo "tf-apply: out of scope (must not be granted)"
# The backup tarballs carry personal health data. No CI role may read them.
check "read a backup tarball"      "$APPLY_ROLE" s3:GetObject    "$BACKUP_OBJECT" denied
# Bucket-level configuration on the site bucket is in scope (above); its
# contents are the deploy role's business, not Terraform's.
check "write to the site bucket"   "$APPLY_ROLE" s3:PutObject    "${SITE_BUCKET}/index.html" denied
check "touch another project"      "$APPLY_ROLE" s3:DeleteBucket "$OTHER_BUCKET"  denied
check "create an unprefixed role"  "$APPLY_ROLE" iam:CreateRole  "arn:aws:iam::${ACCOUNT}:role/Unrelated" denied
# Distributions do take resource-level ARNs, so the destructive CloudFront
# actions are pinned to this project's one rather than granted account-wide.
check "break another distribution" "$APPLY_ROLE" cloudfront:UpdateDistribution "$OTHER_DISTRIBUTION" denied
check "delete another distribution" "$APPLY_ROLE" cloudfront:DeleteDistribution "$OTHER_DISTRIBUTION" denied

echo
echo "tf-plan: read-only"
check "read state"                 "$PLAN_ROLE" s3:GetObject "$STATE"       allowed
check "read a role"                "$PLAN_ROLE" iam:GetRole  "$APPLY_ROLE"  allowed
check "write state"                "$PLAN_ROLE" s3:PutObject "$STATE"       denied
check "take the lock"              "$PLAN_ROLE" s3:PutObject "$LOCK"        denied
check "create a role"              "$PLAN_ROLE" iam:CreateRole "arn:aws:iam::${ACCOUNT}:role/GitHub-Actions-RunApp-future" denied
check "read a backup tarball"      "$PLAN_ROLE" s3:GetObject "$BACKUP_OBJECT" denied
# The adoption widened the apply role, not this one.
check "update the distribution"    "$PLAN_ROLE" cloudfront:UpdateDistribution "$SITE_DISTRIBUTION" denied
check "delete a receipt rule"      "$PLAN_ROLE" ses:DeleteReceiptRule "*" denied
check "configure the site bucket"  "$PLAN_ROLE" s3:PutBucketPolicy "$SITE_BUCKET" denied

echo
echo "backup role: scoped to its own bucket"
check "write a backup"             "$BACKUP_ROLE" s3:PutObject    "$BACKUP_OBJECT" allowed
check "prune a backup"             "$BACKUP_ROLE" s3:DeleteObject "$BACKUP_OBJECT" allowed
check "delete its bucket"          "$BACKUP_ROLE" s3:DeleteBucket "$BACKUP_BUCKET" denied
check "read terraform state"       "$BACKUP_ROLE" s3:GetObject    "$STATE"         denied
check "write to the site bucket"   "$BACKUP_ROLE" s3:PutObject    "${SITE_BUCKET}/index.html" denied

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
