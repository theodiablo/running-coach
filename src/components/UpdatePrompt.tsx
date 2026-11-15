import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Download, RotateCw, X } from "lucide-react";
import { PLAY_STORE_URL, APP_STORE_URL, UPDATE_DISMISSED_KEY } from "../constants";
import { isIos, isAndroid } from "../native";
import { completePlayUpdate, openAppStorePage, playUpdateInfo, startPlayUpdate } from "../storeBridge";
import type { AppUpdate } from "../utils/version";

// The store page, for when the store's own flow can't run. Android must NOT use
// @capacitor/browser: its Custom Tabs path only catches ActivityNotFoundException
// natively, so other launch failures kill the process. A plain top-frame
// navigation is handed to the OS as ACTION_VIEW (Play Store claims it).
async function openStore() {
  if (isAndroid) {
    window.location.assign(PLAY_STORE_URL);
    return;
  }
  if (isIos && await openAppStorePage()) return;
  const url = isIos ? APP_STORE_URL : PLAY_STORE_URL;
  if (!url) return;
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
  } catch { window.open(url, "_blank", "noopener"); }
}

// Play's own path: install a download it already has, else its immediate flow. True when Play ran.
async function playRequiredUpdate() {
  if ((await playUpdateInfo())?.status === "downloaded") { await completePlayUpdate(); return true; }
  const outcome = await startPlayUpdate(true);
  return outcome === "accepted" || outcome === "declined";
}

// The store page is the fallback whenever Play's flow didn't actually run.
async function updateNow() {
  if (isAndroid && await playRequiredUpdate()) return;
  await openStore();
}

// Hard gate below the minimum supported version: full-screen, non-dismissible.
// Android opens Play's immediate update over it. `pending`: the store has no
// version clearing the gate yet, so the button checks again rather than open a
// listing that only says "Open"; null while the stores are still being asked.
export function UpdateRequired({ pending = false, onRecheck }: { pending?: boolean | null; onRecheck?: () => Promise<void> }) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  useEffect(() => { if (isAndroid && pending === false) void playRequiredUpdate(); }, [pending]);
  const recheck = async () => {
    setChecking(true);
    try { await onRecheck?.(); } finally { setChecking(false); }
  };
  return (
    <div className="fixed inset-0 z-[3000] bg-slate-900 flex items-center justify-center p-6"
      style={{ paddingTop: "calc(1.5rem + var(--safe-top))", paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}>
      <div className="max-w-sm text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-2xl bg-orange-500/15 flex items-center justify-center">
          <Download className="text-orange-400" size={24} />
        </div>
        <h1 className="text-xl font-bold text-white">{t("app.update.requiredTitle")}</h1>
        <p className="text-sm text-slate-400">
          {pending ? t(isIos ? "app.update.pendingBodyIos" : "app.update.pendingBodyAndroid") : t("app.update.requiredBody")}
        </p>
        <button onClick={pending ? recheck : updateNow} disabled={checking || pending === null}
          className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-colors">
          {pending ? t("app.update.checkAgain") : t("app.update.updateNow")}
        </button>
        {pending && (
          <button onClick={openStore} className="text-sm font-medium text-slate-400 hover:text-slate-200 py-1">
            {t(isIos ? "app.update.openStoreIos" : "app.update.openStoreAndroid")}
          </button>
        )}
      </div>
    </div>
  );
}

// Soft update on Home. Play's own dialog is the prompt on Android, so this only
// follows the download it started and asks for the restart (never while a run
// records: the restart would end it). The store card is for iOS and for installs
// Play can't answer for, dismissible per version.
export function UpdateCard({ update, recorderOpen = false }: { update: AppUpdate; recorderOpen?: boolean }) {
  const { t } = useTranslation();
  const storeVersion = update.via === "store" ? update.version : null;
  const [dismissed, setDismissed] = useState(() => !!storeVersion && readDismissed() === storeVersion);
  const [restarting, setRestarting] = useState(false);
  const restart = () => { setRestarting(true); void completePlayUpdate().finally(() => setRestarting(false)); };

  if (update.via === "play") {
    if (update.status === "downloaded") {
      if (recorderOpen) return null;
      return (
        <Row icon={<RotateCw size={16} className="text-orange-400"/>}
          title={t("app.update.readyTitle")} sub={t("app.update.readyBody")}>
          <Action onClick={restart} disabled={restarting}>{t("app.update.restart")}</Action>
        </Row>
      );
    }
    if (update.status === "pending" || update.status === "downloading") {
      const pct = update.progress != null ? Math.round(update.progress * 100) : null;
      return (
        <Row icon={<Download size={16} className="text-orange-400"/>}
          title={t("app.update.downloading")} sub={pct != null ? `${pct}%` : t("app.update.downloadingBody")}>
          {pct != null && (
            <span className="w-14 h-1.5 rounded-full bg-slate-700 overflow-hidden flex-shrink-0 mr-2" aria-hidden>
              <span className="block h-full bg-orange-500 transition-[width]" style={{ width: `${pct}%` }}/>
            </span>
          )}
        </Row>
      );
    }
    return null;
  }

  if (dismissed || !storeVersion) return null;
  const dismiss = () => { writeDismissed(storeVersion); setDismissed(true); };
  return (
    <Row icon={<Download size={16} className="text-orange-400"/>}
      title={t("app.update.title")} sub={t("app.update.version", { version: storeVersion })}>
      <Action onClick={openStore}>{t("app.update.update")}</Action>
      <button onClick={dismiss} aria-label={t("app.update.dismiss")}
        className="p-2 -mr-1 text-slate-500 hover:text-slate-300 flex-shrink-0">
        <X size={15}/>
      </button>
    </Row>
  );
}

function Row({ icon, title, sub, children }: { icon: ReactNode; title: string; sub: string; children?: ReactNode }) {
  return (
    <div role="status" className="rounded-xl pl-3 pr-1.5 py-2.5 bg-slate-800/70 border border-slate-700/60 flex items-center gap-3">
      <span className="w-8 h-8 rounded-lg bg-orange-500/15 flex items-center justify-center flex-shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-100 truncate">{title}</p>
        <p className="text-xs text-slate-400 truncate">{sub}</p>
      </div>
      {children}
    </div>
  );
}

function Action({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex-shrink-0">
      {children}
    </button>
  );
}

function readDismissed() {
  try { return localStorage.getItem(UPDATE_DISMISSED_KEY); } catch { return null; }
}

function writeDismissed(version: string) {
  try { localStorage.setItem(UPDATE_DISMISSED_KEY, version); } catch { /* the card just returns next launch */ }
}
