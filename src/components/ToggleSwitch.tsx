// The app's one on/off switch. Icon-only by nature (the label always sits
// beside it in the row), so `label` is required and lands on aria-label.
type ToggleSwitchProps = {
  on: boolean;
  onToggle: () => void;
  label: string;
  disabled?: boolean;
};

export function ToggleSwitch({ on, onToggle, label, disabled }: ToggleSwitchProps) {
  return (
    <button type="button" onClick={onToggle} role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      className={"relative shrink-0 w-11 h-6 rounded-full transition-colors " + (on ? "bg-orange-500" : "bg-slate-600") + (disabled ? " opacity-50" : "")}>
      <span className={"absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform " + (on ? "translate-x-5" : "translate-x-0")} />
    </button>
  );
}
