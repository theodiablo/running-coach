import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Calendar, ChevronDown, PersonStanding, TrendingUp } from "lucide-react";
import { PlanInfoBody } from "../../components/PlanInfo";
import { PredictionsInfoBody } from "../../components/PredictionsInfo";
import { StretchInfoBody } from "../../components/StretchInfo";

type Topic = { id: string; Icon: typeof Calendar; title: string; body: ReactNode };

// Help & FAQ: the app's explainers gathered in one place. Each topic is the
// same body its in-context "info" link opens, so the two never drift.
export function HelpPage() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const topics: Topic[] = [
    { id: "plan", Icon: Calendar, title: t("settings.help.plan"), body: <PlanInfoBody/> },
    { id: "predictions", Icon: TrendingUp, title: t("settings.help.predictions"), body: <PredictionsInfoBody/> },
    { id: "stretching", Icon: PersonStanding, title: t("settings.help.stretching"), body: <StretchInfoBody/> },
  ];
  return (
    <>
      <p className="text-sm text-slate-400">{t("settings.help.intro")}</p>
      <div className="space-y-2.5">
        {topics.map(({ id, Icon, title, body }) => {
          const expanded = open === id;
          return (
            <div key={id} className="bg-slate-800 rounded-2xl overflow-hidden">
              <button type="button" onClick={() => setOpen(expanded ? null : id)} aria-expanded={expanded}
                className="w-full flex items-center gap-3 p-4 text-left hover:bg-slate-700/40 transition-colors">
                <Icon size={18} className="text-orange-400 shrink-0"/>
                <span className="flex-1 flex items-center gap-2 text-sm font-semibold text-slate-200">{title}</span>
                <ChevronDown size={16} className={"text-slate-500 shrink-0 transition-transform " + (expanded ? "rotate-180" : "")}/>
              </button>
              {expanded && <div className="px-4 pb-4 space-y-4 text-sm text-slate-300 leading-relaxed">{body}</div>}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-500">{t("settings.help.more")}</p>
    </>
  );
}
