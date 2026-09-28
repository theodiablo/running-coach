# Adopted: pre-dates Terraform. Deploys the built SPA to the site bucket and
# invalidates CloudFront on every push to main (see the deploy workflow).

resource "aws_iam_role" "deploy" {
  name = "GitHub-Actions-RunApp-deploy"

  # Keep this plain ASCII — see the note on backup.tf's role description.
  description = "OIDC deploy role for theodiablo/vibe-coded-run-app -> run.camboulive.solutions"

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
        }
        StringLike = {
          # Both subject formats — see github_repo_immutable in variables.tf.
          # main only (github_deploy_subjects): this role can overwrite the
          # production site. PR previews use the preview role.
          "token.actions.githubusercontent.com:sub" = local.oidc_subjects.deploy
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  name = "GitHubAction-RunApp-Deploy"
  role = aws_iam_role.deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "VisualEditor0"
      Effect = "Allow"
      Action = [
        "s3:PutObject",
        "s3:ListBucket",
        "s3:DeleteObject",
        "cloudfront:CreateInvalidation",
      ]
      Resource = [
        "${aws_s3_bucket.site.arn}/*",
        aws_s3_bucket.site.arn,
        # The resource, not the literal ID: a distribution that ever gets
        # recreated would otherwise leave this granting invalidation on a dead
        # ID, with nothing in the plan to show for it.
        aws_cloudfront_distribution.site.arn,
      ]
    }]
  })
}

# What deploy.yml's security-headers step calls, in place of the
# CloudFrontFullAccess this role was adopted with. Headers policies take no
# resource ARN on create/list.
resource "aws_iam_role_policy" "deploy_headers" {
  name = "GitHubAction-RunApp-Deploy-Headers"
  role = aws_iam_role.deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SiteDistribution"
        Effect   = "Allow"
        Action   = ["cloudfront:GetDistributionConfig", "cloudfront:UpdateDistribution"]
        Resource = aws_cloudfront_distribution.site.arn
      },
      {
        Sid    = "ResponseHeadersPolicies"
        Effect = "Allow"
        Action = [
          "cloudfront:ListResponseHeadersPolicies",
          "cloudfront:CreateResponseHeadersPolicy",
          "cloudfront:GetResponseHeadersPolicy",
          "cloudfront:UpdateResponseHeadersPolicy",
        ]
        Resource = "*"
      },
    ]
  })
}
