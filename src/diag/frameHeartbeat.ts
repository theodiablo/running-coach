// Is the page actually being RENDERED, or only executing?
//
// Three device captures agree that the recorder is alive while its screen is
// stale: JS accepts GPS fixes throughout, taps register, and — as of the last
// build — every Android visibility flag reads correct (`visibility=0`,
// `windowVisibility=0`, `attached=true`) at the moment the runner is looking at
// a frame minutes old. So "the WebView thinks it is hidden" is ruled out, and
// two very different explanations remain:
//
//   1. the page is not producing frames at all (throttled despite the flags), or
//   2. it is producing frames that never reach the display (surface/compositor).
//
// `requestAnimationFrame` separates them cleanly, because it fires only when the
// page is actually being rendered. A stale `frameAge` means (1); a fresh one
// alongside a stale screen means (2) — and they need opposite fixes, so guessing
// between them is exactly what has cost four rounds already.
//
// Cost is nil: rAF does not fire at all while the page is hidden, and the
// callback is one assignment when it is.

let lastFrameAt = 0;
let running = false;

export function startFrameHeartbeat(): () => void {
  if (running || typeof requestAnimationFrame !== "function") return () => {};
  running = true;
  let raf = 0;
  const tick = () => {
    lastFrameAt = Date.now();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    running = false;
    if (raf) cancelAnimationFrame(raf);
  };
}

/** ms since the last rendered frame, or null if none has been observed yet. */
export function frameAgeMs(): number | null {
  return lastFrameAt ? Date.now() - lastFrameAt : null;
}

// ── the two layers ABOVE painting ───────────────────────────────────────────
//
// A later observation splits the problem again: while the numbers are frozen,
// the MAP still pans and redraws. Leaflet writes to the DOM imperatively,
// outside React — so a moving map proves the compositor is drawing and that
// touch is being delivered. Painting was never the stalled layer.
//
// That leaves two candidates above it, and they need different fixes:
//
//   renderAge stale  → React is not committing. The DOM still holds the old
//                      numbers, so a correct paint of stale content is exactly
//                      what the runner sees, and a tap that changes state
//                      changes nothing on screen.
//   tickAge stale    → the tracker's 1s interval is not firing, so `movingSec`
//                      is never recomputed. React is fine; it has nothing new
//                      to render, and distance is frozen beside it only because
//                      a stationary runner produces no accepted fix.
//
// Both look identical from the outside. Measured, they are one line apart.

let lastRenderAt = 0;
let lastTickAt = 0;

/** Called from the tracker's render. */
export const markRender = () => { lastRenderAt = Date.now(); };
/** Called from the tracker's 1s interval. */
export const markTick = () => { lastTickAt = Date.now(); };

export const renderAgeMs = (): number | null => (lastRenderAt ? Date.now() - lastRenderAt : null);
export const tickAgeMs = (): number | null => (lastTickAt ? Date.now() - lastTickAt : null);
