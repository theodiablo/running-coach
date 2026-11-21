import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Plus } from "lucide-react";
import { INPUT_CLS, LABEL_CLS } from "../../constants";
import { durToSec } from "../../utils/runForm";
import { DurationInput } from "../DurationInput";
import type { JoinedEdition } from "../../types";

// A participation's catalogue edition, or the snapshot standing in for one the catalogue lost.
export type JoinedRace = Omit<Partial<JoinedEdition>, "edition"> & {
  name: string;
  raceId: string;
  edition: JoinedEdition["edition"];
  orphan?: boolean;
};

// Amber "this is user-submitted" tag for any unverified race/edition.
export function UnverifiedTag() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-300 bg-amber-500/10 border border-amber-500/25 px-1.5 py-0.5 rounded-md">
      <AlertTriangle size={10}/>{t("races.unverifiedTag")}
    </span>
  );
}

type ResultFormProps = {
  joined: JoinedRace;
  onSave: (joined: JoinedRace, timeSec: number, notes: string, alsoLog: boolean) => void;
  onCancel: () => void;
};

// Finish time for a race done. Also adds a RACE run by default, so the result reaches History,
// Stats and predictions.
export function ResultForm({ joined, onSave, onCancel }: ResultFormProps) {
  const { t } = useTranslation();
  const [dur, setDur] = useState("");
  const [notes, setNotes] = useState("");
  const [alsoLog, setAlsoLog] = useState(true);
  const id = "race-result-" + joined.edition.id;

  const submit = () => {
    const sec = durToSec(dur);
    if (!sec) return;
    onSave(joined, sec, notes, alsoLog);
  };

  return (
    <div className="mt-3 pt-3 border-t border-slate-700/50 space-y-3 w-full">
      <div>
        <label className={LABEL_CLS} htmlFor={id}>{t("races.result.finishTime")}</label>
        <DurationInput id={id} value={dur} onChange={setDur} placeholder={t("races.goal.placeholder")}
          className={INPUT_CLS + " text-lg font-semibold tabular-nums text-center"}/>
      </div>
      <input value={notes} onChange={e => setNotes(e.target.value)} placeholder={t("races.result.notesPlaceholder")} className={INPUT_CLS}/>
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={alsoLog} onChange={e => setAlsoLog(e.target.checked)} className="accent-orange-500"/>
        {t("races.result.alsoLog")}
      </label>
      <div className="flex gap-2">
        <button onClick={submit} disabled={!durToSec(dur)}
          className="flex-1 flex items-center justify-center gap-1.5 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white py-2 rounded-xl text-sm font-semibold transition-colors">
          <Plus size={14}/>{t("races.result.save")}
        </button>
        <button onClick={onCancel} className="px-3 text-sm text-slate-400 hover:text-slate-200">{t("common.cancel")}</button>
      </div>
    </div>
  );
}

// Inline "report this race" form → race_reports + maintainer notification.
const REPORT_REASONS = [
  { value: "Wrong date", key: "wrongDate" },
  { value: "Wrong distance / details", key: "wrongDistance" },
  { value: "Duplicate", key: "duplicate" },
  { value: "Doesn't exist / spam", key: "spam" },
  { value: "Other", key: "other" },
];
type ReportFormProps = { onSubmit: (reason: string, note: string) => void; onCancel: () => void };

export function ReportForm({ onSubmit, onCancel }: ReportFormProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState(REPORT_REASONS[0].value);
  const [note, setNote] = useState("");
  return (
    <div className="space-y-2">
      <label className={LABEL_CLS}>{t("races.report.title")}</label>
      <select value={reason} onChange={e => setReason(e.target.value)} className={INPUT_CLS}>
        {REPORT_REASONS.map(r => <option key={r.value} value={r.value}>{t("races.report.reasons." + r.key)}</option>)}
      </select>
      <input value={note} onChange={e => setNote(e.target.value)} placeholder={t("races.report.notePlaceholder")} className={INPUT_CLS}/>
      <div className="flex gap-2">
        <button onClick={() => onSubmit(reason, note)}
          className="flex-1 bg-orange-500 hover:bg-orange-600 text-white py-2 rounded-xl text-sm font-semibold transition-colors">
          {t("races.report.send")}
        </button>
        <button onClick={onCancel} className="px-3 text-sm text-slate-400 hover:text-slate-200">{t("common.cancel")}</button>
      </div>
    </div>
  );
}
