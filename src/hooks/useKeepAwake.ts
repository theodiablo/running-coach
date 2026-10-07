import { useEffect } from "react";
import { KeepAwake } from "@capacitor-community/keep-awake";
import { isNative } from "../native";

// Holds the screen on while `on`. For screens that are read while in use (the
// stretch player), never for recording: a run is recorded screen-off. Native
// WebViews have no navigator.wakeLock, hence the plugin. Never throws.
export function useKeepAwake(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    if (isNative) {
      KeepAwake.keepAwake().catch(() => {});
      return () => { KeepAwake.allowSleep().catch(() => {}); };
    }
    let lock: WakeLockSentinel | null = null;
    let live = true;
    const acquire = async () => {
      try {
        if ("wakeLock" in navigator && document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen");
      } catch { /* unsupported or denied */ }
      if (!live) lock?.release().catch(() => {});
    };
    // The browser drops the lock whenever the tab is hidden.
    const onVisible = () => { if (document.visibilityState === "visible") void acquire(); };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release().catch(() => {});
    };
  }, [on]);
}
