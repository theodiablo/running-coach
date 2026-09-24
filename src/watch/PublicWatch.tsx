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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Flag, Loader, Radio } from "lucide-react";
import { BrandLogo } from "../components/BrandLogo";
import { LiveWatchDot, LiveWatchView, type LiveWatchStatus } from "../components/LiveWatchView";
import { fetchLiveWatch, type PublicLiveRun } from "../live/shareLink";
import { dismissTop } from "../utils/backDismiss";
import { AboutSheet, AppFeatures, EndedPromo, LivePromo, PinnedPromo, SiteLink, StoreButtons } from "./AppPromo";
import { siteLink, visitorPlatform } from "./storeLinks";

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
  // The last snapshot whose status was an explicit "ended" — the Stop write,
  // which carries the whole trace. Once the row is then swept (Save/Discard
  // deletes it), the page keeps showing this instead of dropping to "nothing
  // live": a spectator who watched the run deserves the finished route. Latched
  // ONLY on a seen "ended", never on a mere live→gone transition, so revoking
  // the link mid-run still takes an open page dark.
  const endedRef = useRef<PublicLiveRun | null>(null);

  // Returns how long to wait before the next read — or null to stop reading
  // for good, so the caller's loop doesn't have to re-derive either from state
  // it may not have re-rendered with yet.
  const load = useCallback(async (): Promise<number | null> => {
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
    if (res.kind === "live") {
      // A live status clears the latch: a run recovered after the app was
      // killed republishes under the same token, and must take the page back.
      endedRef.current = res.run.status === "ended" ? res.run : null;
      setRun(res.run);
      return LIVE_POLL_MS;
    }
    if (endedRef.current) {
      // The row is gone and we saw it end: hold the finished run on screen
      // rather than blinking to "nothing live". Keep reading at the idle
      // cadence, though — the link is the RUNNER's, not this run's, so the
      // same address lights up again the next time they go out, and a page
      // left open must not sit on a finished run forever.
      setRun(endedRef.current);
      return IDLE_POLL_MS;
    }
    setRun(null);
    return IDLE_POLL_MS;
  }, [token]);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // A self-scheduling chain rather than setInterval: the delay changes with
  // what came back (live / idle / rate-limited), and a slow response must not
  // let a second read stack up behind the first. Paused entirely while the tab
  // is hidden — the visibility handler catches up on return.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    // Latched only if a load says to stop for good. Nothing does today: a
    // finished run keeps polling at the idle cadence because the address is
    // durable (see load()). Kept as the one way to end the chain, and it
    // survives visibility flips, which would otherwise restart it on every
    // return to the tab.
    let done = false;
    const tick = async () => {
      if (stopped || done || document.visibilityState !== "visible") return;
      const wait = await load();
      if (stopped) return;
      if (wait == null) { done = true; return; }
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

// RunningCoach owns the app's Escape dispatcher, and it never mounts here.
function useEscapeDismiss() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && dismissTop()) e.preventDefault(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function PublicWatch({ token }: { token: string }) {
  const { t } = useTranslation();
  const { run, settled, unreachable, refresh } = useWatchedRun(token);
  const [status, setStatus] = useState<LiveWatchStatus | null>(null);
  const onStatus = useCallback((s: LiveWatchStatus) => setStatus(s), []);
  const [about, setAbout] = useState(false);
  const platform = useMemo(() => visitorPlatform(navigator.userAgent, navigator.maxTouchPoints), []);
  useUnlistedPage(t("liveShare.public.docTitle"));
  useEscapeDismiss();

  const ended = run?.status === "ended";
  const getApp = (
    <button onClick={() => setAbout(true)}
      className="shrink-0 inline-flex items-center gap-1.5 min-h-9 px-3 rounded-full border border-orange-500/50 text-orange-400 hover:text-orange-300 text-[13px] font-bold">
      <BrandLogo size={9} />{t("liveShare.public.getApp")}
    </button>
  );

  return (
    <div className="fixed inset-0 bg-slate-900 text-slate-100 flex flex-col">
      <header className="flex items-center justify-between gap-3 px-4 border-b border-slate-800"
        style={{ height: "calc(52px + var(--safe-top))", paddingTop: "var(--safe-top)" }}>
        {/* Nothing here names the runner: the link is theirs to hand out, not
            an introduction. The edge function never returns the account id. */}
        {run ? (
          <div className="flex items-center gap-2 min-w-0">
            {ended ? <Flag size={15} className="text-slate-500" />
              : <LiveWatchDot ended={status?.ended ?? false} paused={status?.paused ?? false} />}
            <span className="text-[15px] font-bold truncate">
              {t(ended ? "liveShare.public.finished" : "liveShare.public.title")}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 min-w-0 text-orange-500">
            <BrandLogo size={16} />
            <span className="text-[15px] font-bold text-slate-100 truncate">Running Coach</span>
          </div>
        )}
        {run ? getApp : settled && (
          <span className="shrink-0 flex items-center gap-1.5 text-xs text-slate-400">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-500" aria-hidden />{t("liveShare.public.notLive")}
          </span>
        )}
      </header>

      {run ? (
        <>
          <LiveWatchView run={run} onStatus={onStatus} bottomInset={false}
            panelFooter={<div className="hidden @3xl:block">
              {ended ? <EndedPromo platform={platform} /> : <LivePromo platform={platform} />}
            </div>} />
          <div className="md:hidden">
            <PinnedPromo ended={ended} onAbout={() => setAbout(true)} />
          </div>
        </>
      ) : !settled ? (
        <div className="flex-1 grid place-items-center">
          <Loader className="text-orange-400 animate-spin" size={28} />
        </div>
      ) : (
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-4 py-5 md:px-12 md:py-16 grid gap-6 md:grid-cols-2 md:gap-12 md:items-center">
            <section className="rounded-[20px] md:rounded-3xl border border-slate-800 bg-[#111c33] px-5 py-7 md:px-10 md:py-12 text-center flex flex-col items-center gap-2.5">
              <div className="grid place-items-center w-16 h-16 md:w-20 md:h-20 rounded-full bg-slate-800 text-slate-400">
                <Radio size={28} aria-hidden />
              </div>
              {/* The SAME message for a bad link, a run that hasn't started, and
                  one that is over. That indistinguishability is what makes
                  guessing URLs pointless — and it is also the honest answer for
                  a link shared the night before a race. */}
              <h1 className="mt-1.5 text-[22px] md:text-3xl font-extrabold tracking-tight">{t("liveShare.public.nothing")}</h1>
              <p className="text-sm md:text-base leading-relaxed text-slate-300 max-w-sm">{t("liveShare.public.nothingHint")}</p>
              {unreachable ? (
                <button onClick={() => { void refresh(); }}
                  className="mt-1.5 rounded-xl bg-slate-800 border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700">
                  {t("liveShare.public.retry")}
                </button>
              ) : (
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-500" aria-hidden />{t("liveShare.public.checking")}
                </p>
              )}
            </section>
            <section className="flex flex-col gap-4 px-1 md:gap-5">
              <div className="space-y-1.5">
                <p className="text-xs font-bold uppercase tracking-widest text-orange-400">{t("liveShare.public.eyebrow")}</p>
                <h2 className="text-xl md:text-[32px] font-extrabold leading-tight">{t("liveShare.public.headline")}</h2>
              </div>
              <AppFeatures />
              <div className="md:max-w-sm"><StoreButtons platform={platform} placement="idle" /></div>
              <SiteLink placement="idle" label={t("liveShare.public.learnMore")} />
            </section>
          </div>
        </main>
      )}

      {/* A phone watching a run has the pinned promo down here instead. */}
      <footer className={`px-4 py-3 border-t border-slate-800 text-center ${run ? "hidden md:block" : ""}`}
        style={{ paddingBottom: "calc(0.75rem + var(--safe-bottom))" }}>
        <a href={siteLink("footer")} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200">
          <BrandLogo size={10} />{t("liveShare.public.madeWith")}
        </a>
      </footer>

      {about && <AboutSheet platform={platform} onClose={() => setAbout(false)} />}
    </div>
  );
}
