import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Users } from "lucide-react";
import { currentUserId } from "../../db";
import { fetchMyMembership, fetchRaceField, setFieldChoice } from "../../raceField";
import type { FieldChoice, MyMembership, RaceFieldState } from "../../raceField";
import { FieldJoinSheet } from "../../modals/FieldJoinSheet";
import { FieldListSheet } from "../../modals/FieldListSheet";

// "9 app runners in this field" on the race page, and the door to joining it
// (docs/race-field.md). Fetched on every open, held only while the page is up.
type RaceFieldCardProps = {
  editionId: string;
  // On the runner's list: only then can they join.
  listed: boolean;
  // Open the join sheet straight away (the race was just added and hasn't been asked).
  ask: boolean;
  // undefined = not read: no join or change until it is, or a named choice would be lost.
  publicName: string | null | undefined;
  goalSec: number | null;
  onAsked: () => void;
  onSetName: () => void;
  showToast?: (msg: string, type?: string) => void;
};

type Loaded = { editionId: string; field: RaceFieldState | null; mine: MyMembership | null | undefined };

export function RaceFieldCard({ editionId, listed, ask, publicName, goalSec, onAsked, onSetName, showToast }: RaceFieldCardProps) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [nonce, setNonce] = useState(0);
  const [sheet, setSheet] = useState(false);
  const [list, setList] = useState(false);
  const [prevAsk, setPrevAsk] = useState(false);
  if (ask !== prevAsk) {
    setPrevAsk(ask);
    if (ask) setSheet(true);
  }

  useEffect(() => {
    let alive = true;
    const uid = currentUserId();
    void Promise.all([fetchRaceField(editionId), uid && listed ? fetchMyMembership(uid, editionId) : Promise.resolve(null)])
      .then(([field, mine]) => { if (alive) setLoaded({ editionId, field, mine }); });
    return () => { alive = false; };
  }, [editionId, listed, nonce]);

  const state = loaded?.editionId === editionId ? loaded : null;
  const field = state?.field ?? null;
  const mine = state?.mine;
  const joined = !!mine;
  const others = field?.open && field.count != null ? field.count - (joined ? 1 : 0) : null;

  const closeSheet = () => { setSheet(false); onAsked(); };
  const save = async (choice: FieldChoice, showGoal: boolean) => {
    const uid = currentUserId();
    if (!uid || mine === undefined) { showToast?.(t("races.field.toast.error"), "error"); return false; }
    const result = await setFieldChoice(uid, editionId, choice, showGoal ? goalSec : null, mine);
    if (result !== "ok") {
      showToast?.(t("races.field.toast." + result), "error");
      return false;
    }
    setNonce(n => n + 1);
    return true;
  };

  // A failed read (field or membership) hides the card rather than guess or offer a second join.
  if (!state || !field) return null;
  const canChange = listed && mine !== undefined && publicName !== undefined;
  if (!field.open && !canChange) return null;
  // The server only fills the list for a runner who joined; the flag is its own answer.
  const canSeeList = field.open && field.joined;

  return (
    <div className="rounded-2xl bg-slate-800 border border-slate-700 p-4 space-y-2.5">
      <div className="flex items-center gap-3">
        <span className="w-9 h-9 shrink-0 rounded-full bg-sky-500/15 text-sky-300 grid place-items-center"><Users size={17}/></span>
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-100">
            {field.open ? t("races.field.card.count", { count: field.count ?? 0 }) : t("races.field.card.title")}
          </p>
          {field.open && joined && <p className="text-xs text-slate-300">{t("races.field.card.youreIn")}</p>}
        </div>
      </div>
      <p className="text-xs text-slate-400 leading-snug">
        {field.open ? t(field.joined ? "races.field.card.bodyJoined" : "races.field.card.body") : joined ? t("races.field.card.waiting") : t("races.field.card.invite")}
      </p>
      {(canChange || canSeeList) && (
        <div className="flex flex-wrap gap-2">
          {canSeeList && (
            <button type="button" onClick={() => setList(true)}
              className="min-h-[40px] px-3.5 rounded-xl bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 text-xs font-bold transition-colors">
              {t("races.field.card.seeList")}
            </button>
          )}
          {canChange && (
            <button type="button" onClick={() => setSheet(true)}
              className="min-h-[40px] px-3.5 rounded-xl border border-slate-600 hover:border-slate-400 text-slate-200 text-xs font-bold transition-colors">
              {joined ? t("races.field.card.change") : t("races.field.card.join")}
            </button>
          )}
        </div>
      )}
      {list && canSeeList && (
        <FieldListSheet editionId={editionId} count={field.count ?? 0} named={field.named} goalSec={goalSec}
          onChange={() => { setList(false); if (canChange) setSheet(true); }} onClose={() => setList(false)} showToast={showToast}/>
      )}
      {sheet && canChange && (
        <FieldJoinSheet publicName={publicName ?? null} current={mine ?? null} others={others} hasGoal={!!goalSec}
          onSetName={() => { closeSheet(); onSetName(); }} onDone={save} onClose={closeSheet}/>
      )}
    </div>
  );
}
