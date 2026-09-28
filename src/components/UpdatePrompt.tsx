import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, X } from "lucide-react";
import { PLAY_STORE_URL, APP_STORE_URL, UPDATE_DISMISSED_KEY } from "../constants";
import { isIos, isAndroid } from "../native";

// The platform's own store listing; empty when unknown (APP_STORE_URL is blank
// until the App Store record exists), in which case the buttons hide rather
// than dead-link — the copy still tells the user to update.
const storeUrl = () => (isIos ? APP_STORE_URL : PLAY_STORE_URL);

// Open the store listing.
// Android must NOT go through @capacitor/browser: its Chrome Custom Tabs path
// (an extra translucent BrowserControllerActivity + custom-tabs service
// binding) only catches ActivityNotFoundException natively, so any other
// runtime failure launching the tab kills the process — tapping "Update"
// crashed the app on-device. A plain top-frame navigation is intercepted by
// Capacitor's WebViewClient (Bridge.launchIntent): external hosts never load
// in the WebView, they're handed to the OS as an ACTION_VIEW intent — which
// the Play Store app claims for its own listing URL — with
// ActivityNotFoundException caught inside Capacitor. No plugin, no extra
// activity, and the store opens as the app, not a browser tab.
// iOS keeps Browser.open (SFSafariViewController, same as the OAuth flow),
// falling back to a normal new tab.
async function openStore() {
  const url = storeUrl();
  if (!url) return;
  if (isAndroid) {
    window.location.assign(url);
    return;
  }
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
  } catch { window.open(url, "_blank", "noopener"); }
}

// Hard gate: the installed app is below the minimum supported version (e.g. after
// a breaking backend change). Full-screen and non-dismissible — the user must
// update to continue.
export function UpdateRequired() {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[3000] bg-slate-900 flex items-center justify-center p-6"
      style={{ paddingTop: "calc(1.5rem + var(--safe-top))", paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}>
      <div className="max-w-sm text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-2xl bg-orange-500/15 flex items-center justify-center">
          <Download className="text-orange-400" size={24} />
        </div>
        <h1 className="text-xl font-bold text-white">{t("app.update.requiredTitle")}</h1>
        <p className="text-sm text-slate-400">
          {t("app.update.requiredBody")}
        </p>
        {storeUrl() && (
          <button onClick={openStore}
            className="w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-3 rounded-xl transition-colors">
            {t("app.update.updateNow")}
          </button>
        )}
      </div>
    </div>
  );
}

// Soft nudge: a newer version is available but the current one still works. A
// Home card, never an overlay, so it can't cover the header or a recording.
// Dismissal is per device and per version: the card returns only for a newer one.
export function UpdateCard({ version }: { version: string }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(() => readDismissed() === version);
  if (dismissed) return null;
  const dismiss = () => { writeDismissed(version); setDismissed(true); };
  return (
    <div role="status" className="rounded-xl p-3.5 border border-orange-500/35 bg-slate-800 space-y-3">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-xl bg-orange-500/15 flex items-center justify-center flex-shrink-0">
          <Download className="text-orange-400" size={18}/>
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">{t("app.update.title", { version })}</p>
          <p className="text-xs text-slate-400">{t(isIos ? "app.update.bodyIos" : "app.update.bodyAndroid")}</p>
        </div>
        <button onClick={dismiss} aria-label={t("app.update.dismiss")}
          className="p-1 -mr-1 -mt-1 text-slate-500 hover:text-slate-300 flex-shrink-0">
          <X size={16}/>
        </button>
      </div>
      <div className="flex gap-2 pl-12">
        {storeUrl() && (
          <button onClick={openStore}
            className="bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors">
            {t("app.update.update")}
          </button>
        )}
        <button onClick={dismiss}
          className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-semibold px-4 py-2 rounded-lg transition-colors">
          {t("app.update.later")}
        </button>
      </div>
    </div>
  );
}

function readDismissed() {
  try { return localStorage.getItem(UPDATE_DISMISSED_KEY); } catch { return null; }
}

function writeDismissed(version: string) {
  try { localStorage.setItem(UPDATE_DISMISSED_KEY, version); } catch { /* the card just returns next launch */ }
}
