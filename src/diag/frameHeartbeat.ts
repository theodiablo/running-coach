// Is the recorder still UPDATING, or only alive?
//
// A recorder that comes back from a backgrounded stretch showing a frame minutes
// old looks identical whether nothing is running or everything is. Three device
// captures agree it is the latter: JS accepts GPS fixes every ~2s throughout,
// taps register (Pause landed the instant it was pressed on a screen already
// written off as dead), and every Android visibility flag reads correct
// (`visibility=0`, `windowVisibility=0`, `attached=true`).
//
// Painting is not the stalled layer either — while the numbers are frozen the
// MAP still pans and redraws, and Leaflet writes to the DOM imperatively,
// outside React. A moving map proves the compositor is drawing and that touch is
// being delivered. (Which is why there is no rAF probe here: `requestAnimationFrame`
// is not serviced at all for a hidden page, so it reads "stale" in the healthy
// and broken cases alike — it cannot answer the question it looks like it answers.)
//
// That leaves the two layers above painting, and they need different fixes:
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
// Both look identical from the outside. Measured, they are one line apart, and
// each mark is one assignment on a code path that was going to run anyway.

// Both marks are only meaningful WHILE A RECORDER IS MOUNTED, and are cleared
// when one unmounts. Left to run on, they would say the opposite of the truth:
// a report filed an hour after a run would carry `renderAge=3600000ms`, which
// this file's own guide defines as "React is not committing" — an alarming
// reading of an app that is simply sitting on the dashboard with no recorder to
// render. Cleared, the same report reads `never`, which is what it means.

let lastRenderAt = 0;
let lastTickAt = 0;

/** Called from a recorder's render (both LiveRunTracker and IndoorTracker). */
export const markRender = () => { lastRenderAt = Date.now(); };
/** Called from useRunTracker's 1s interval. */
export const markTick = () => { lastTickAt = Date.now(); };
/** Called from useRunTracker's unmount teardown: nothing is recording any more. */
export const clearRecorderMarks = () => { lastRenderAt = 0; lastTickAt = 0; };

export const renderAgeMs = (): number | null => (lastRenderAt ? Date.now() - lastRenderAt : null);
export const tickAgeMs = (): number | null => (lastTickAt ? Date.now() - lastTickAt : null);
