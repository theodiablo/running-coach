# The ceiling on every project role tf-apply can create or edit (deploy, preview,
# backup). ManageProjectRoles only allows writing a role's policies while it
# carries this boundary, so a role tf-apply mints or rewrites can never exceed
# it: no IAM, and no reading a backup. DenyBoundaryTampering keeps tf-apply from
# raising it, so widening it is a local apply.

locals {
  role_boundary_name = "${local.managed_user_prefix}ci-role-boundary"
  # Spelled out, like the SES boundary, because tf-apply's policy conditions on it.
  role_boundary_arn = "arn:aws:iam::${local.account_id}:policy/${local.managed_user_prefix}ci-role-boundary"
}

data "aws_iam_policy_document" "role_boundary" {
  statement {
    sid     = "WriteSiteObjects"
    effect  = "Allow"
    actions = ["s3:PutObject", "s3:DeleteObject"]
    resources = [
      "${aws_s3_bucket.site.arn}/*",
      "${aws_s3_bucket.previews.arn}/*",
      "${aws_s3_bucket.backups.arn}/*",
    ]
  }

  statement {
    sid     = "ListProjectBuckets"
    effect  = "Allow"
    actions = ["s3:ListBucket"]
    resources = [
      aws_s3_bucket.site.arn,
      aws_s3_bucket.previews.arn,
      aws_s3_bucket.backups.arn,
    ]
  }

  statement {
    sid     = "Invalidate"
    effect  = "Allow"
    actions = ["cloudfront:CreateInvalidation"]
    resources = [
      aws_cloudfront_distribution.site.arn,
      aws_cloudfront_distribution.previews.arn,
    ]
  }

  # deploy.yml's security-headers step (deploy_role.tf).
  statement {
    sid       = "SiteHeaders"
    effect    = "Allow"
    actions   = ["cloudfront:GetDistributionConfig", "cloudfront:UpdateDistribution"]
    resources = [aws_cloudfront_distribution.site.arn]
  }

  statement {
    sid    = "ResponseHeadersPolicies"
    effect = "Allow"
    actions = [
      "cloudfront:ListResponseHeadersPolicies",
      "cloudfront:CreateResponseHeadersPolicy",
      "cloudfront:GetResponseHeadersPolicy",
      "cloudfront:UpdateResponseHeadersPolicy",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "role_boundary" {
  name        = local.role_boundary_name
  description = "Permissions boundary for the run-app CI roles that tf-apply manages"
  policy      = data.aws_iam_policy_document.role_boundary.json
}
