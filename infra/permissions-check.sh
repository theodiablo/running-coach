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
SMTP_USER="arn:aws:iam::${ACCOUNT}:user/system/run-app-ses-smtp-auth"
SMTP_BOUNDARY="arn:aws:iam::${ACCOUNT}:policy/run-app-ses-smtp-boundary"
# SES ARNs are regional. configure-aws-credentials exports AWS_REGION in CI;
# the fallback is var.aws_region's default.
SES_REGION="${AWS_REGION:-eu-west-1}"
AUTH_IDENTITY="arn:aws:ses:${SES_REGION}:${ACCOUNT}:identity/mail.camboulive.solutions"
AUTH_CONFIG_SET="arn:aws:ses:${SES_REGION}:${ACCOUNT}:configuration-set/runapp-auth"
APEX_IDENTITY="arn:aws:ses:${SES_REGION}:${ACCOUNT}:identity/camboulive.solutions"
SITE_DISTRIBUTION="arn:aws:cloudfront::${ACCOUNT}:distribution/E42OGU5IVYJ14"
# Resolved rather than hardcoded, the same way the configuration resolves it.
# An empty result is not a failure here: on the very first run after the grant
# lands the caller may not have the read yet, and the zone cases are skipped
# with a warning instead of failing the whole check.
MAIL_ZONE_ID="$(aws route53 list-hosted-zones-by-name --dns-name camboulive.solutions \
  --query 'HostedZones[0].Id' --output text 2>/dev/null | sed 's#/hostedzone/##')"
OTHER_ZONE="arn:aws:route53:::hostedzone/Z00000000000000000000"
OTHER_DISTRIBUTION="arn:aws:cloudfront::${ACCOUNT}:distribution/E00000000000X"

pass=0
fail=0

# check <label> <role-arn> <action> <resource> <expected> [boundary-arn]
#
# expected is one of: allowed | explicitDeny | implicitDeny | denied
# "denied" accepts either kind, for cases where only the outcome matters.
#
# resource "*" means "this action takes no resource-level ARN" (several
# CloudFront and SES writes) — simulate against all resources by leaving the
# parameter off, which is what the API defaults to. The `${a[@]+...}` expansion
# is the form that survives an empty array under `set -u`.
#
# The 6th argument supplies the iam:PermissionsBoundary context key. The
# statements that let the apply role create a user or write its policy are
# conditioned on it, and simulation cannot infer a condition key that the
# request would carry — so without it those cases come back implicitDeny and
# the assertion would be measuring the missing key, not the policy.
check() {
  local label="$1" role="$2" action="$3" resource="$4" expected="$5" boundary="${6:-}"
  local actual
  local scope=()
  local ctx=()
  [ "$resource" = "*" ] || scope=(--resource-arns "$resource")
  [ -z "$boundary" ] || ctx=(--context-entries "ContextKeyName=iam:PermissionsBoundary,ContextKeyValues=${boundary},ContextKeyType=string")

  actual="$(aws iam simulate-principal-policy \
    --policy-source-arn "$role" \
    --action-names "$action" \
    ${scope[@]+"${scope[@]}"} \
    ${ctx[@]+"${ctx[@]}"} \
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
check "manage the config set"        "$APPLY_ROLE" ses:PutConfigurationSetSuppressionOptions "*" allowed

echo
echo "tf-apply: the auth mail DNS records"
# Route 53 scopes writes per hosted zone, so the negative case is the one that
# matters: this grant must not reach any other zone in the account.
if [ -n "$MAIL_ZONE_ID" ] && [ "$MAIL_ZONE_ID" != "None" ]; then
  MAIL_ZONE="arn:aws:route53:::hostedzone/${MAIL_ZONE_ID}"
  check "change records in the zone"  "$APPLY_ROLE" route53:ChangeResourceRecordSets "$MAIL_ZONE"  allowed
  check "read the zone on refresh"    "$APPLY_ROLE" route53:ListResourceRecordSets   "$MAIL_ZONE"  allowed
  check "change another zone"         "$APPLY_ROLE" route53:ChangeResourceRecordSets "$OTHER_ZONE" denied
else
  printf '  warn  %-58s zone lookup returned nothing, cases skipped\n' "camboulive.solutions"
fi

echo
echo "tf-apply: the SES SMTP user and its boundary"
# The one IAM user this configuration owns: send-only credentials for Supabase
# Auth. Its access key IS the SMTP password, so key rotation has to be in scope.
# Creating it and writing its policy are allowed only WITH the boundary, which
# is the whole containment: an unbounded user could be given anything, and its
# access key would outlive the role that made it.
check "create the SMTP user"         "$APPLY_ROLE" iam:CreateUser      "$SMTP_USER" allowed "$SMTP_BOUNDARY"
check "write its inline policy"      "$APPLY_ROLE" iam:PutUserPolicy   "$SMTP_USER" allowed "$SMTP_BOUNDARY"
check "rotate its access key"        "$APPLY_ROLE" iam:CreateAccessKey "$SMTP_USER" allowed
check "read it back on refresh"      "$APPLY_ROLE" iam:GetUser         "$SMTP_USER" allowed
check "delete the user"              "$APPLY_ROLE" iam:DeleteUser      "$SMTP_USER" allowed
check "delete its inline policy"     "$APPLY_ROLE" iam:DeleteUserPolicy "$SMTP_USER" allowed
check "delete its access key"        "$APPLY_ROLE" iam:DeleteAccessKey "$SMTP_USER" allowed
check "create the boundary policy"   "$APPLY_ROLE" iam:CreatePolicy    "$SMTP_BOUNDARY" allowed

echo
echo "the SMTP user itself: send-only, from the auth identity alone"
# The user, not a CI role — this is the credential Supabase Auth signs in with,
# and its boundary is evaluated here automatically. The configuration-set case
# is a regression test: the identity carries runapp-auth as its default, so SES
# authorises each send against the set as well, and an identity-only grant took
# every password reset down with a 554 while the identity was verified and the
# credentials were valid.
check "send from the auth identity"  "$SMTP_USER" ses:SendRawEmail "$AUTH_IDENTITY"   allowed
check "send through its config set"  "$SMTP_USER" ses:SendRawEmail "$AUTH_CONFIG_SET" allowed
check "send via the v2 API"          "$SMTP_USER" ses:SendEmail    "$AUTH_IDENTITY"   allowed
# Send-only, and only from the domain nobody else sends from: the apex is the
# inbound/notifier identity, and auth mail must not be able to spend its
# reputation.
check "send from the apex identity"  "$SMTP_USER" ses:SendRawEmail "$APEX_IDENTITY"  denied
check "read a backup tarball"        "$SMTP_USER" s3:GetObject     "$BACKUP_OBJECT"  denied
check "rotate its own access key"    "$SMTP_USER" iam:CreateAccessKey "$SMTP_USER"   denied

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
# A boundary this role could rewrite would not be a boundary. Same shape as
# DenySelfModification: raising it needs a local apply.
check "rewrite the boundary"       "$APPLY_ROLE" iam:CreatePolicyVersion   "$SMTP_BOUNDARY" explicitDeny
check "delete the boundary"        "$APPLY_ROLE" iam:DeletePolicy          "$SMTP_BOUNDARY" explicitDeny

echo
echo "tf-apply: out of scope (must not be granted)"
# The backup tarballs carry personal health data. No CI role may read them.
check "read a backup tarball"      "$APPLY_ROLE" s3:GetObject    "$BACKUP_OBJECT" denied
# Bucket-level configuration on the site bucket is in scope (above); its
# contents are the deploy role's business, not Terraform's.
check "write to the site bucket"   "$APPLY_ROLE" s3:PutObject    "${SITE_BUCKET}/index.html" denied
check "touch another project"      "$APPLY_ROLE" s3:DeleteBucket "$OTHER_BUCKET"  denied
check "create an unprefixed role"  "$APPLY_ROLE" iam:CreateRole  "arn:aws:iam::${ACCOUNT}:role/Unrelated" denied
check "create an unprefixed user"  "$APPLY_ROLE" iam:CreateUser  "arn:aws:iam::${ACCOUNT}:user/Unrelated" denied "$SMTP_BOUNDARY"
# The two that turn "can create a user" into "can mint an admin credential".
# Without the boundary in the request there is no Allow to match, so a plain
# prefixed user cannot be created and cannot be given a policy.
check "create an unbounded user"   "$APPLY_ROLE" iam:CreateUser    "$SMTP_USER" denied
check "write an unbounded policy"  "$APPLY_ROLE" iam:PutUserPolicy "$SMTP_USER" denied
# Not granted at all, and the privileged-policy Deny now names it too (that
# Deny is conditioned on the policy ARN, which simulation cannot infer, so this
# lands as an implicit deny — either kind is the property being asserted).
check "attach a policy to the user" "$APPLY_ROLE" iam:AttachUserPolicy "$SMTP_USER" denied
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
check "rotate the SMTP key"        "$PLAN_ROLE" iam:CreateAccessKey "$SMTP_USER" denied
check "create the SMTP user"       "$PLAN_ROLE" iam:CreateUser "$SMTP_USER" denied "$SMTP_BOUNDARY"
check "configure the site bucket"  "$PLAN_ROLE" s3:PutBucketPolicy "$SITE_BUCKET" denied
if [ -n "$MAIL_ZONE_ID" ] && [ "$MAIL_ZONE_ID" != "None" ]; then
  check "read a zone"              "$PLAN_ROLE" route53:ListResourceRecordSets   "arn:aws:route53:::hostedzone/${MAIL_ZONE_ID}" allowed
  check "change a DNS record"      "$PLAN_ROLE" route53:ChangeResourceRecordSets "arn:aws:route53:::hostedzone/${MAIL_ZONE_ID}" denied
fi

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
