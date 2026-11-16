import { useRef } from "react";
import { canonicalDur, formatDur, normalizeDur } from "../utils/runForm";

type Props = {
  id?: string;
  value: string;
  onChange: (digits: string) => void;
  onCommit?: (digits: string) => void;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
};

// One masked duration field: digits fill from the right (4300 → 43:00), as a watch face reads.
// Append/backspace only, caret pinned to the end, so there is no caret arithmetic to get wrong.
export function DurationInput({ id, value, onChange, onCommit, className, placeholder, ...aria }: Props) {
  const ref = useRef<HTMLInputElement | null>(null);
  const pinEnd = () => requestAnimationFrame(() => {
    const el = ref.current;
    if (!el || el.selectionStart !== el.selectionEnd) return;
    el.setSelectionRange(el.value.length, el.value.length);
  });
  return (
    <input id={id} ref={ref} type="text" inputMode="numeric" autoComplete="off"
      placeholder={placeholder} value={formatDur(value)} {...aria}
      // Settled on blur, not per digit: mid-entry "1571" is half of 1:57:13, not 15:71.
      onChange={e => { onChange(normalizeDur(e.target.value)); pinEnd(); }}
      onBlur={() => { const c = canonicalDur(value); if (c !== value) onChange(c); onCommit?.(c); }}
      onKeyDown={e => {
        // Over a selection the browser's own delete is what makes select-all-then-retype work.
        const el = e.currentTarget;
        if (e.key === "Enter" && onCommit) { el.blur(); return; }
        if (e.key !== "Backspace" || el.selectionStart !== el.selectionEnd) return;
        e.preventDefault();
        onChange(value.slice(0, -1));
      }}
      onFocus={pinEnd} onClick={pinEnd}
      className={className}/>
  );
}
