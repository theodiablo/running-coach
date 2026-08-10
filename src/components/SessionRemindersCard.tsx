import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BellRing } from "lucide-react";
import { isNative } from "../native";
import { INPUT_CLS, LABEL_CLS, SESSION_NOTIF_DISCLOSED_KEY } from "../constants";
import { fmt, ymd } from "../utils/format";
import { DEFAULT_REMINDER_PREFS, nextReminderPreview, prefsFrom } from "../utils/sessionReminders";
import { hasReminderGrant, refreshReminderGrant, requestReminderPermission } from "../notify/sessionReminders";
import { SessionReminderDisclosure } from "../modals/SessionReminderDisclosure";
import type { Plan, SettingsState } from "../types";

type SessionRemindersCardProps = {
  settings: SettingsState;
  saveSettings: (settings: SettingsState) => void;
  plan: Plan | null;
};

const marker = (key: string) => {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
};
const setMarker = (key: string) => {
  try { localStorage.setItem(key, "1"); } catch { /* storage unavailable */ }
};

// Plan-session reminders. Native shells only: on web the whole card is absent
// rather than disabled, because there is nothing a browser user could do with it
// (docs/reminders.md). The preference is synced; the OS grant is per-device, so
// enabling on a second phone re-runs the disclosure and the prompt there.
export function SessionRemindersCard({ settings, saveSettings, plan }: SessionRemindersCardProps) {
  const { t } = useTranslation();
  const [showDisclosure, setShowDisclosure] = useState(false);
  const [denied, setDenied] = useState(false);
  // Cached for first paint, then reconciled against the OS — the runner may have
  // revoked notifications in system settings since we last looked.
  const [granted, setGranted] = useState(hasReminderGrant);
  useEffect(() => { void refreshReminderGrant().then(setGranted); }, []);
  if (!isNative) return null;

  const prefs = prefsFrom(settings);
  // The synced preference alone is NOT enough to call these on. It arrives true
  // on a freshly installed second phone, where no OS grant exists and nothing is
  // scheduled — showing "on" there would offer only "turn off", leaving the
  // runner no way to reach the permission prompt, under a card claiming a next
  // reminder that can never fire.
  const on = prefs.enabled && granted;
  const preview = on ? nextReminderPreview(plan, prefs, new Date()) : null;

  const enable = async () => {
    setDenied(false);
    const ok = granted || await requestReminderPermission();
    setGranted(ok);
    if (!ok) { setDenied(true); return; }
    if (!prefs.enabled) saveSettings({ ...settings, sessionReminders: true });
  };

  const onToggle = () => {
    if (on) { saveSettings({ ...settings, sessionReminders: false }); return; }
    if (!marker(SESSION_NOTIF_DISCLOSED_KEY)) { setShowDisclosure(true); return; }
    void enable();
  };

  return (
    <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
      <div className="flex items-start gap-2">
        <BellRing size={16} className="text-orange-400 flex-shrink-0 mt-0.5"/>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-200">{t("reminders.settings.title")}</p>
          <p className="text-xs text-slate-400 mt-1">{t("reminders.settings.subtitle")}</p>
        </div>
      </div>

      <label className="flex items-center justify-between gap-3 cursor-pointer">
        <span className="text-sm text-slate-300">{t("reminders.settings.toggle")}</span>
        <input type="checkbox" checked={on} onChange={onToggle}
          className="w-4 h-4 accent-orange-500 flex-shrink-0"/>
      </label>

      {denied && (
        <p className="text-xs text-amber-300 leading-snug">{t("reminders.settings.denied")}</p>
      )}

      {on && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS} htmlFor="reminder-time">{t("reminders.settings.time")}</label>
              <input id="reminder-time" type="time" value={prefs.time} className={INPUT_CLS}
                onChange={e => saveSettings({ ...settings, reminderTime: e.target.value || DEFAULT_REMINDER_PREFS.time })}/>
            </div>
            <div>
              <label className={LABEL_CLS} htmlFor="reminder-lead">{t("reminders.settings.lead")}</label>
              <select id="reminder-lead" value={String(prefs.leadDays)} className={INPUT_CLS}
                onChange={e => saveSettings({ ...settings, reminderLeadDays: e.target.value === "0" ? 0 : 1 })}>
                <option value="1">{t("reminders.settings.leadEveningBefore")}</option>
                <option value="0">{t("reminders.settings.leadMorningOf")}</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-slate-500">
            {preview
              ? t("reminders.settings.nextUp", {when: fmt.sht(ymd(preview)) + " · " + prefs.time})
              : t("reminders.settings.nonePlanned")}
          </p>
        </>
      )}

      {showDisclosure && (
        <SessionReminderDisclosure
          onCancel={() => setShowDisclosure(false)}
          onAccept={() => { setMarker(SESSION_NOTIF_DISCLOSED_KEY); setShowDisclosure(false); void enable(); }}/>
      )}
    </div>
  );
}
