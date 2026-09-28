# PR previews (deploy-pr.yml). Trusted from pull requests, so it gets only what a
# preview needs: its own pr/ prefix and invalidation. Keeping previews off the
# deploy role is what lets that one be trusted from main alone, since a PR branch
# can edit its own copy of any workflow and assume whatever role trusts it.

resource "aws_iam_role" "preview" {
  name        = "${local.managed_prefix}preview"
  description = "OIDC role for PR previews: writes under pr/ in the site bucket only"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = "arn:aws:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = local.oidc_subjects.preview }
      }
    }]
  })
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
        Resource = "${aws_s3_bucket.site.arn}/pr/*"
      },
      {
        # `aws s3 sync --delete` and `aws s3 rm --recursive` list the prefix first.
        Sid       = "ListPreviewPrefix"
        Effect    = "Allow"
        Action    = "s3:ListBucket"
        Resource  = aws_s3_bucket.site.arn
        Condition = { StringLike = { "s3:prefix" = ["pr/*"] } }
      },
      {
        Sid      = "Invalidate"
        Effect   = "Allow"
        Action   = "cloudfront:CreateInvalidation"
        Resource = aws_cloudfront_distribution.site.arn
      },
    ]
  })
}
