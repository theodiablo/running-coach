import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { INPUT_CLS } from "../constants";
import { useDismissable } from "../hooks/useDismissable";
import { countryOptions, filterCountries } from "../utils/country";

interface CountryPickerProps {
  id: string;
  value: string;
  onChange: (code: string) => void;
  locale: string;
  placeholder: string;
  noMatch: string;
}

// Type-to-filter country field: the list opens on focus and narrows as the runner types.
export function CountryPicker({ id, value, onChange, locale, placeholder, noMatch }: CountryPickerProps) {
  const options = useMemo(() => countryOptions(locale), [locale]);
  const selectedName = options.find(o => o.code === value)?.name ?? "";
  const [query, setQuery] = useState<string | null>(null); // null: closed, showing the selection
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const open = query !== null;
  const matches = useMemo(() => {
    if (query === null) return [];
    return filterCountries(options, query === selectedName ? "" : query);
  }, [options, query, selectedName]);
  useDismissable(open, () => setQuery(null));

  const optionId = (code: string) => `${listId}-${code}`;
  const moveTo = (i: number) => {
    setActive(i);
    if (matches[i]) document.getElementById(optionId(matches[i].code))?.scrollIntoView?.({ block: "nearest" });
  };
  const pick = (code: string) => {
    onChange(code);
    setQuery(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); moveTo(Math.min(active + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveTo(Math.max(active - 1, 0)); }
    else if (e.key === "Enter" && matches[active]) { e.preventDefault(); pick(matches[active].code); }
  };

  return (
    <div>
      <input id={id} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? optionId(matches[active].code) : undefined}
        aria-required="true" autoComplete="off" placeholder={placeholder} className={INPUT_CLS}
        value={query ?? selectedName}
        onFocus={e => {
          e.currentTarget.select();
          setQuery(selectedName);
          setActive(Math.max(0, options.findIndex(o => o.code === value)));
          requestAnimationFrame(() => listRef.current?.scrollIntoView?.({ block: "nearest" }));
        }}
        onChange={e => { setQuery(e.target.value); setActive(0); }}
        onBlur={() => setQuery(null)}
        onKeyDown={onKeyDown}/>
      {open && (
        <ul ref={listRef} id={listId} role="listbox" className="mt-1 max-h-52 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900/40 p-1">
          {matches.map((o, i) => (
            <li key={o.code} id={optionId(o.code)} role="option" aria-selected={o.code === value}
              onMouseDown={e => e.preventDefault()} onClick={() => pick(o.code)}
              className={`px-2 py-1.5 rounded-lg text-sm cursor-pointer flex items-center justify-between gap-2 ${i === active ? "bg-slate-700/60" : ""}`}>
              <span className="truncate">{o.name}</span>
              {o.code === value && <Check size={13} className="text-orange-400 shrink-0"/>}
            </li>
          ))}
        </ul>
      )}
      {open && matches.length === 0 && <p className="text-xs text-slate-500 mt-1 px-1">{noMatch}</p>}
    </div>
  );
}
