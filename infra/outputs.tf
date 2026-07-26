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
