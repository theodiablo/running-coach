// The public /watch/:token page — the one surface in this app that strangers
// see, and the only one that renders without an account.
//
// It is a standalone leaf on purpose. It never imports src/supabase.ts, never
// reads the auth session, never touches the store: the share token IS the
// authorization (src/live/shareLink.ts), so a signed-in visitor gets exactly
// what a signed-out one gets. Keeping the two orthogonal is what stops this
// page from dragging in the whole app-boot path — see main.tsx, which branches
// to it BEFORE <App/> mounts, so none of App's auth/store effects ever run.
//
// It deliberately reveals nothing about the runner: no name, no avatar, no
// account hint. The edge function doesn't even return the user id.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader, Radio } from "lucide-react";
import { LiveWatchDot, LiveWatchView, type LiveWatchStatus } from "../components/LiveWatchView";
import { fetchLiveWatch, type PublicLiveRun } from "../live/shareLink";

// Matches the publisher's cadence: reading faster than the phone writes can
// only return what we already have.
const LIVE_POLL_MS = 30000;
// Nothing live yet — a link shared before the run starts is a NORMAL state, not
// an error, so keep checking, just rarely enough to be free.
const IDLE_POLL_MS = 60000;

// Polling, not Realtime, and that is not a compromise: an anonymous viewer has
// no Realtime subscription to make (the table has no anon-readable policy at
// all, by design), and at the publisher's 30s write cadence a 30s read loses
// nothing.
function useWatchedRun(token: string) {
  const [run, setRun] = useState<PublicLiveRun | null>(null);
  // Distinct from `run === null`: before the first answer we must not claim
  // there is nothing to see.
  const [settled, setSettled] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Returns how long to wait before the next read, so the caller's loop doesn't
  // have to re-derive it from state it may not have re-rendered with yet.
  const load = useCallback(async (): Promise<number> => {
    const res = await fetchLiveWatch(token);
    if (!aliveRef.current) return LIVE_POLL_MS;
    setSettled(true);
    if (res.kind === "error") {
      // Keep whatever is already on screen. A dropped connection must never
      // render as a finished run — that would be the one lie this page can tell.
      setUnreachable(true);
      return res.retryAfterMs ?? LIVE_POLL_MS;
    }
    setUnreachable(false);
    setRun(res.kind === "live" ? res.run : null);
    return res.kind === "live" ? LIVE_POLL_MS : IDLE_POLL_MS;
  }, [token]);

  // A self-scheduling chain rather than setInterval: the delay changes with
  // what came back (live / idle / rate-limited), and a slow response must not
  // let a second read stack up behind the first. Paused entirely while the tab
  // is hidden — the visibility handler catches up on return.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const wait = await load();
      if (stopped) return;
      timer = setTimeout(tick, wait);
    };
    const onVis = () => {
      if (document.visibilityState !== "visible") {
        if (timer) clearTimeout(timer);
        timer = null;
        return;
      }
      if (!timer) void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  return { run, settled, unreachable, refresh: load };
}

// Keep the page out of search results, and keep the token out of the Referer
// header on the way to any outbound link. A link pasted into a public forum
// would otherwise get indexed and then crawled — the one realistic way a
// stranger ever reaches a live run without being handed the link. Paired with
// `Disallow: /watch/` in public/robots.txt: the meta tag covers a crawler that
// already has the URL, robots.txt covers one that would go looking.
function useUnlistedPage(title: string) {
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

export default function PublicWatch({ token }: { token: string }) {
  const { t } = useTranslation();
  const { run, settled, unreachable, refresh } = useWatchedRun(token);
  const [status, setStatus] = useState<LiveWatchStatus | null>(null);
  const onStatus = useCallback((s: LiveWatchStatus) => setStatus(s), []);
  useUnlistedPage(t("liveShare.public.docTitle"));

  return (
    <div className="fixed inset-0 bg-slate-900 text-slate-100 flex flex-col">
      <header className="flex items-center justify-between gap-3 px-4 border-b border-slate-800"
        style={{ height: "calc(52px + var(--safe-top))", paddingTop: "var(--safe-top)" }}>
        <div className="flex items-center gap-1.5 min-w-0">
          {run ? <LiveWatchDot ended={status?.ended ?? false} paused={status?.paused ?? false} />
            : <Radio size={15} className="text-slate-500" />}
          {/* Nothing here names the runner: the link is theirs to hand out, not
              an introduction. The edge function never returns the account id. */}
          <span className="text-sm font-semibold truncate">{t("liveShare.public.title")}</span>
        </div>
        <a href="/" className="text-[11px] font-semibold uppercase tracking-wide text-orange-400 hover:text-orange-300 shrink-0">
          {t("liveShare.public.openApp")}
        </a>
      </header>

      {run ? (
        <LiveWatchView run={run} onStatus={onStatus} bottomInset={false} />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
          {!settled ? (
            <Loader className="text-orange-400 animate-spin" size={28} />
          ) : (
            <>
              <Radio size={28} className="text-slate-600" />
              {/* The SAME message for a bad link, a run that hasn't started, and
                  one that is over. That indistinguishability is what makes
                  guessing URLs pointless — and it is also the honest answer for
                  a link shared the night before a race. */}
              <p className="text-sm text-slate-300 max-w-xs leading-snug">{t("liveShare.public.nothing")}</p>
              <p className="text-xs text-slate-500 max-w-xs leading-snug">{t("liveShare.public.nothingHint")}</p>
              {unreachable && (
                <button onClick={() => { void refresh(); }}
                  className="mt-1 rounded-xl bg-slate-800 border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700">
                  {t("liveShare.public.retry")}
                </button>
              )}
            </>
          )}
        </div>
      )}

      <footer className="px-4 py-3 border-t border-slate-800 text-center"
        style={{ paddingBottom: "calc(0.75rem + var(--safe-bottom))" }}>
        {/* This page is the first thing a stranger ever sees of the app. */}
        <a href="/" className="text-[11px] text-slate-500 hover:text-slate-300">
          {t("liveShare.public.madeWith")}
        </a>
      </footer>
    </div>
  );
}
