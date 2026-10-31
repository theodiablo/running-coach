// get — the flyer QR code's target, reached as run.camboulive.solutions/get
// through CloudFront (infra/site.tf). Sends the scanner's device to its store
// (or the web app) and counts the scan: platform + campaign tag only, never an
// IP or user agent. Public by design, so no JWT. docs/store-redirect.md.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { routeScan } from "../_shared/storeRedirect.mjs";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

async function count(platform: string, src: string) {
  try {
    const { error } = await admin.from("qr_scans").insert({ platform, src });
    if (error) console.error("qr_scans insert failed", error.message);
  } catch (e) {
    console.error("qr_scans insert threw", e);
  }
}

Deno.serve((req) => {
  const scan = routeScan({
    method: req.method,
    userAgent: req.headers.get("user-agent"),
    src: new URL(req.url).searchParams.get("src"),
  });

  // The redirect never waits on the count; waitUntil keeps the insert alive after it.
  if (scan.count) {
    const pending = count(scan.platform, scan.src);
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(pending);
  }

  return new Response(null, {
    status: 302,
    headers: { Location: scan.location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
});
