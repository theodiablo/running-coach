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
          # Scoped to the events that actually deploy (see
          # github_deploy_subjects): this role can overwrite the production
          # site, so a run from an arbitrary ref should not be able to assume
          # it. Fork PRs get no id-token at all, and deploy-pr.yml additionally
          # gates on author_association — but that gate is YAML, not IAM.
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

# Predates Terraform, and adopting means matching what's live, not narrowing it
# in the same change — see infra/README.md.
#
# Broader than the role needs, but NOT redundant with the inline policy above:
# deploy.yml's security-headers step also calls List/Create/Get/Update
# ResponseHeadersPolicy, GetDistributionConfig and UpdateDistribution, none of
# which the inline policy grants. Detaching this without adding those first
# breaks every production deploy — after the S3 sync has already landed.
resource "aws_iam_role_policy_attachment" "deploy_cloudfront" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/CloudFrontFullAccess"
}
