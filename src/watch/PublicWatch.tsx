// The public /watch/:token page: the one surface strangers see, rendering without an
// account. A standalone leaf: never imports src/supabase.ts, reads auth or touches the
// store; the share token IS the authorization (src/live/shareLink.ts). main.tsx branches
// here BEFORE <App/> mounts. Reveals nothing about the runner (no name, avatar, user id).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Flag, Loader, Radio } from "lucide-react";
import { BrandLogo } from "../components/BrandLogo";
import { LiveWatchDot, LiveWatchView, type LiveWatchStatus } from "../components/LiveWatchView";
import { fetchLiveWatch, type PublicLiveRun } from "../live/shareLink";
import { AboutSheet, AppFeatures, EndedPromo, LivePromo, PinnedPromo, SiteLink, StoreButtons } from "./AppPromo";
import { siteLink, visitorPlatform } from "./storeLinks";
import { FollowControl } from "./Follow";
import MultiWatch from "./MultiWatch";
import { useEscapeDismiss, useUnlistedPage } from "./unlisted";

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
  // The last snapshot with an explicit "ended" status (the Stop write, carrying the whole
  // trace). When the row is then swept, keep showing it instead of "nothing live". Latched
  // ONLY on a seen "ended", never a live->gone transition, so revoking mid-run goes dark.
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
      // Row gone after we saw it end: hold the finished run on screen, but keep polling at the
      // idle cadence. The link is the RUNNER's, so it lights up again next run, and a page left
      // open must not sit on a finished run forever.
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
    // Latched only if a load says to stop for good (none does today: the address is durable,
    // see load()). The one way to end the chain, and it survives visibility flips, which
    // would otherwise restart it.
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

// One lazy chunk for both public pages: `/watch/<token>` is one runner, and
// `/watch/` (token null) is everyone this browser follows.
export default function PublicWatch({ token }: { token: string | null }) {
  return token ? <OneRunnerWatch token={token} /> : <MultiWatch />;
}

function OneRunnerWatch({ token }: { token: string }) {
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
        {run ? <div className="flex items-center gap-2"><FollowControl token={token} />{getApp}</div> : settled && (
          <span className="shrink-0 flex items-center gap-1.5 text-xs text-slate-400">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-500" aria-hidden />{t("liveShare.public.notLive")}
          </span>
        )}
      </header>

      {run ? (
        <>
          <LiveWatchView run={run} onStatus={onStatus} bottomInset={false} cacheTiles={false}
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
              <div className="mt-3"><FollowControl token={token} large /></div>
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
