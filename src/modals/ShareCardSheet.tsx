import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, X } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { dayName } from "../i18n";
import { fmt, ymd } from "../utils/format";
import { planPhase } from "../utils/planPhase";
import { catalogueRaceLabel } from "../utils/races";
import { APP_STORE_URL } from "../constants";
import { isCrossTraining } from "../types";
import { cardStyles, numberModel, routeModel, weekModel } from "../share/cardModel";
import type { CardInput, CardStyle, Stat } from "../share/cardModel";
import { routeShape } from "../share/routeShape";
import { CARD_H, CARD_W, ROUTE_BOX, ROUTE_STROKE, drawCard } from "../share/drawCard";
import type { CardView, TFn } from "../share/drawCard";
import { loadCardFonts } from "../share/fonts";
import { opensShareSheet, shareImage, shareLink } from "../share/shareImage";
import type { TrackPointOrGap } from "../utils/geo";
import type { Participation, Plan, PlanSession, Run, SettingsState } from "../types";

export type ShareCardProps = {
  run: Run;
  runs: Run[];
  plan: Plan | null | undefined;
  settings: SettingsState;
  participations: Participation[] | null | undefined;
  // The run's trace on its moving clock; null when it has none (manual, indoor, HR-only).
  points: TrackPointOrGap[] | null | undefined;
  // Finish screen only: the plan session the recorder was opened from.
  session?: PlanSession | null;
  showToast?: (msg: string, type?: string) => void;
  onClose: () => void;
};

const PREVIEW_W = 190;
const PREVIEW_H = (PREVIEW_W * CARD_H) / CARD_W;
const EXPORT_SCALE = 3;

const statText = (t: TFn, s: Stat) => `${t(s.label.key)} ${s.value}${s.unit ? " " + s.unit : ""}`;

function Toggle({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white">{label}</p>
        <p className="text-xs text-slate-400">{hint}</p>
      </div>
      <button type="button" aria-pressed={on} aria-label={label} onClick={() => onChange(!on)}
        className={"shrink-0 w-12 h-7 rounded-full p-0.5 flex transition-colors " + (on ? "bg-orange-500 justify-end" : "bg-slate-600 justify-start")}>
        <span className="w-6 h-6 rounded-full bg-white block" />
      </button>
    </div>
  );
}

// The share builder: one preview, the offered styles, a few switches, one button.
// docs/share-card.md ("The builder").
export function ShareCardSheet({ run, runs, plan, settings, participations, points, session, showToast, onClose }: ShareCardProps) {
  const { t } = useTranslation();
  const tf: TFn = (key, vars) => t(key, vars ?? {});
  useDismissable(true, onClose);
  const today = ymd(new Date());
  const indoor = isCrossTraining(run) || !(Number(run.km) > 0);

  const raceLabel = useMemo(() => {
    const info = plan ? planPhase({ plan, settings, participations, runs }, today) : null;
    return info?.race && info.catalogue ? catalogueRaceLabel(info.race.editionId, participations, "") || null : null;
  }, [plan, settings, participations, runs, today]);

  // Start and finish are always hidden: most runs start at a front door. docs/share-card.md.
  const masked = useMemo(() => routeShape(indoor ? null : points, { box: ROUTE_BOX, mask: true, strokePx: ROUTE_STROKE }), [points, indoor]);

  const input: CardInput = { run, runs, plan, settings, participations, today, session, hasRoute: !!masked, raceLabel };
  const { offered, preselected } = cardStyles(input);
  const [picked, setStyle] = useState<CardStyle>(preselected);
  const style = offered.includes(picked) ? picked : preselected;
  const [showRoute, setShowRoute] = useState(true);
  const [showPace, setShowPace] = useState(true);
  const [showHr, setShowHr] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const view: CardView = (() => {
    const date = fmt.sht(run.date);
    if (style === "route") {
      return { style, t: tf, date, showRoute, shape: masked, model: routeModel(input, showPace, showHr),
        footer: { key: APP_STORE_URL ? "shareCard.footerStores" : "shareCard.footer" } };
    }
    const week = style === "week" ? weekModel(input, showPace, showHr) : null;
    if (week) {
      const [figure, ...rest] = week.stats;
      return { style: "week", t: tf, model: week, dayLabels: Array.from({ length: 7 }, (_, i) => dayName(i)),
        runFigure: indoor ? fmt.dur(run.durationSec) : figure.value + (figure.unit ? " " + figure.unit : ""),
        runLine: (indoor ? week.stats.slice(1) : rest).map(s => s.value + (s.unit ? " " + s.unit : "")).join(" · ") };
    }
    return { style: "number", t: tf, date, model: numberModel(input, showPace, showHr) };
  })();

  useEffect(() => {
    let alive = true;
    void loadCardFonts().then(() => { if (alive) setFontsReady(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !fontsReady) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(PREVIEW_W * dpr);
    canvas.height = Math.round(PREVIEW_H * dpr);
    drawCard(ctx, view, (PREVIEW_W * dpr) / CARD_W);
  });

  const summary = (() => {
    const lead: string[] = [];
    if (view.style === "number") {
      const m = view.model;
      if (m.tag) lead.push(t(m.tag.key, m.tag.vars ?? {}));
      lead.push([m.label ? t(m.label.key) : "", m.figure + (m.unit ? " " + m.unit : "")].filter(Boolean).join(" "));
      if (m.context) lead.push(t(m.context.key, m.context.vars ?? {}));
    } else if (view.style === "week") {
      const m = view.model;
      lead.push(m.header.kind === "race" ? m.header.title || t("shareCard.week.myRace") : t("shareCard.week.block", { block: m.header.block }));
      if (m.header.kind === "race") lead.push(m.header.daysToGo === 0 ? t("shareCard.week.raceDay") : t("shareCard.week.daysToGo", { count: m.header.daysToGo }));
      lead.push(t("shareCard.week.weekOf", { n: m.weekN, m: m.weekM }), t("shareCard.week.summary", { done: m.done, planned: m.planned, km: m.weekKm }));
    } else {
      lead.push(t(view.model.headline.key));
      if (view.model.pill) lead.push(t("shareCard.route.pill", { dist: t(view.model.pill.dist), time: view.model.pill.time }));
    }
    const parts = [t(`shareCard.styles.${style}`), ...lead, ...view.model.stats.map(s => statText(tf, s))];
    if (view.style === "route" && view.showRoute && view.shape) parts.push(t("shareCard.toggles.route"));
    return parts.join(", ");
  })();

  const share = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = CARD_W * EXPORT_SCALE;
      canvas.height = CARD_H * EXPORT_SCALE;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      // Fonts settled before Share was enabled: awaiting a retry here would outlast the tap's activation.
      drawCard(ctx, view, EXPORT_SCALE);
      const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, "image/png"));
      if (!blob) throw new Error("no image");
      const result = await shareImage(blob, `run-${run.date}.png`, t("shareCard.shareText", { url: shareLink(style) }));
      if (result === "failed") showToast?.(t("shareCard.failed"), "err");
      else if (result === "saved") showToast?.(t("shareCard.saved"));
    } catch {
      showToast?.(t("shareCard.failed"), "err");
    } finally {
      setBusy(false);
    }
  };

  const chip = (on: boolean) => "min-h-11 rounded-xl text-sm font-semibold border transition-colors "
    + (on ? "border-orange-500 bg-orange-500/10 text-orange-300" : "border-slate-700 text-slate-300");

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="share-card-title"
      onClick={e => e.stopPropagation()}
      className="fixed inset-0 z-[2050] bg-slate-900 flex flex-col animate-slide-up"
      style={{ paddingTop: "calc(1rem + var(--safe-top))", paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
      <div className="flex-1 overflow-y-auto px-4 max-w-md w-full mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h2 id="share-card-title" className="text-xl font-extrabold text-white">{t("shareCard.title")}</h2>
          <button type="button" onClick={onClose} aria-label={t("common.close")}
            className="w-11 h-11 rounded-full bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center">
            <X size={18} aria-hidden />
          </button>
        </div>

        <canvas ref={canvasRef} role="img" aria-label={t("shareCard.preview", { summary })}
          className="mx-auto block rounded-2xl shadow-2xl bg-slate-950"
          style={{ width: PREVIEW_W, height: PREVIEW_H }} />
        {view.style === "route" && view.showRoute && view.shape && (
          <p className="flex items-start justify-center gap-1.5 text-xs text-slate-400 text-center">
            <ShieldCheck size={14} className="shrink-0 mt-px text-slate-500" aria-hidden />
            {t("shareCard.privacyNote")}
          </p>
        )}

        <div role="group" aria-label={t("shareCard.styleGroup")}
          className="grid gap-2" style={{ gridTemplateColumns: `repeat(${offered.length}, minmax(0, 1fr))` }}>
          {offered.map(s => (
            <button key={s} type="button" aria-pressed={style === s} onClick={() => setStyle(s)} className={chip(style === s)}>
              {t(`shareCard.styles.${s}`)}
            </button>
          ))}
        </div>

        <div className="rounded-2xl bg-slate-800 divide-y divide-slate-900">
          {style === "route" && (
            <Toggle label={t("shareCard.toggles.route")} hint={t("shareCard.toggles.routeHint")} on={showRoute} onChange={setShowRoute} />
          )}
          {!indoor && <Toggle label={t("shareCard.toggles.pace")} hint={t("shareCard.toggles.paceHint")} on={showPace} onChange={setShowPace} />}
          {indoor && !!run.hr && <Toggle label={t("shareCard.toggles.hr")} hint={t("shareCard.toggles.hrHint")} on={showHr} onChange={setShowHr} />}
        </div>
      </div>
      <div className="px-4 pt-3 max-w-md w-full mx-auto">
        <button type="button" onClick={() => void share()} disabled={busy || !fontsReady}
          className="w-full min-h-[52px] rounded-2xl bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-slate-950 font-extrabold">
          {busy || !fontsReady ? t("shareCard.preparing") : t(opensShareSheet() ? "shareCard.share" : "shareCard.download")}
        </button>
      </div>
    </div>
  );
}

export default ShareCardSheet;
