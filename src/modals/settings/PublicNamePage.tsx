import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader, X } from "lucide-react";
import { INPUT_CLS, LABEL_CLS } from "../../constants";
import { currentUserId } from "../../db";
import { fetchPublicName, normalizePublicName, publicNameIssue, savePublicName } from "../../publicName";
import { hideNameInFields } from "../../raceField";

// Settings › Account › Public name: the one name other runners can see, and only in a
// race field the runner chose to appear in by name (docs/race-field.md).
type PublicNamePageProps = {
  // undefined = not read; the page then offers a retry rather than an empty field.
  publicName: string | null | undefined;
  onSaved: (name: string | null) => void;
  showToast?: (msg: string, type?: string) => void;
};

const initials = (name: string) => name.split(/\s+/).map(w => [...w][0] || "").join("").slice(0, 2).toUpperCase();

export function PublicNamePage({ publicName, onSaved, showToast }: PublicNamePageProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(publicName ?? "");
  const [prev, setPrev] = useState(publicName);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  if (publicName !== prev) { setPrev(publicName); setDraft(publicName ?? ""); }

  const name = normalizePublicName(draft);
  const issue = name ? publicNameIssue(name) : null;
  const changed = name !== (publicName ?? "");

  const retry = async () => {
    const uid = currentUserId();
    if (!uid) return;
    setRetrying(true);
    const v = await fetchPublicName(uid);
    setRetrying(false);
    if (v !== undefined) onSaved(v);
  };

  const write = async (next: string | null) => {
    const uid = currentUserId();
    if (!uid) return;
    setSaving(true);
    const ok = (next !== null || await hideNameInFields(uid)) && await savePublicName(uid, next);
    setSaving(false);
    if (!ok) { showToast?.(t("settings.publicName.error"), "error"); return; }
    onSaved(next);
    showToast?.(t(next ? "settings.publicName.saved" : "settings.publicName.removed"));
  };

  if (publicName === undefined) {
    return (
      <div className="rounded-2xl bg-slate-800 p-4 space-y-3">
        <p className="text-sm text-slate-300">{t("settings.publicName.loadError")}</p>
        <button type="button" onClick={retry} disabled={retrying}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-sm font-semibold disabled:opacity-60">
          {retrying && <Loader size={14} className="animate-spin"/>}{t("settings.publicName.retry")}
        </button>
      </div>
    );
  }

  const shown = name || t("settings.publicName.placeholder");
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-300 leading-relaxed">{t("settings.publicName.intro")}</p>

      <div>
        <label htmlFor="public-name" className={LABEL_CLS}>{t("settings.publicName.label")}</label>
        <input id="public-name" value={draft} autoComplete="nickname"
          onChange={e => setDraft(e.target.value)} className={INPUT_CLS}
          aria-invalid={!!issue} aria-describedby="public-name-hint"/>
        <p id="public-name-hint" className={"text-xs mt-1.5 " + (issue ? "text-amber-300" : "text-slate-400")}>
          {issue ? t("settings.publicName.issue." + issue) : t("settings.publicName.hint")}
        </p>
      </div>

      <div className="rounded-2xl bg-slate-800 p-4 space-y-2">
        <p className="text-xs font-semibold text-slate-400">{t("settings.publicName.preview")}</p>
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-full bg-orange-700 text-orange-50 grid place-items-center text-sm font-extrabold">{initials(name)}</span>
          <span className="font-bold text-slate-100">{shown}</span>
        </div>
      </div>

      <div className="space-y-2.5">
        <p className="text-sm font-bold text-slate-300">{t("settings.publicName.whereTitle")}</p>
        <p className="flex gap-2.5 text-sm text-slate-200"><Check size={17} className="text-emerald-400 shrink-0 mt-0.5"/>{t("settings.publicName.whereYes")}</p>
        <p className="flex gap-2.5 text-sm text-slate-200"><X size={17} className="text-slate-400 shrink-0 mt-0.5"/>{t("settings.publicName.whereNo")}</p>
        <p className="text-xs text-slate-400">{t("settings.publicName.sameName")}</p>
      </div>

      <div className="space-y-2">
        <button type="button" onClick={() => write(name)} disabled={!name || !!issue || !changed || saving}
          className="w-full flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white py-3 rounded-xl text-sm font-bold transition-colors">
          {saving && <Loader size={15} className="animate-spin"/>}{t("settings.publicName.save")}
        </button>
        {publicName && (
          <button type="button" onClick={() => write(null)} disabled={saving}
            className="w-full py-2.5 text-sm font-semibold text-slate-400 hover:text-slate-200 disabled:opacity-40">
            {t("settings.publicName.remove")}
          </button>
        )}
        {publicName && <p className="text-xs text-slate-500 text-center">{t("settings.publicName.removeNote")}</p>}
      </div>
    </div>
  );
}
