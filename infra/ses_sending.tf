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
  # Spelled out rather than read off the resource, because the apply role's own
  # policy conditions on it (terraform_roles.tf) and a resource reference there
  # would make the two files circular.
  ses_smtp_boundary_name = "${local.managed_user_prefix}ses-smtp-boundary"
  ses_smtp_boundary_arn  = "arn:aws:iam::${local.account_id}:policy/${local.managed_user_prefix}ses-smtp-boundary"
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
  # The ceiling, not the grant — the user can do at most what this allows, even
  # if its inline policy is rewritten. It is what keeps "CI can create an IAM
  # user" from meaning "CI can mint durable admin credentials": an access key is
  # a static credential that outlives the OIDC role that created it.
  permissions_boundary = aws_iam_policy.ses_smtp_boundary.arn
}

resource "aws_iam_policy" "ses_smtp_boundary" {
  name        = local.ses_smtp_boundary_name
  description = "Permissions ceiling for the SES SMTP user: send from the auth identity, nothing else."
  policy      = data.aws_iam_policy_document.ses_smtp_auth.json
}

data "aws_iam_policy_document" "ses_smtp_auth" {
  statement {
    sid     = "SendFromAuthIdentity"
    effect  = "Allow"
    actions = ["ses:SendRawEmail", "ses:SendEmail"]
    # Both ARNs, not just the identity: the identity carries this set as its
    # default, so SES authorises every send against the configuration set too
    # and an identity-only grant fails the whole send with a 554 "Access
    # denied" naming the set. It is the ceiling as well as the grant, so the
    # boundary needs it for the same reason.
    resources = [
      aws_sesv2_email_identity.auth.arn,
      aws_sesv2_configuration_set.auth.arn,
    ]
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

# --- DNS -------------------------------------------------------------------
#
# Managed here, unlike the apex's own records, for one reason: the DKIM tokens
# are outputs of the identity above. Copying three of them into the console by
# hand is the step that silently fails — a mistyped token verifies nothing and
# says nothing. Terraform wires them straight through instead.
#
# The zone is a data source: it predates this configuration, holds the live
# site's alias and the apex's inbound MX, and nothing here may be able to
# destroy it.
data "aws_route53_zone" "primary" {
  name         = "${local.ses_domain}."
  private_zone = false
}

# count, not for_each: the tokens are unknown until apply, and for_each refuses
# an unknown set. Easy DKIM always returns exactly three.
resource "aws_route53_record" "auth_dkim" {
  count = 3

  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "${aws_sesv2_email_identity.auth.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${local.ses_auth_domain}"
  type    = "CNAME"
  ttl     = 300
  records = ["${aws_sesv2_email_identity.auth.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "auth_mail_from_mx" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = local.ses_auth_mail_from
  type    = "MX"
  ttl     = 300
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

# On the MAIL FROM domain, not the sending domain: SPF authorises the envelope
# sender, and DMARC's relaxed alignment accepts the shared organisational
# domain.
resource "aws_route53_record" "auth_mail_from_spf" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = local.ses_auth_mail_from
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "auth_dmarc" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "_dmarc.${local.ses_auth_domain}"
  type    = "TXT"
  ttl     = 300
  records = ["v=DMARC1; p=none; rua=mailto:postmaster@${local.ses_domain}"]
}

# The rua mailbox is on a different domain than the DMARC record, so that
# domain has to say it accepts the reports (RFC 7489 external destination
# verification). Without this, Google and Microsoft drop them silently — and
# p=none exists precisely to collect them.
resource "aws_route53_record" "auth_dmarc_report_auth" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "${local.ses_auth_domain}._report._dmarc.${local.ses_domain}"
  type    = "TXT"
  ttl     = 300
  records = ["v=DMARC1"]
}
