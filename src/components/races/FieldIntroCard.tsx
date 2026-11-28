import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Users } from "lucide-react";
import { currentUserId } from "../../db";
import { listKnownRaces } from "../../races";
import { fetchMyMembership, fetchRaceField, setFieldChoice } from "../../raceField";
import type { FieldChoice } from "../../raceField";
import { FieldJoinSheet } from "../../modals/FieldJoinSheet";
import { useSeenOnScreen } from "../../hooks/useSeenOnScreen";

// The race field's one-time Home intro (docs/race-field.md, Decisions 5): the first verified,
// upcoming race on the list whose field the runner hasn't joined. Renders nothing until that
// is known, and nothing at all when no race qualifies.
type FieldIntroCardProps = {
  candidates: string[];
  // Goal per edition, offered under "show my goal time".
  goals: Record<string, number | null>;
  publicName: string | null | undefined;
  onSeen: () => void;
  onSetName: () => void;
  showToast: (msg: string, type?: string) => void;
};

type Offer = { editionId: string; name: string; others: number | null };

export function FieldIntroCard({ candidates, goals, publicName, onSeen, onSetName, showToast }: FieldIntroCardProps) {
  const { t } = useTranslation();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [sheet, setSheet] = useState(false);
  const [gone, setGone] = useState(false);
  const key = candidates.join(",");
  const onSeenRef = useRef(onSeen);
  useEffect(() => { onSeenRef.current = onSeen; });

  useEffect(() => {
    let alive = true;
    const uid = currentUserId();
    if (!uid || !key) return;
    void (async () => {
      const ids = key.split(",");
      const races = await listKnownRaces({ editionIds: ids }).catch(() => []);
      for (const id of ids) {
        const race = races.find(r => r.editions.some(e => e.id === id && e.verified === true));
        if (!race) continue;
        const mine = await fetchMyMembership(uid, id);
        if (mine === undefined) return;
        // Already in a field: they've met the feature, so the intro is spent.
        if (mine) { if (alive) onSeenRef.current(); return; }
        const field = await fetchRaceField(id);
        if (!field || !alive) return;
        setOffer({ editionId: id, name: race.name, others: field.open ? field.count : null });
        return;
      }
    })();
    return () => { alive = false; };
  }, [key]);

  const seenRef = useSeenOnScreen<HTMLDivElement>(!!offer && !gone, onSeen);

  if (!offer || gone || publicName === undefined) return null;
  const goalSec = goals[offer.editionId] ?? null;
  const close = () => { setSheet(false); setGone(true); onSeen(); };
  const save = async (choice: FieldChoice, showGoal: boolean) => {
    const uid = currentUserId();
    if (!uid) { showToast(t("races.field.toast.error"), "error"); return false; }
    const result = await setFieldChoice(uid, offer.editionId, choice, showGoal ? goalSec : null, null);
    if (result !== "ok") { showToast(t("races.field.toast." + result), "error"); return false; }
    return true;
  };

  return (
    <div ref={seenRef} className="rounded-2xl bg-slate-800 border border-sky-500/30 p-4 space-y-2.5">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 shrink-0 rounded-full bg-sky-500/15 text-sky-300 grid place-items-center"><Users size={17}/></span>
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-100">
            {offer.others != null ? t("races.field.intro.titleOpen", { count: offer.others, race: offer.name }) : t("races.field.intro.titleFirst", { race: offer.name })}
          </p>
          <p className="text-xs text-slate-400 leading-snug mt-0.5">{t("races.field.intro.body")}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setSheet(true)}
          className="min-h-[40px] px-3.5 rounded-xl bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 text-xs font-bold transition-colors">
          {t("races.field.intro.choose")}
        </button>
        <button type="button" onClick={() => { setGone(true); onSeen(); }}
          className="min-h-[40px] px-3.5 rounded-xl text-slate-400 hover:text-slate-200 text-xs font-semibold">
          {t("races.field.intro.notNow")}
        </button>
      </div>
      {sheet && (
        <FieldJoinSheet publicName={publicName} current={null} others={offer.others} hasGoal={!!goalSec}
          onSetName={() => { close(); onSetName(); }} onDone={save} onClose={close}/>
      )}
    </div>
  );
}
