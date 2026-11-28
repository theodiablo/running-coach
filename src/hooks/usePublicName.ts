import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPublicName } from "../publicName";

// The runner's public name (docs/race-field.md): undefined = not read (yet, or the read
// failed), retried on online, foreground and reload(). A save or retry always wins over a
// read still in flight, so the ref is set in the same call as the state, never in an effect.
export function usePublicName(uid: string | null) {
  const [publicName, setState] = useState<string | null | undefined>(undefined);
  const ref = useRef(publicName);
  const commit = useCallback((v: string | null | undefined) => { ref.current = v; setState(v); }, []);
  const loadRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    let busy = false;
    const load = () => {
      if (busy || ref.current !== undefined) return;
      busy = true;
      void fetchPublicName(uid).then(v => {
        busy = false;
        if (alive && ref.current === undefined) commit(v);
      });
    };
    loadRef.current = load;
    ref.current = undefined;
    load();
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("online", load);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      loadRef.current = () => {};
      window.removeEventListener("online", load);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [uid, commit]);
  const reload = useCallback(() => loadRef.current(), []);
  return { publicName, setPublicName: commit, reloadPublicName: reload };
}
