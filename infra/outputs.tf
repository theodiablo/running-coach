# These two feed the GitHub Actions secrets db-backup.yml reads. Set them with:
#
#   gh secret set BACKUP_S3_BUCKET   --body "$(terraform output -raw backup_bucket)"
#   gh secret set AWS_BACKUP_ROLE_ARN --body "$(terraform output -raw backup_role_arn)"

output "backup_bucket" {
  description = "Name of the private database-backup bucket (secret BACKUP_S3_BUCKET)."
  value       = aws_s3_bucket.backups.id
}

output "backup_role_arn" {
  description = "ARN of the OIDC role db-backup.yml assumes (secret AWS_BACKUP_ROLE_ARN)."
  value       = aws_iam_role.backup.arn
}

# Consumed by .github/workflows/terraform.yml:
#
#   gh secret set AWS_TF_PLAN_ROLE_ARN  --body "$(terraform output -raw tf_plan_role_arn)"
#   gh secret set AWS_TF_APPLY_ROLE_ARN --body "$(terraform output -raw tf_apply_role_arn)"

output "tf_plan_role_arn" {
  description = "Read-only role for terraform plan in CI (secret AWS_TF_PLAN_ROLE_ARN)."
  value       = aws_iam_role.tf_plan.arn
}

output "tf_apply_role_arn" {
  description = "Read/write role for terraform apply in CI, default branch only (secret AWS_TF_APPLY_ROLE_ARN)."
  value       = aws_iam_role.tf_apply.arn
}

# Read from the resource rather than repeated as a literal, so it survives a
# distribution ever being recreated:
#
#   gh secret set CLOUDFRONT_DISTRIBUTION_ID --body "$(terraform output -raw site_distribution_id)"

output "site_distribution_id" {
  description = "CloudFront distribution serving the site (secret CLOUDFRONT_DISTRIBUTION_ID)."
  value       = aws_cloudfront_distribution.site.id
}

# --- Auth mail (ses_sending.tf) --------------------------------------------
#
# The DNS records are Terraform-managed (the DKIM tokens come off the identity,
# so hand-copying them was the one step that could silently fail), which leaves
# only the credentials to move by hand — into
# Dashboard -> Authentication -> Emails -> SMTP Settings:
#
#   terraform output -raw auth_smtp_host
#   terraform output -raw auth_smtp_username
#   terraform output -raw auth_smtp_password

output "auth_smtp_host" {
  description = "SES SMTP endpoint for the Supabase Auth SMTP settings (port 587, STARTTLS)."
  value       = "email-smtp.${var.aws_region}.amazonaws.com"
}

# Sensitive not because an access key id is a secret on its own, but because it
# is half of one: `terraform apply` prints every root output, and the CI apply
# log is not redacted. `terraform output -raw` still reads it.
output "auth_smtp_username" {
  description = "SMTP username for Supabase Auth (the access key id of the send-only SES user)."
  value       = aws_iam_access_key.ses_smtp_auth.id
  sensitive   = true
}

output "auth_smtp_password" {
  description = "SMTP password for Supabase Auth (the secret, transformed by the SES SigV4 algorithm)."
  value       = aws_iam_access_key.ses_smtp_auth.ses_smtp_password_v4
  sensitive   = true
}
