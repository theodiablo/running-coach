// What both public watch pages (one runner, and the follow list) do to the
// document while they are up.

import { useEffect } from "react";
import { dismissTop } from "../utils/backDismiss";

// Keep the page out of search results, and keep the token out of the Referer
// header on the way to any outbound link. A link pasted into a public forum
// would otherwise get indexed and then crawled — the one realistic way a
// stranger ever reaches a live run without being handed the link. Paired with
// `Disallow: /watch/` in public/robots.txt: the meta tag covers a crawler that
// already has the URL, robots.txt covers one that would go looking.
export function useUnlistedPage(title: string) {
  useEffect(() => {
    const tags: HTMLMetaElement[] = [];
    const add = (attr: "name", key: string, content: string) => {
      const el = document.createElement("meta");
      el.setAttribute(attr, key);
      el.setAttribute("content", content);
      document.head.appendChild(el);
      tags.push(el);
    };
    // The static index.html ships `robots: index, follow` for the marketing
    // landing; ours has to override it, so drop the existing tag while we're up.
    const existing = document.querySelector('meta[name="robots"]');
    const previous = existing?.getAttribute("content") ?? null;
    existing?.setAttribute("content", "noindex, nofollow");
    if (!existing) add("name", "robots", "noindex, nofollow");
    add("name", "referrer", "no-referrer");
    const priorTitle = document.title;
    document.title = title;
    return () => {
      tags.forEach(el => el.remove());
      if (previous !== null) existing?.setAttribute("content", previous);
      document.title = priorTitle;
    };
  }, [title]);
}

// RunningCoach owns the app's Escape dispatcher, and it never mounts here.
export function useEscapeDismiss() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && dismissTop()) e.preventDefault(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
