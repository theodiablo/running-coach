import { useState } from "react";
import { runFitsSession } from "../utils/sessionMatch";
import type { RunPrefill } from "../utils/runPrefill";

// The plan session a save will tick off, re-checked against the form (date, type) on every render, so an
// edit that no longer fits lets go rather than ticking off a tempo with a bike ride. An offer can be declined.
export function useSessionLink(prefill: RunPrefill | null | undefined, form: { date: string; type: string }) {
  const [declined, setDeclined] = useState(false);
  const linked = prefill?.session && !(prefill.sessionOffered && declined) ? prefill.session : null;
  const fits = !!linked && runFitsSession(linked, form);
  const session = linked && fits ? linked : null;
  const offered = session && prefill?.sessionOffered ? session : null;
  const link = session ? { wNum: session.wNum, sId: session.id } : null;
  const undoable = declined && !!prefill?.sessionOffered && !!prefill.session;
  return { linked, fits, session, offered, link, declined, setDeclined, undoable };
}
