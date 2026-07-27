# Adopted: the CloudFront-fronted static site, pre-dating Terraform.
#
# World-readable content served through CloudFront, not directly from S3 —
# the bucket itself is private (Origin Access Control) and blocked from public
# access. Deliberately separate from the backup bucket and its data
# classification; see backup.tf.

locals {
  site_bucket_name = "run.camboulive.solutions"
}

resource "aws_s3_bucket" "site" {
  bucket = local.site_bucket_name

  # This bucket is CloudFront's origin for a live site on every push to main.
  # Replacing it (a rename, or an attribute change that forces replacement)
  # would break the site instantly.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_website_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  index_document {
    suffix = "index.html"
  }
}

# CloudFront reaches the bucket via Origin Access Control, not a public read
# grant — this Allow is scoped to the one distribution's source ARN.
resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id

  policy = jsonencode({
    Version = "2008-10-17"
    Id      = "PolicyForCloudFrontPrivateContent"
    Statement = [{
      Sid       = "AllowCloudFrontServicePrincipal"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
      Condition = {
        ArnLike = {
          "AWS:SourceArn" = aws_cloudfront_distribution.site.arn
        }
      }
    }]
  })
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "oac-run.camboulive.solutions"
  description                       = "OAC for run.camboulive.solutions"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "site" {
  # In the path of every push to main (the deploy workflow invalidates it).
  # Replacement would mean a new distribution ID and domain name.
  #
  # response_headers_policy_id is owned by deploy.yml, not by Terraform — see
  # the note on default_cache_behavior below. Without ignore_changes, a policy
  # the workflow recreates (new ID) would be reverted here to a stale one on the
  # next apply, silently dropping the site's clickjacking headers.
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [default_cache_behavior[0].response_headers_policy_id]
  }

  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Serve run.camboulive.solutions"
  default_root_object = "index.html"
  price_class         = "PriceClass_All"
  http_version        = "http2"
  aliases             = [local.site_bucket_name]

  origin {
    origin_id                = aws_s3_bucket.site.bucket_regional_domain_name
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = aws_s3_bucket.site.bucket_regional_domain_name
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # cache_policy_id is the AWS-managed "CachingOptimized" policy.
    #
    # response_headers_policy_id is NOT an AWS-managed policy: it is the custom
    # `run-app-security-headers` policy that deploy.yml creates and attaches on
    # every push to main (frame-ancestors + X-Frame-Options, which a <meta> CSP
    # cannot set). That workflow owns the field — this value is only the initial
    # one for a from-scratch create, and drift is ignored via `lifecycle` above.
    # Adopting the policy here and dropping the workflow step is the eventual
    # cleanup; see infra/README.md.
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    response_headers_policy_id = "d2b8c523-04e4-43fe-8ccb-ebb5692fb6c7"
  }

  # A single-page app: any path not found in the bucket is the router's job,
  # not a real 403/404.
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    # us-east-1 is required for CloudFront regardless of where the site
    # itself lives. Not managed here as an aws_acm_certificate resource:
    # DNS-validated certs need their validation records adopted too, and
    # nothing about this configuration needs to reissue or rotate it.
    acm_certificate_arn      = "arn:aws:acm:us-east-1:${local.account_id}:certificate/e6de682b-2184-4d79-8d92-014d3c43023e"
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
