import { useState } from "react";
import { geoSource } from "../geo/source";
import { track } from "../telemetry";

// Shared race-search filter constants: event distance bands (km) and "near
// me" radius (km). Used by the Races tab's Find panel and the onboarding
// race picker so the two never drift.
export const BANDS = [5, 10, 21.1, 42.2];
export const RADII = [25, 50, 100, 500];

export type LocationFix = { lat: number; lng: number };

// One-off geolocation fix + "near me" toggle, reused by every race search
// surface. `trackEvent` lets each caller tag its own telemetry event name.
export function useNearMeFilter(trackEvent = "find_near_me") {
  const [nearMe, setNearMe] = useState(false);
  const [radius, setRadius] = useState(100); // km
  const [loc, setLoc] = useState<LocationFix | null>(null);
  const [status, setStatus] = useState<"idle" | "locating" | "denied">("idle");

  const toggleNearMe = async () => {
    if (nearMe) { setNearMe(false); return; }
    if (loc) { setNearMe(true); return; } // reuse an earlier fix
    setStatus("locating");
    try {
      const p = await geoSource.getCurrentPosition() as LocationFix;
      setLoc(p); setNearMe(true); setStatus("idle");
      track(trackEvent, {});
    } catch {
      setStatus("denied");
    }
  };

  return { nearMe, radius, setRadius, loc, status, toggleNearMe };
}

export function fmtKm(distM: number) {
  const km = distM / 1000;
  // Right on top of it (e.g. same city centroid) reads as a broken "0.0 km".
  if (km < 0.1) return "< 100 m";
  return km < 10 ? km.toFixed(1) + " km" : Math.round(km) + " km";
}
