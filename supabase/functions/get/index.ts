// get — the flyer QR code's target, reached as run.camboulive.solutions/get
// through CloudFront (infra/site.tf). Sends the scanner's device to its store
// (or the web app) and counts the scan: platform + campaign tag only, never an
// IP or user agent. Public by design, so no JWT. docs/store-redirect.md.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { routeScan } from "../_shared/storeRedirect.mjs";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  const scan = routeScan({
    method: req.method,
    userAgent: req.headers.get("user-agent"),
    src: new URL(req.url).searchParams.get("src"),
  });

  // A failed count must never cost the redirect.
  if (scan.count) {
    try {
      const { error } = await admin.from("qr_scans").insert({ platform: scan.platform, src: scan.src });
      if (error) console.error("qr_scans insert failed", error.message);
    } catch (e) {
      console.error("qr_scans insert threw", e);
    }
  }

  return new Response(null, {
    status: 302,
    headers: { Location: scan.location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
});
