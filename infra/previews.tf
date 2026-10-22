# PR previews on their own origin. Served from the production site's origin, a
# preview's JavaScript could read a signed-in runner's Supabase session and
# offline state out of localStorage, and plant state production would restore.
# A sibling subdomain is a different origin, so localStorage is isolated; it is
# the same site, though, so cookies scoped to camboulive.solutions are shared.
#
# deploy-pr.yml switches here once the repo variable PREVIEW_DISTRIBUTION_ID is
# set to this distribution's id (output preview_distribution_id).

locals {
  preview_domain      = "previews.${local.ses_domain}"
  preview_bucket_name = "run-app-previews"
}

resource "aws_s3_bucket" "previews" {
  bucket = local.preview_bucket_name
}

resource "aws_s3_bucket_ownership_controls" "previews" {
  bucket = aws_s3_bucket.previews.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "previews" {
  bucket = aws_s3_bucket.previews.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "previews" {
  bucket = aws_s3_bucket.previews.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# deploy-pr.yml removes a preview when its PR closes; this catches the ones a
# failed or skipped cleanup leaves behind.
resource "aws_s3_bucket_lifecycle_configuration" "previews" {
  bucket = aws_s3_bucket.previews.id

  rule {
    id     = "expire-stale-previews"
    status = "Enabled"
    filter {}

    expiration {
      days = 60
    }
  }
}

resource "aws_s3_bucket_policy" "previews" {
  bucket = aws_s3_bucket.previews.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontServicePrincipal"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.previews.arn}/*"
      Condition = {
        ArnLike = {
          "AWS:SourceArn" = aws_cloudfront_distribution.previews.arn
        }
      }
    }]
  })
}

resource "aws_cloudfront_origin_access_control" "previews" {
  name                              = "oac-${local.preview_domain}"
  description                       = "OAC for ${local.preview_domain}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_acm_certificate" "previews" {
  provider          = aws.us_east_1
  domain_name       = local.preview_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "previews_cert_validation" {
  for_each = {
    for o in aws_acm_certificate.previews.domain_validation_options : o.domain_name => o
  }

  zone_id = data.aws_route53_zone.primary.zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  ttl     = 300
  records = [each.value.resource_record_value]
}

resource "aws_acm_certificate_validation" "previews" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.previews.arn
  validation_record_fqdns = [for r in aws_route53_record.previews_cert_validation : r.fqdn]
}

resource "aws_cloudfront_distribution" "previews" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "PR previews (deploy-pr.yml)"
  price_class     = "PriceClass_100"
  http_version    = "http2"
  aliases         = [local.preview_domain]

  origin {
    origin_id                = aws_s3_bucket.previews.bucket_regional_domain_name
    domain_name              = aws_s3_bucket.previews.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.previews.id
  }

  default_cache_behavior {
    target_origin_id       = aws_s3_bucket.previews.bucket_regional_domain_name
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # AWS-managed "CachingOptimized", as on the site.
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.previews.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "previews" {
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.primary.zone_id
  name    = local.preview_domain
  type    = each.value

  alias {
    name                   = aws_cloudfront_distribution.previews.domain_name
    zone_id                = aws_cloudfront_distribution.previews.hosted_zone_id
    evaluate_target_health = false
  }
}
