import { useEffect, useRef } from "react";
import { pushDismiss } from "../utils/backDismiss";

// Registers an overlay's dismiss handler on the global back-dismiss stack while `active`,
// so Escape / Android back closes it. Most modals pass `active={true}`; an always-mounted
// body with internal open-state (e.g. InfoButton) passes its open flag. `onDismiss` is read
// through a ref so an inline closure doesn't churn (and reorder) the stack entry.
export function useDismissable(active: boolean, onDismiss: () => void) {
  const ref = useRef(onDismiss);
  useEffect(() => {
    ref.current = onDismiss;
  });
  useEffect(() => {
    if (!active) return;
    return pushDismiss(() => ref.current());
  }, [active]);
}
