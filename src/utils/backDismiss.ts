// A LIFO stack of "dismiss" handlers for the app's overlays (modals, sheets,
// the live-run sub-overlays). Each open overlay registers its dismiss via
// useDismissable; the single global dispatcher in RunningCoach (Escape on web,
// the Android hardware back button on native) closes the topmost one.
//
// A registry is used rather than routing through RunningCoach's modal booleans
// because roughly half the overlays hold their open-state in local child state
// (LocationPicker, EditRunModal, the tracker's disclosure/HR-nudge/countdown,
// InfoButton) that RunningCoach can't see. Registration order is the stack
// order, so a sub-overlay opened on top of a modal is dismissed first.

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

// Invoke the topmost handler. Returns true if one existed (so the caller knows
// a back/Escape was consumed and should NOT also fall through to "go home").
// The handler is NOT popped here — removal happens when the overlay actually
// unmounts. A guarded dismiss that refuses to close (e.g. a busy delete, or a
// "discard run?" the user cancels) correctly stays on top.
export function dismissTop(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.fn();
  return true;
}

// Invoke every registered handler, topmost first — the "go home" reset behind
// the header brand mark, which clears the whole overlay stack rather than one
// level. Iterates a snapshot, so a handler that opens a confirmation on its way
// out isn't itself dismissed; as with dismissTop, a guarded handler that refuses
// to close stays open.
export function dismissAll(): void {
  for (const entry of [...stack].reverse()) entry.fn();
}
