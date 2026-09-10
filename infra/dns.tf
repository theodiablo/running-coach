# The apex TXT record set, adopted rather than created.
#
# It already carries the SPF record authorising SES to send for the domain, and
# Route 53 keeps every TXT value for one name in a single record — so a second
# resource for this name would collide with it, and replacing the set without
# the SPF value would unauthenticate the domain's mail. The import block adopts
# what is live; the only change is the value added below.

import {
  to = aws_route53_record.apex_txt
  id = "${data.aws_route53_zone.primary.zone_id}_${local.ses_domain}_TXT"
}

resource "aws_route53_record" "apex_txt" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = local.ses_domain
  type    = "TXT"
  ttl     = 300

  # SPF first: it predates this configuration and mail depends on it. The
  # verification token proves ownership of the Search Console *Domain*
  # property, which is checked at the root and covers every subdomain — a
  # token on run.camboulive.solutions verifies nothing.
  records = [
    "v=spf1 include:amazonses.com ~all",
    "google-site-verification=CUJdbeBXHaFwEf34kLohlnZ_8t0wqRcemS110nD3d1M",
  ]
}
