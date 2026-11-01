// Web geolocation source: thin wrapper over navigator.geolocation. `background` is accepted to match
// the native interface but ignored (a browser cannot record screen-off). `onPos` receives the native
// GeolocationPosition, which useRunTracker already reads.
export const webSource = {
  isAvailable: () => typeof navigator !== "undefined" && "geolocation" in navigator,

  // The browser handles its own permission prompt on watchPosition, so the idle
  // preview is always allowed and there's nothing to request up front.
  checkPermissions: async () => true,
  requestPermissions: async () => true,

  // Third arg (the shared `{ background }` option) is intentionally ignored — a
  // browser can't record in the background. Always high-accuracy, matching the
  // Phase-1 inline behaviour.
  watchPosition(onPos: PositionCallback, onErr?: PositionErrorCallback) {
    return navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 15000,
    });
  },

  clearWatch(handle: number | null | undefined) {
    if (handle != null) navigator.geolocation.clearWatch(handle);
  },

  // One-off coarse fix for "races near me" (Discover) — not a watcher. Resolves
  // { lat, lng }; rejects (browser prompt denied / unavailable) so the UI can
  // show its location-unavailable state. Needs a secure context (https/localhost).
  getCurrentPosition(): Promise<{ lat: number; lng: number }> {
    return new Promise((resolve, reject) => {
      if (!this.isAvailable()) { reject(new Error("Geolocation unavailable")); return; }
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        reject,
        { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 },
      );
    });
  },
};
