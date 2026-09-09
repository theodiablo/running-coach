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
