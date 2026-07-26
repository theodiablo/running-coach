import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CloudOff, Loader } from "lucide-react";

// Shown when the user's app_state row could not be read (offline cold start,
// aborted request, PostgREST error).
//
// This screen exists because the alternative is far worse: falling through to
// the app with an empty store renders a signed-in user as a brand-new one,
// pushes them into onboarding, and the first write replaces their stored blob
// with the blank slate. The store stays read-only until a load succeeds
// (see `loaded` in db.ts), so the only way forward is a retry.
export function StoreLoadError({ onRetry, onSignOut }: { onRetry: () => void; onSignOut: () => void }) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);

  const retry = () => {
    setRetrying(true);
    onRetry();
  };

  return (
    <div className="fixed inset-0 z-[3000] bg-slate-900 flex items-center justify-center p-6"
      style={{ paddingTop: "calc(1.5rem + var(--safe-top))", paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}>
      <div className="max-w-sm text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-2xl bg-orange-500/15 flex items-center justify-center">
          <CloudOff className="text-orange-400" size={24} />
        </div>
        <h1 className="text-xl font-bold text-white">{t("app.storeError.title")}</h1>
        <p className="text-sm text-slate-400">{t("app.storeError.body")}</p>
        <button onClick={retry} disabled={retrying}
          className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2">
          {retrying && <Loader className="animate-spin" size={16} />}
          {t("app.storeError.retry")}
        </button>
        <button onClick={onSignOut} className="text-sm text-slate-400 hover:text-slate-200 underline">
          {t("app.storeError.signOut")}
        </button>
      </div>
    </div>
  );
}
