# OIDC roles for the Terraform CI workflow (.github/workflows/terraform.yml).
#
# Two roles, not one, because plan and apply have very different blast radii:
#
#   tf-plan   read-only, assumable from pull requests. Cannot write anything,
#             so a plan rendered from an untrusted branch cannot change AWS.
#   tf-apply  read/write, assumable only from the default branch.
#
# These are the one bootstrap wrinkle in the setup: they must exist before CI
# can assume them, so they were applied once from a workstation. After that they
# are managed here like everything else.

locals {
  account_id     = data.aws_caller_identity.current.account_id
  state_bucket   = "run-app-tfstate"
  state_key      = "run-app/terraform.tfstate"
  tf_plan_role   = "GitHub-Actions-RunApp-tf-plan"
  tf_apply_role  = "GitHub-Actions-RunApp-tf-apply"
  tf_plan_arn    = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/GitHub-Actions-RunApp-tf-plan"
  tf_apply_arn   = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/GitHub-Actions-RunApp-tf-apply"
  managed_prefix = "GitHub-Actions-RunApp-"
}

data "aws_caller_identity" "current" {}

# Both repo subject formats, for the reason documented on github_repo_immutable.
# Also used by the deploy role (deploy_role.tf).
locals {
  oidc_subjects = {
    for scope, suffixes in {
      # Pull requests get `:pull_request`, not a branch ref. Fork PRs never
      # receive an id-token in the first place, so this cannot be used to plan
      # from an untrusted fork.
      plan   = ["pull_request", "ref:refs/heads/main"]
      apply  = ["ref:refs/heads/main"]
      deploy = var.github_deploy_subjects
      } : scope => flatten([
        for repo in [var.github_repo, var.github_repo_immutable] : [
          for suffix in suffixes : "repo:${repo}:${suffix}"
        ]
    ])
  }
}

data "aws_iam_policy_document" "tf_plan_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.oidc_subjects.plan
    }
  }
}

data "aws_iam_policy_document" "tf_apply_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.oidc_subjects.apply
    }
  }
}

# ---------------------------------------------------------------------------
# Read-only policy, shared by both roles
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "tf_read" {
  statement {
    sid     = "ReadState"
    effect  = "Allow"
    actions = ["s3:GetObject"]
    resources = [
      "arn:aws:s3:::${local.state_bucket}/${local.state_key}",
      # Terraform reads the lock object back in order to release it. Without
      # this, an otherwise successful run ends with "Error releasing the state
      # lock" and leaves a stale lock that blocks every later run.
      "arn:aws:s3:::${local.state_bucket}/${local.state_key}.tflock",
    ]
  }

  # Bucket configuration only. Note the resources are bucket ARNs, never
  # `bucket/*`, so neither role can read the contents of a backup tarball —
  # which is the whole reason the backup bucket is private in the first place.
  statement {
    sid    = "ReadBucketConfiguration"
    effect = "Allow"
    actions = [
      "s3:GetAccelerateConfiguration",
      "s3:GetBucketAcl",
      "s3:GetBucketCORS",
      "s3:GetBucketLocation",
      "s3:GetBucketLogging",
      "s3:GetBucketNotification",
      "s3:GetBucketObjectLockConfiguration",
      "s3:GetBucketOwnershipControls",
      "s3:GetBucketPolicy",
      "s3:GetBucketPublicAccessBlock",
      "s3:GetBucketRequestPayment",
      "s3:GetBucketTagging",
      "s3:GetBucketVersioning",
      "s3:GetBucketWebsite",
      "s3:GetEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:GetReplicationConfiguration",
      "s3:ListBucket",
    ]
    resources = ["arn:aws:s3:::*"]
  }

  statement {
    sid    = "ReadIam"
    effect = "Allow"
    actions = [
      "iam:GetOpenIDConnectProvider",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      # The aws_iam_openid_connect_provider data source resolves the provider by
      # URL, not by ARN, so it enumerates before it can Get. Without List, every
      # plan fails at the data source with AccessDenied.
      "iam:ListOpenIDConnectProviders",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      # For infra/permissions-check.sh: proves the write policy without
      # performing any write, so a policy bug is caught before it depends on a
      # merge to main to surface.
      "iam:SimulatePrincipalPolicy",
    ]
    resources = ["*"]
  }

  # Read-only ahead of the adoption of the site bucket, CloudFront and SES, so
  # that plans covering them work without another policy change.
  statement {
    sid    = "ReadAdoptionTargets"
    effect = "Allow"
    actions = [
      "cloudfront:Get*",
      "cloudfront:List*",
      "ses:Describe*",
      "ses:Get*",
      "ses:List*",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role" "tf_plan" {
  name               = local.tf_plan_role
  description        = "Read-only OIDC role for terraform plan in CI. Cannot write to AWS."
  assume_role_policy = data.aws_iam_policy_document.tf_plan_assume.json
}

resource "aws_iam_role_policy" "tf_plan" {
  name   = "TerraformPlanRead"
  role   = aws_iam_role.tf_plan.id
  policy = data.aws_iam_policy_document.tf_read.json
}

# ---------------------------------------------------------------------------
# Apply policy: everything above, plus scoped writes and explicit guardrails
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "tf_apply" {
  source_policy_documents = [data.aws_iam_policy_document.tf_read.json]

  statement {
    sid     = "WriteState"
    effect  = "Allow"
    actions = ["s3:PutObject", "s3:DeleteObject"]
    resources = [
      "arn:aws:s3:::${local.state_bucket}/${local.state_key}",
      "arn:aws:s3:::${local.state_bucket}/${local.state_key}.tflock",
    ]
  }

  # Bucket management is confined to this project's naming prefix, plus the
  # two adopted buckets that predate the run-app-* convention (the site
  # bucket and the SES inbound bucket), so the role cannot touch the buckets
  # belonging to unrelated projects in this account.
  statement {
    sid    = "ManageProjectBuckets"
    effect = "Allow"
    actions = [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:DeleteBucketPolicy",
      # Removing a website configuration is its own action (unlike CORS or
      # lifecycle, whose DELETE maps back to the matching Put*).
      "s3:DeleteBucketWebsite",
      "s3:PutAccelerateConfiguration",
      "s3:PutBucketAcl",
      "s3:PutBucketCORS",
      "s3:PutBucketLogging",
      "s3:PutBucketNotification",
      "s3:PutBucketObjectLockConfiguration",
      "s3:PutBucketOwnershipControls",
      "s3:PutBucketPolicy",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketRequestPayment",
      "s3:PutBucketTagging",
      "s3:PutBucketVersioning",
      "s3:PutBucketWebsite",
      "s3:PutEncryptionConfiguration",
      "s3:PutLifecycleConfiguration",
      "s3:PutReplicationConfiguration",
    ]
    resources = [
      "arn:aws:s3:::run-app-*",
      "arn:aws:s3:::${local.site_bucket_name}",
      "arn:aws:s3:::${local.ses_inbound_bucket}",
    ]
  }

  # Distributions DO take resource-level ARNs, so the two actions that can
  # break or delete a live site are pinned to this project's distribution. The
  # cost is that adding a second distribution means widening this list first —
  # and because of DenySelfModification, from a workstation.
  statement {
    sid    = "ManageSiteDistribution"
    effect = "Allow"
    actions = [
      "cloudfront:UpdateDistribution",
      "cloudfront:DeleteDistribution",
    ]
    resources = [aws_cloudfront_distribution.site.arn]
  }

  # The rest genuinely cannot be scoped: a create has no ARN yet, and origin
  # access controls have no IAM resource type at all. Tagging stays on "*"
  # because default_tags applies it to every CloudFront resource kind, and it
  # is not destructive.
  statement {
    sid    = "ManageCloudFront"
    effect = "Allow"
    actions = [
      "cloudfront:CreateDistribution",
      "cloudfront:CreateOriginAccessControl",
      "cloudfront:UpdateOriginAccessControl",
      "cloudfront:DeleteOriginAccessControl",
      "cloudfront:TagResource",
      "cloudfront:UntagResource",
    ]
    resources = ["*"]
  }

  # Same reasoning as CloudFront: SES's write actions don't take a
  # resource-scoped ARN either.
  statement {
    sid    = "ManageSes"
    effect = "Allow"
    actions = [
      "ses:CreateEmailIdentity",
      "ses:DeleteEmailIdentity",
      "ses:PutEmailIdentityDkimSigningAttributes",
      "ses:TagResource",
      "ses:UntagResource",
      "ses:CreateReceiptRuleSet",
      "ses:DeleteReceiptRuleSet",
      "ses:CreateReceiptRule",
      "ses:UpdateReceiptRule",
      "ses:DeleteReceiptRule",
      "ses:ReorderReceiptRuleSet",
      "ses:SetActiveReceiptRuleSet",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ManageProjectRoles"
    effect = "Allow"
    actions = [
      "iam:AttachRolePolicy",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
    ]
    resources = ["arn:aws:iam::${local.account_id}:role/${local.managed_prefix}*"]
  }

  # --- Guardrails -----------------------------------------------------------
  #
  # IAM write access is inherently close to admin: a role that can create roles
  # and attach policies can usually escalate. These Denys close the obvious
  # paths. They are not a proof of containment, and that trade-off is recorded
  # in infra/README.md.

  # Without this, the apply role could rewrite its own policy (its name matches
  # the managed prefix) and grant itself anything.
  #
  # Mutating actions ONLY. Terraform manages both of these roles, so it reads
  # them on every refresh; denying `iam:*` here denied iam:GetRole and made
  # every plan fail before it produced any output.
  #
  # The consequence is deliberate: a change to either CI role's own definition
  # cannot be applied by CI, and needs a local apply with real credentials. That
  # is the correct blast radius for "the thing that grants CI its permissions",
  # but it does mean such a PR merges green and then fails at apply.
  statement {
    sid    = "DenySelfModification"
    effect = "Deny"
    actions = [
      "iam:AttachRolePolicy",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
    ]
    resources = [local.tf_plan_arn, local.tf_apply_arn]
  }

  # Blocks the other obvious route: mint a new prefixed role and hand it an
  # AWS-managed admin policy.
  statement {
    sid       = "DenyPrivilegedManagedPolicies"
    effect    = "Deny"
    actions   = ["iam:AttachRolePolicy"]
    resources = ["*"]

    condition {
      test     = "ArnLike"
      variable = "iam:PolicyARN"
      values = [
        "arn:aws:iam::aws:policy/AdministratorAccess",
        "arn:aws:iam::aws:policy/IAMFullAccess",
        "arn:aws:iam::aws:policy/PowerUserAccess",
      ]
    }
  }

  # Deleting any of these is unrecoverable in a way an apply should never be
  # able to do on its own: the state bucket (matches run-app-*, and losing it
  # strands every resource Terraform manages), the live CloudFront origin, and
  # the landing zone for inbound mail. The site bucket carries prevent_destroy
  # too, but that is a plan-time guard in this repo — this one holds even if the
  # config says otherwise. Removing either adopted bucket therefore needs a
  # local apply, which is the right ceremony for it.
  statement {
    sid     = "DenyProtectedBucketDeletion"
    effect  = "Deny"
    actions = ["s3:DeleteBucket"]
    resources = [
      "arn:aws:s3:::${local.state_bucket}",
      "arn:aws:s3:::${local.site_bucket_name}",
      "arn:aws:s3:::${local.ses_inbound_bucket}",
    ]
  }
}

resource "aws_iam_role" "tf_apply" {
  name               = local.tf_apply_role
  description        = "OIDC role for terraform apply in CI, restricted to the default branch."
  assume_role_policy = data.aws_iam_policy_document.tf_apply_assume.json
}

resource "aws_iam_role_policy" "tf_apply" {
  name   = "TerraformApply"
  role   = aws_iam_role.tf_apply.id
  policy = data.aws_iam_policy_document.tf_apply.json
}
