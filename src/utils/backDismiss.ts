// A LIFO stack of dismiss handlers for the app's overlays. Each registers via useDismissable;
// the global dispatcher in RunningCoach (Escape on web, Android back) closes the topmost.
// A registry rather than RunningCoach's modal booleans, since many overlays hold open-state in
// local child state it can't see. Registration order is stack order.

type DismissFn = () => void;
type Entry = { id: number; fn: DismissFn };

const stack: Entry[] = [];
let seq = 0;

// Register a dismiss handler; returns an unregister fn (call on close/unmount).
export function pushDismiss(fn: DismissFn): () => void {
  const id = ++seq;
  stack.push({ id, fn });
  return () => {
    const i = stack.findIndex((e) => e.id === id);
    if (i !== -1) stack.splice(i, 1);
  };
}

// Invoke the topmost handler. Returns true if one existed (back/Escape consumed, don't go
// home). NOT popped here: removal happens on unmount, so a guarded dismiss that refuses
// (busy delete, cancelled "discard run?") correctly stays on top.
export function dismissTop(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.fn();
  return true;
}

// Invoke every handler, topmost first: the "go home" reset behind the brand mark. Iterates a
// snapshot, so a handler opening a confirmation on its way out isn't itself dismissed; a
// guarded handler that refuses stays open.
export function dismissAll(): void {
  for (const entry of [...stack].reverse()) entry.fn();
}
