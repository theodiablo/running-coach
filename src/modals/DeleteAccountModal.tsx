import { useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";
import { Trash2, AlertTriangle } from "lucide-react";
import { supabase } from "../supabase";
import { revokeAppleGrants } from "../auth/appleSignIn";

type DeleteAccountModalProps = { onSignOut: () => void; onClose: () => void };

export function DeleteAccountModal({ onSignOut, onClose }: DeleteAccountModalProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cancel is non-destructive, so back/Escape may dismiss — but never mid-delete.
  useDismissable(true, () => { if (!busy) onClose(); });

  const handleDelete = async () => {
    setBusy(true);
    setError(null);
    // Before the delete: the stored grants cascade away with the user row.
    await revokeAppleGrants((await supabase.auth.getSession()).data.session);
    const { error: rpcError } = await supabase.rpc("delete_my_account");
    if (rpcError) {
      setError(t("settings.deleteAccount.error"));
      setBusy(false);
      return;
    }
    await supabase.auth.signOut();
    onSignOut();
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 animate-overlay-fade"
      style={{ paddingTop: "calc(1rem + var(--safe-top))", paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
      <div className="bg-slate-800 rounded-2xl p-5 w-full max-w-sm space-y-4 animate-scale-in">
        <div className="flex items-center gap-3">
          <div className="bg-red-500/20 rounded-full p-2 shrink-0">
            <AlertTriangle size={20} className="text-red-400"/>
          </div>
          <p className="text-base font-semibold text-slate-100">{t("settings.deleteAccount.title")}</p>
        </div>

        <p className="text-sm text-slate-300">
          <Trans i18nKey="settings.deleteAccount.body" components={{ bold: <strong className="text-slate-100" /> }} />
        </p>

        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 rounded-xl px-3 py-2">{error}</p>
        )}

        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            onClick={onClose}
            disabled={busy}
            className="py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors disabled:opacity-40"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={handleDelete}
            disabled={busy}
            className="py-2.5 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-700 text-white flex items-center justify-center gap-2 transition-colors disabled:opacity-40"
          >
            {busy ? (
              <span className="animate-spin inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full"/>
            ) : (
              <><Trash2 size={14}/>{t("common.delete")}</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
