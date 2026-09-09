# Outbound mail for Supabase Auth (password reset, magic link, email
# confirmation), on its own identity so its reputation is independent of the
# apex — which receives inbound mail (ses.tf) and sends the contribution
# notifier, and which any future marketing sending would otherwise share.
# An auth email that stops being delivered locks people out of the app, so it
# gets the domain nobody else sends from. Setup and the Supabase side:
# docs/release.md.

locals {
  ses_auth_domain    = "mail.${local.ses_domain}"
  ses_auth_mail_from = "bounce.mail.${local.ses_domain}"
  ses_auth_config    = "runapp-auth"
  # IAM users are not roles, so they sit outside managed_prefix (which names
  # the GitHub Actions OIDC roles). The apply role's write access is scoped to
  # this prefix.
  managed_user_prefix = "run-app-"
}

resource "aws_sesv2_configuration_set" "auth" {
  configuration_set_name = local.ses_auth_config

  delivery_options {
    # OPTIONAL, not REQUIRE: SES already uses TLS opportunistically, and
    # REQUIRE bounces mail to any receiver that won't negotiate it. A bounced
    # password reset is worse than an unencrypted hop.
    tls_policy = "OPTIONAL"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  suppression_options {
    # BOUNCE only. Complaint-suppression would let one "mark as spam" on a
    # reset mail permanently block that address from ever resetting again.
    suppressed_reasons = ["BOUNCE"]
  }
}

resource "aws_sesv2_email_identity" "auth" {
  email_identity         = local.ses_auth_domain
  configuration_set_name = aws_sesv2_configuration_set.auth.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# A custom MAIL FROM aligns SPF with the From: domain (DMARC needs one of SPF
# or DKIM aligned; DKIM alone would pass, but bounces then come back to
# amazonses.com and Gmail treats the mismatch as a weaker signal).
resource "aws_sesv2_email_identity_mail_from_attributes" "auth" {
  email_identity = aws_sesv2_email_identity.auth.email_identity

  mail_from_domain = local.ses_auth_mail_from
  # USE_DEFAULT_VALUE, not REJECT: if the MAIL FROM MX record ever goes missing
  # SES falls back to amazonses.com instead of refusing to send. Auth mail
  # should degrade, not stop.
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# Supabase Auth speaks SMTP only, and SES SMTP credentials are an IAM access
# key transformed by a published algorithm — hence a user rather than a role.
# The password is only ever derivable from the secret, so it lives in state
# (private, encrypted bucket) and is read back with `terraform output`.
resource "aws_iam_user" "ses_smtp_auth" {
  name = "${local.managed_user_prefix}ses-smtp-auth"
  path = "/system/"
}

data "aws_iam_policy_document" "ses_smtp_auth" {
  statement {
    sid       = "SendFromAuthIdentity"
    effect    = "Allow"
    actions   = ["ses:SendRawEmail", "ses:SendEmail"]
    resources = [aws_sesv2_email_identity.auth.arn]
  }
}

resource "aws_iam_user_policy" "ses_smtp_auth" {
  name   = "SesSendAuthMail"
  user   = aws_iam_user.ses_smtp_auth.name
  policy = data.aws_iam_policy_document.ses_smtp_auth.json
}

resource "aws_iam_access_key" "ses_smtp_auth" {
  user = aws_iam_user.ses_smtp_auth.name
}
