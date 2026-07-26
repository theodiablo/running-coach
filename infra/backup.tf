# Daily database backup infrastructure for .github/workflows/db-backup.yml.
#
# The whole app state is one jsonb row per user in public.app_state, replaced
# wholesale by the client on every write, with no history table. In July 2026 a
# failed read overwrote a real user's runs and plan. This bucket is the copy of
# record that made that class of incident recoverable by design rather than by
# luck.

# ---------------------------------------------------------------------------
# Bucket
# ---------------------------------------------------------------------------

# Deliberately separate from the site bucket (run.camboulive.solutions), which
# is a CloudFront origin and world-readable. These tarballs contain personal
# health data: runs, heart rate, notes.
resource "aws_s3_bucket" "backups" {
  bucket = var.backup_bucket_name

  # Now that apply runs in CI, a config change that happens to destroy this
  # bucket would take every backup with it, unreviewed. Terraform refuses to
  # produce such a plan at all. Removing this line is the deliberate act
  # required to delete the bucket, and it belongs in its own reviewed commit.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket = aws_s3_bucket.backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Versioning turns the workflow's prune step into a soft delete: it writes a
# delete marker rather than destroying the object, so a bug in the prune logic
# is recoverable for as long as the noncurrent-version expiry below allows.
resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# There is deliberately NO object expiry rule here.
#
# Retention of live backups is the workflow's job (RETENTION_DAYS), because only
# the workflow can honour MIN_KEEP: it always keeps the 7 most recent backups
# whatever their age. An S3 lifecycle expiry has no equivalent concept, so after
# a long run of failed scheduled jobs it would cheerfully empty the bucket,
# which is the exact failure db-backup.yml is built to prevent. The two rules
# below only reclaim storage that is never a backup of record.
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.backups]
}

# ---------------------------------------------------------------------------
# OIDC role
# ---------------------------------------------------------------------------

# Read, never manage: the provider is account-wide and shared with unrelated
# projects, so this configuration must not be able to destroy it.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "backup_assume_role" {
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

    # See github_repo_immutable: both subject formats are allowed because
    # GitHub mints the ID-suffixed one for this repository.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = flatten([
        for repo in [var.github_repo, var.github_repo_immutable] : [
          for subject in var.github_allowed_subjects : "repo:${repo}:${subject}"
        ]
      ])
    }
  }
}

# A role of its own rather than reusing GitHub-Actions-RunApp-deploy: that role
# runs on every push to main, and permission to delete backups has no business
# being in the site-deploy path.
resource "aws_iam_role" "backup" {
  name = "GitHub-Actions-RunApp-backup"

  # Keep this plain ASCII. IAM validates the description against a character
  # class that excludes em dashes, and rejects CreateRole outright rather than
  # stripping them.
  description = "OIDC role for db-backup.yml: writes and prunes database dumps in ${var.backup_bucket_name}."

  assume_role_policy = data.aws_iam_policy_document.backup_assume_role.json
}

data "aws_iam_policy_document" "backup" {
  # GetObject covers the workflow's head-object read-back, which verifies the
  # uploaded object is not truncated.
  statement {
    sid       = "WriteAndPruneBackups"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.backups.arn}/*"]
  }

  statement {
    sid       = "ListBackups"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backups.arn]
  }
}

resource "aws_iam_role_policy" "backup" {
  name   = "GitHubAction-RunApp-Backup"
  role   = aws_iam_role.backup.id
  policy = data.aws_iam_policy_document.backup.json
}
