import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RecorderSheet } from "../components/RecorderSheet";
import { ToggleSwitch } from "../components/ToggleSwitch";

// Live sharing's detail behind the recorder row (docs/live-sharing.md): the
// same switch as the row, plus the standing link and what it means. Usable
// before and during a run — taking a run off the air mid-run is the point.
export function LiveShareSheet({ on, onToggle, onClose, children }: {
  on: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** The link block (create / send / replace), owned by the recorder. */
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <RecorderSheet title={t("liveShare.toggle.label")} onClose={onClose}
      headerRight={<ToggleSwitch on={on} onToggle={onToggle} label={t("liveShare.toggle.label")} />}>
      <p className="text-xs text-slate-400 leading-snug">{t("liveShare.toggle.hint")}</p>
      {children}
    </RecorderSheet>
  );
}
