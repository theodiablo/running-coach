# PR previews (deploy-pr.yml). Trusted from pull requests, so it gets only what a
# preview needs: the previews bucket's pr/ prefix and invalidation, on their own
# origin (previews.tf) so preview code never shares the production site's
# storage. Keeping previews off the deploy role is what lets that one be trusted
# from the production environment alone, since a PR branch can edit its own copy
# of any workflow and assume whatever role trusts it.

resource "aws_iam_role" "preview" {
  name        = "${local.managed_prefix}preview"
  description = "OIDC role for PR previews: writes under pr/ in the previews bucket only"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = "arn:aws:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = local.oidc_subjects.preview
        }
      }
    }]
  })

  permissions_boundary = aws_iam_policy.role_boundary.arn
}

resource "aws_iam_role_policy" "preview" {
  name = "run-app-preview"
  role = aws_iam_role.preview.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "PreviewObjects"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.previews.arn}/pr/*"
      },
      {
        # `aws s3 sync --delete` and `aws s3 rm --recursive` list the prefix first.
        Sid       = "ListPreviewPrefix"
        Effect    = "Allow"
        Action    = "s3:ListBucket"
        Resource  = aws_s3_bucket.previews.arn
        Condition = { StringLike = { "s3:prefix" = ["pr/*"] } }
      },
      {
        Sid      = "Invalidate"
        Effect   = "Allow"
        Action   = "cloudfront:CreateInvalidation"
        Resource = aws_cloudfront_distribution.previews.arn
      },
      # Legacy: previews under pr/ on the production origin, until
      # PREVIEW_DISTRIBUTION_ID is set (previews.tf). Remove once it is.
      {
        Sid      = "LegacyPreviewObjects"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.site.arn}/pr/*"
      },
      {
        Sid       = "LegacyListPreviewPrefix"
        Effect    = "Allow"
        Action    = "s3:ListBucket"
        Resource  = aws_s3_bucket.site.arn
        Condition = { StringLike = { "s3:prefix" = ["pr/*"] } }
      },
      {
        Sid      = "LegacyInvalidate"
        Effect   = "Allow"
        Action   = "cloudfront:CreateInvalidation"
        Resource = aws_cloudfront_distribution.site.arn
      },
    ]
  })
}
