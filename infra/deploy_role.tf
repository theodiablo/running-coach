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
          "token.actions.githubusercontent.com:sub" = [
            "repo:${var.github_repo}:*",
            "repo:${var.github_repo_immutable}:*",
          ]
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
        "arn:aws:cloudfront::${local.account_id}:distribution/${local.site_distribution_id}",
      ]
    }]
  })
}

# Predates Terraform. CloudFrontFullAccess is broader than the role needs (the
# inline policy above already grants the one CloudFront action it uses,
# CreateInvalidation) but adopting means matching what's live, not narrowing it
# in the same change — see infra/README.md.
resource "aws_iam_role_policy_attachment" "deploy_cloudfront" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/CloudFrontFullAccess"
}
