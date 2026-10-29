// `/watch/` — every runner this browser follows, on one map. Same rules as the
// single-runner page (no session, no store, nothing identifying from the
// server); what is new is that the list and its labels live in this browser
// (src/live/followList.ts) and that one batched read covers everyone: heads and
// stats for all, a full trace only for the runner in focus and for a run that
// just ended. Detail: docs/live-sharing.md ("Following several runners").

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Flag, Loader, Pause, Users } from "lucide-react";
import { BrandLogo } from "../components/BrandLogo";
import { LiveRunStats, LiveRunStatus } from "../components/LiveWatchView";
import { useNow } from "../hooks/useNow";
import { RunChart } from "../components/RunChart";
import { buildRunSeries } from "../utils/runSeries";
import { elevGainM } from "../utils/geo";
import { liveRowState, freshness, type LiveRowState } from "../live/liveStatus";
import {
  fetchLiveWatchBatch, tokenFromInput, type BatchRequestEntry, type PublicLiveRun, type WatchSummary,
} from "../live/shareLink";
import { forgetAllRunners, unfollowRunner, type FollowedRunner } from "../live/followList";
import { AboutSheet, AppFeatures, LivePromo, PinnedPromo, StoreButtons } from "./AppPromo";
import { siteLink, visitorPlatform } from "./storeLinks";
import { FollowSheet } from "./Follow";
import { useFollows } from "./useFollows";
import { MultiRunnerMap, type MapRunner } from "./MultiRunnerMap";
import { useEscapeDismiss, useUnlistedPage } from "./unlisted";

// Same cadences as the single page: reading faster than the phones write can
// only return what we already have.
const LIVE_POLL_MS = 30000;
const IDLE_POLL_MS = 60000;

type RunnerData = {
  // null = nothing live under this link (the uniform answer).
  run: WatchSummary | null;
  // The last full trace received, kept while it is still the same run.
  full: PublicLiveRun | null;
};

const headOf = (points: PublicLiveRun["points"]): WatchSummary["head"] => {
  for (let i = points.length - 1; i >= 0; i--) if (points[i]) return points[i];
  return null;
};
const headLatLng = (p: WatchSummary["head"]): [number, number] | null => {
  const lat = Number(p?.[0]), lng = Number(p?.[1]);
  return p && Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
};
const summaryOf = ({ points, ...rest }: PublicLiveRun): WatchSummary => ({ ...rest, head: headOf(points) });

// The batched polling loop. Results are applied by token, never by position in
// the current list, so a response for an older list or focus is still correct.
function useFollowedRuns(list: FollowedRunner[], focus: string | null) {
  const dataRef = useRef(new Map<string, RunnerData>());
  const [snapshot, setSnapshot] = useState(() => new Map<string, RunnerData>());
  const [settled, setSettled] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const tokens = list.map(r => r.token);
  const key = tokens.join(",");

  const load = useCallback(async (): Promise<number> => {
    const toks = key ? key.split(",") : [];
    if (!toks.length) { setSettled(true); return IDLE_POLL_MS; }
    const entries: BatchRequestEntry[] = toks.map(token => {
      const d = dataRef.current.get(token);
      // `since` names the trace we hold, so an unchanged one costs nothing; the
      // server also sends a just-ended run's trace unasked (wantsFull).
      return { token, full: token === focus, since: d?.full?.updated_at ?? null };
    });
    const res = await fetchLiveWatchBatch(entries);
    if (!aliveRef.current) return LIVE_POLL_MS;
    setSettled(true);
    if (res.kind === "error") {
      // Keep what is on screen: a dropped connection is never "nobody is live".
      setUnreachable(true);
      return res.retryAfterMs ?? LIVE_POLL_MS;
    }
    setUnreachable(false);
    res.results.forEach((r, i) => {
      const token = entries[i].token;
      const prev = dataRef.current.get(token) ?? { run: null, full: null };
      let next: RunnerData = prev;
      if (r.kind === "full") next = { run: summaryOf(r.run), full: r.run };
      else if (r.kind === "summary") {
        // A trace from a different run (or a resumed one) is no longer this run's.
        // A live answer also clears the ended latch.
        const sameRun = prev.full && prev.full.started_at === r.run.started_at && prev.full.status !== "ended";
        next = { run: r.run, full: sameRun ? prev.full : null };
      } else if (r.kind === "none") {
        // Seen ending, then swept by the runner's Save: hold the finished run on
        // screen (in memory only), as the single page does. Anything else that
        // goes quiet goes dark: a link replaced mid-run never wrote "ended".
        next = prev.full?.status === "ended" ? { run: summaryOf(prev.full), full: prev.full } : { run: null, full: null };
      }
      dataRef.current.set(token, next);
    });
    setSnapshot(new Map(dataRef.current));
    const anyLive = toks.some(tk => { const d = dataRef.current.get(tk); return d?.run && d.run.status !== "ended"; });
    return anyLive ? LIVE_POLL_MS : IDLE_POLL_MS;
  }, [key, focus]);

  // Self-scheduling chain, restarted (with an immediate read) whenever the list
  // or the focus changes, so tapping a runner fetches their trace straight away.
  // Paused while the tab is hidden.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let inFlight = false;
    // `timer` is null whenever no read is scheduled, and `inFlight` stops a
    // return to the tab from starting a second chain beside a pending read.
    const tick = async () => {
      timer = null;
      if (stopped || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      const wait = await load().catch(() => LIVE_POLL_MS).finally(() => { inFlight = false; });
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(tick, wait);
    };
    const onVis = () => {
      if (document.visibilityState !== "visible") {
        if (timer) clearTimeout(timer);
        timer = null;
        return;
      }
      if (!timer && !inFlight) void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const get = (token: string): RunnerData => snapshot.get(token) ?? { run: null, full: null };
  return { get, settled, unreachable, refresh: load };
}

function StatusLine({ data, state }: { data: RunnerData; state: LiveRowState }) {
  const { t } = useTranslation();
  if (!data.run) return <span>{t("liveShare.public.notLive")}</span>;
  if (state.ended) return <span className="inline-flex items-center gap-1"><Flag size={11} aria-hidden />{t("liveShare.public.finished")}</span>;
  if (state.paused) return <span className="inline-flex items-center gap-1 text-amber-300"><Pause size={11} aria-hidden />{t("liveShare.watch.paused")}</span>;
  if (state.quiet) return <span className="text-amber-300">{t("liveShare.public.multi.quiet", { mins: Math.round(state.quietMs / 60000) })}</span>;
  const fresh = freshness(state);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" aria-hidden />{fresh ? t(fresh.key, fresh.params) : ""}
    </span>
  );
}

function AddRunner({ onToken }: { onToken: (token: string) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const token = tokenFromInput(value);
    if (!token) { setInvalid(true); return; }
    setInvalid(false);
    setValue("");
    onToken(token);
  };
  return (
    <form onSubmit={submit} className="space-y-1.5">
      <label htmlFor="watch-add" className="block text-xs font-semibold text-slate-300">{t("liveShare.public.multi.add")}</label>
      <div className="flex gap-2">
        <input id="watch-add" value={value} onChange={e => { setValue(e.target.value); setInvalid(false); }}
          inputMode="url" autoComplete="off" placeholder={t("liveShare.public.multi.addPlaceholder")}
          aria-invalid={invalid || undefined}
          className="flex-1 min-w-0 rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-orange-500" />
        <button type="submit" className="shrink-0 rounded-xl bg-slate-800 border border-slate-700 px-3 text-sm font-semibold text-slate-200 hover:bg-slate-700">
          {t("liveShare.public.multi.addButton")}
        </button>
      </div>
      {invalid && <p role="alert" className="text-xs text-amber-200">{t("liveShare.public.multi.addInvalid")}</p>}
    </form>
  );
}

// Inline confirm: never window.confirm (CLAUDE.md).
function ConfirmInline({ question, confirm, onConfirm, onCancel }:
  { question: string; confirm: string; onConfirm: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={question} className="rounded-xl border border-slate-700 bg-slate-800/60 p-3 space-y-2">
      <p className="text-xs text-slate-200">{question}</p>
      <div className="flex gap-2">
        <button type="button" onClick={onConfirm} autoFocus className="flex-1 rounded-lg bg-red-500/90 hover:bg-red-500 text-white text-xs font-bold py-2">{confirm}</button>
        <button type="button" onClick={onCancel} className="flex-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold py-2">{t("liveShare.public.follow.cancel")}</button>
      </div>
    </div>
  );
}

export default function MultiWatch() {
  const { t } = useTranslation();
  const [list, setList] = useFollows();
  const [focus, setFocus] = useState<string | null>(null);
  const [refit, setRefit] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"remove" | "forget" | null>(null);
  const [about, setAbout] = useState(false);
  const platform = useMemo(() => visitorPlatform(navigator.userAgent, navigator.maxTouchPoints), []);
  const now = useNow();
  // A runner removed in another tab can't stay focused here.
  const focused = focus && list.some(r => r.token === focus) ? focus : null;
  const { get, settled, unreachable, refresh } = useFollowedRuns(list, focused);
  useEscapeDismiss();

  const label = (r: FollowedRunner, i: number) => r.name || t("liveShare.public.follow.unnamed", { n: i + 1 });
  const rows = list.map((r, i) => {
    const data = get(r.token);
    return { r, name: label(r, i), data, state: liveRowState(data.run, now) };
  });
  const liveCount = rows.filter(x => x.data.run && !x.state.ended).length;
  useUnlistedPage(liveCount
    ? t("liveShare.public.multi.docTitleLive", { count: liveCount })
    : t("liveShare.public.multi.docTitle"));

  // `toggle`: a second tap on the focused row (or its marker) unfocuses it.
  const pick = useCallback((token: string | null, toggle = true) => {
    setFocus(f => (toggle && f === token ? null : token));
    setConfirm(null);
    setRefit(n => n + 1);
  }, []);

  const mapRunners: MapRunner[] = rows.map(({ r, name, data, state }) => ({
    token: r.token,
    color: r.color,
    initial: (name.trim()[0] ?? "?").toUpperCase(),
    label: name,
    head: headLatLng(data.run?.head ?? null),
    hollow: state.ended,
    warn: state.quiet,
  }));
  const sel = rows.find(x => x.r.token === focused) ?? null;
  const selTrack = sel?.data.full && sel.data.run && sel.data.full.started_at === sel.data.run.started_at ? sel.data.full.points : null;
  const series = selTrack ? buildRunSeries(selTrack) : [];
  const hasSeriesElev = series.some(r => r.elevM != null);

  const header = (
    <header className="flex items-center justify-between gap-3 px-4 border-b border-slate-800 shrink-0"
      style={{ height: "calc(52px + var(--safe-top))", paddingTop: "var(--safe-top)" }}>
      <div className="flex items-center gap-2 min-w-0">
        {liveCount ? (
          <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
            <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
        ) : <Users size={15} className="text-slate-400 shrink-0" aria-hidden />}
        <span className="text-[15px] font-bold truncate">
          {list.length ? t("liveShare.public.multi.header", { count: list.length, live: liveCount }) : t("liveShare.public.multi.headerNone")}
        </span>
      </div>
      <button onClick={() => setAbout(true)}
        className="shrink-0 inline-flex items-center gap-1.5 min-h-9 px-3 rounded-full border border-orange-500/50 text-orange-400 hover:text-orange-300 text-[13px] font-bold">
        <BrandLogo size={9} />{t("liveShare.public.getApp")}
      </button>
    </header>
  );

  const addSheet = adding && (
    <FollowSheet token={adding} list={list}
      onDone={next => { setList(next); setAdding(null); pick(adding, false); }} onClose={() => setAdding(null)} />
  );

  if (!list.length) {
    return (
      <div className="fixed inset-0 bg-slate-900 text-slate-100 flex flex-col">
        {header}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-4 py-5 md:px-12 md:py-16 grid gap-6 md:grid-cols-2 md:gap-12 md:items-center">
            <section className="rounded-[20px] md:rounded-3xl border border-slate-800 bg-[#111c33] px-5 py-7 md:px-10 md:py-12 flex flex-col gap-4">
              <div className="flex flex-col items-center gap-2.5 text-center">
                <div className="grid place-items-center w-16 h-16 rounded-full bg-slate-800 text-slate-400"><Users size={28} aria-hidden /></div>
                <h1 className="text-[22px] md:text-3xl font-extrabold tracking-tight">{t("liveShare.public.multi.emptyTitle")}</h1>
                <p className="text-sm leading-relaxed text-slate-300 max-w-sm">{t("liveShare.public.multi.emptyBody")}</p>
              </div>
              <AddRunner onToken={setAdding} />
            </section>
            <section className="flex flex-col gap-4 px-1 md:gap-5">
              <h2 className="text-xl md:text-[32px] font-extrabold leading-tight">{t("liveShare.public.headline")}</h2>
              <AppFeatures />
              <div className="md:max-w-sm"><StoreButtons platform={platform} placement="idle" /></div>
            </section>
          </div>
        </main>
        {addSheet}
        {about && <AboutSheet platform={platform} onClose={() => setAbout(false)} />}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-slate-900 text-slate-100 flex flex-col">
      {header}
      <div className="flex-1 min-h-0 @container flex flex-col">
        <div className="flex-1 min-h-0 flex flex-col @3xl:flex-row">
          <div className="flex-1 min-h-0 relative">
            <MultiRunnerMap runners={mapRunners} focus={focused} track={selTrack} onPick={pick} refit={refit} />
            <div className="absolute left-12 top-2.5 z-[500] flex gap-1.5">
              <button type="button" onClick={() => pick(null)} aria-pressed={!focused}
                className={"min-h-9 rounded-full px-3 text-xs font-semibold border bg-slate-900 "
                  + (!focused ? "border-orange-500 text-orange-300 shadow-[inset_0_0_0_999px_rgba(249,115,22,0.2)]" : "border-slate-700 text-slate-200")}>
                {t("liveShare.public.multi.everyone")}
              </button>
            </div>
            {!settled && (
              <div className="absolute inset-0 grid place-items-center pointer-events-none z-[500]">
                <Loader className="text-orange-400 animate-spin" size={28} />
              </div>
            )}
          </div>

          <div className="border-t border-slate-800 max-h-[55%] overflow-y-auto shrink-0
              @3xl:border-t-0 @3xl:border-l @3xl:w-96 @3xl:max-h-none">
            <ul className="divide-y divide-slate-800 @3xl:divide-y-0 @3xl:p-2 @3xl:space-y-1">
              {rows.map(({ r, name, data, state }) => (
                <li key={r.token}>
                  <button type="button" onClick={() => pick(r.token)} aria-pressed={r.token === focused}
                    className={"w-full grid grid-cols-[28px_minmax(0,1fr)_auto] gap-3 items-center px-4 py-2.5 text-left @3xl:rounded-xl "
                      + (r.token === focused ? "bg-slate-800" : "hover:bg-slate-800/50")}>
                    <span className="w-7 h-7 rounded-full grid place-items-center text-xs font-extrabold text-slate-900"
                      style={{ background: r.color, opacity: data.run ? 1 : 0.45 }} aria-hidden>
                      {(name.trim()[0] ?? "?").toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className={"block truncate text-sm font-bold " + (data.run ? "" : "text-slate-500")}>{name}</span>
                      <span className="block truncate text-[11.5px] text-slate-400"><StatusLine data={data} state={state} /></span>
                    </span>
                    <span className="text-right tabular-nums">
                      {data.run ? (
                        <>
                          <span className="block text-[15px] font-bold">{(data.run.stats.km ?? 0).toFixed(1)}</span>
                          <span className="block text-[11px] text-slate-400">{t("liveShare.public.multi.km")}</span>
                        </>
                      ) : <span className="text-slate-600">–</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="p-4 space-y-3 border-t border-slate-800">
              {sel ? (
                <>
                  <p className="flex items-center gap-2 text-xs text-slate-400">
                    <span className="w-2.5 h-1 rounded-full" style={{ background: sel.r.color }} aria-hidden />
                    <span className="font-bold text-slate-100 truncate">{sel.name}</span>
                  </p>
                  {sel.data.run ? (
                    <>
                      <LiveRunStats stats={sel.data.run.stats} state={sel.state}
                        elevGain={Math.round(sel.data.run.stats.elevation ?? (selTrack ? elevGainM(selTrack) : 0))}
                        hasElev={selTrack ? hasSeriesElev : sel.data.run.stats.elevation != null} />
                      {series.length >= 2 && (
                        <div className="bg-slate-800 rounded-2xl p-3">
                          <RunChart series={series} show={{ elev: true, pace: true, hr: false }} hasElev={hasSeriesElev} hasHr={false} />
                        </div>
                      )}
                      <LiveRunStatus state={sel.state} />
                    </>
                  ) : (
                    <p className="text-sm text-slate-400">{t("liveShare.public.multi.notLiveYet", { name: sel.name })}</p>
                  )}
                  {confirm === "remove" ? (
                    <ConfirmInline question={t("liveShare.public.multi.removeQ", { name: sel.name })}
                      confirm={t("liveShare.public.multi.remove")}
                      onConfirm={() => { setList(unfollowRunner(sel.r.token)); setFocus(null); setConfirm(null); }}
                      onCancel={() => setConfirm(null)} />
                  ) : (
                    <button type="button" onClick={() => setConfirm("remove")} className="min-h-9 px-1 text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2">
                      {t("liveShare.public.multi.remove")}
                    </button>
                  )}
                </>
              ) : (
                <p className="text-xs text-slate-400">{t("liveShare.public.multi.tapHint")}</p>
              )}

              {unreachable && (
                <button type="button" onClick={() => { void refresh(); }}
                  className="w-full rounded-xl bg-slate-800 border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700">
                  {t("liveShare.public.retry")}
                </button>
              )}

              <AddRunner onToken={token => (list.some(r => r.token === token) ? pick(token, false) : setAdding(token))} />

              <div className="flex items-center justify-between gap-3 text-[11px] text-slate-500">
                <span>{t("liveShare.public.multi.savedHere")}</span>
                {confirm !== "forget" && (
                  <button type="button" onClick={() => setConfirm("forget")} className="shrink-0 min-h-9 px-1 underline underline-offset-2 hover:text-slate-300">
                    {t("liveShare.public.multi.forgetAll")}
                  </button>
                )}
              </div>
              {confirm === "forget" && (
                <ConfirmInline question={t("liveShare.public.multi.forgetQ")} confirm={t("liveShare.public.multi.forgetAll")}
                  onConfirm={() => { setList(forgetAllRunners()); setFocus(null); setConfirm(null); }}
                  onCancel={() => setConfirm(null)} />
              )}

              <div className="hidden @3xl:block"><LivePromo platform={platform} /></div>
            </div>
          </div>
        </div>
      </div>
      <div className="md:hidden"><PinnedPromo ended={false} onAbout={() => setAbout(true)} /></div>
      <footer className="hidden md:block px-4 py-3 border-t border-slate-800 text-center"
        style={{ paddingBottom: "calc(0.75rem + var(--safe-bottom))" }}>
        <a href={siteLink("footer")} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200">
          <BrandLogo size={10} />{t("liveShare.public.madeWith")}
        </a>
      </footer>
      {addSheet}
      {about && <AboutSheet platform={platform} onClose={() => setAbout(false)} />}
    </div>
  );
}
