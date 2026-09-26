// CloudFront Function (cloudfront-js-2.0), viewer request, attached only to the
// /watch/* cache behavior in site.tf. Serves every run link the one static
// watch.html (link-preview tags for chat apps, which never run JavaScript) from
// the edge cache. The browser keeps its /watch/<token> URL, which is what the
// app routes on. Without a watch.html in the bucket the SPA fallback serves
// index.html, so a deploy-order gap degrades to the homepage preview.
function handler(event) {
  var request = event.request;
  if (request.uri.indexOf("/watch/") === 0) request.uri = "/watch.html";
  return request;
}
