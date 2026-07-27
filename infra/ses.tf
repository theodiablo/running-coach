# Adopted: inbound mail for camboulive.solutions, pre-dating Terraform.
#
# Apex MX -> SES inbound -> this bucket -> a Lambda forwarder (not managed
# here; see the ses-forwarder-camboulive-solutions function) which relays to
# the verified personal inbox. DNS (MX, DKIM, SPF) lives in Route 53, also not
# managed here.

locals {
  ses_domain             = "camboulive.solutions"
  ses_inbound_bucket     = "ses-inbound-camboulive-solutions"
  ses_receipt_rule_set   = "camboulive-solutions-inbound"
  ses_forwarder_function = "ses-forwarder-camboulive-solutions"
}

resource "aws_sesv2_email_identity" "domain" {
  email_identity = local.ses_domain
}

resource "aws_s3_bucket" "ses_inbound" {
  bucket = local.ses_inbound_bucket
}

resource "aws_s3_bucket_ownership_controls" "ses_inbound" {
  bucket = aws_s3_bucket.ses_inbound.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "ses_inbound" {
  bucket = aws_s3_bucket.ses_inbound.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ses_inbound" {
  bucket = aws_s3_bucket.ses_inbound.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Inbound mail is transient — the forwarder relays it and the S3 copy exists
# only to survive a forwarder failure, so it does not need the durability the
# db-backup bucket does.
resource "aws_s3_bucket_lifecycle_configuration" "ses_inbound" {
  bucket = aws_s3_bucket.ses_inbound.id

  rule {
    id     = "expire-inbound"
    status = "Enabled"
    filter {
      prefix = "inbound/"
    }

    expiration {
      days = 30
    }
  }
}

resource "aws_s3_bucket_policy" "ses_inbound" {
  bucket = aws_s3_bucket.ses_inbound.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSESInboundPuts"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.ses_inbound.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceAccount" = local.account_id
        }
      }
    }]
  })
}

resource "aws_ses_receipt_rule_set" "inbound" {
  rule_set_name = local.ses_receipt_rule_set
}

resource "aws_ses_receipt_rule" "forward_all" {
  name          = "forward-all"
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
  recipients    = [local.ses_domain]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Optional"

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.ses_inbound.id
    object_key_prefix = "inbound/"
  }

  lambda_action {
    position        = 2
    function_arn    = "arn:aws:lambda:${var.aws_region}:${local.account_id}:function:${local.ses_forwarder_function}"
    invocation_type = "Event"
  }
}

resource "aws_ses_active_receipt_rule_set" "inbound" {
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
}
