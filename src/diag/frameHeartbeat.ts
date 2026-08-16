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
