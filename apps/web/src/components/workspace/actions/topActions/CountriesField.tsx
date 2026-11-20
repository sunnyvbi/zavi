"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { ISO_COUNTRY_CODES, countryLabel, countryOptions } from "@/lib/countries";

export const countryCodesOf = (raw: string): string[] => [...new Set(raw.split(/[\s,]+/).map((c) => c.toUpperCase()).filter(Boolean))];
export const areCountryCodes = (raw: string): boolean => countryCodesOf(raw).every((c) => ISO_COUNTRY_CODES.includes(c));

const flagOf = (code: string) => String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)));

export function CountriesField({
  id,
  value,
  taken,
  takenLabel,
  placeholder,
  disabled,
  onChange,
  onBlur,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  taken: string;
  takenLabel: string;
  placeholder: string;
  disabled: boolean;
  onChange: (v: string) => void;
  onBlur: () => void;
  invalid: boolean;
  describedBy?: string;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const picked = countryCodesOf(value);
  const blocked = countryCodesOf(taken);
  const all = useMemo(countryOptions, []);
  const query = q.trim().toLowerCase();
  const shown = all
    .filter((c) => !picked.includes(c.code))
    .filter((c) => !query || c.name.toLowerCase().includes(query) || c.code.toLowerCase() === query)
    .sort((a, b) => Number(b.code.toLowerCase() === query) - Number(a.code.toLowerCase() === query) || Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)));
  const set = (codes: string[]) => onChange(codes.join(", "));
  const add = (code: string) => {
    if (blocked.includes(code)) return;
    set([...picked, code]);
    setQ("");
    setActive(0);
    setOpen(false);
    input.current?.focus();
  };
  const remove = (code: string) => {
    set(picked.filter((c) => c !== code));
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.max(0, Math.min(shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = shown[active];
      if (open && c) add(c.code);
    } else if (e.key === "Escape") {
      if (open) e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Backspace" && !q && picked.length) {
      remove(picked[picked.length - 1]);
    }
  };
  const expanded = open && !disabled;
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (expanded) list.current?.scrollIntoView?.({ block: "nearest" });
  }, [expanded]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  return (
    <div
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOpen(false);
        onBlur();
      }}
    >
      <div
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          input.current?.focus();
        }}
        className={`flex min-h-12 w-full cursor-text flex-wrap items-center gap-1.5 rounded-xl border bg-white px-2.5 py-[7px] text-[15px] focus-within:border-ink ${invalid ? "border-danger" : "border-[#e5e7eb]"} ${disabled ? "bg-[#fbfaf7] text-[#595959]" : ""}`}
      >
        {picked.map((code) => (
          <span key={code} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#e5e7eb] bg-[#fbfaf7] pl-2.5 pr-1.5 text-[13px] text-[#1f1f1f]">
            <span aria-hidden>{flagOf(code)}</span>
            {countryLabel(code)}
            <button
              type="button"
              aria-label={`Remove ${countryLabel(code)}`}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                remove(code);
              }}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[#8a8a8a] transition-colors hover:bg-bone hover:text-[#1f1f1f]"
            >
              <X size={12} strokeWidth={2.25} aria-hidden />
            </button>
          </span>
        ))}
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded && shown[active] ? `${listId}-${shown[active].code}` : undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          value={q}
          disabled={disabled}
          placeholder={picked.length ? "Add another country" : placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={onKey}
          className="h-8 min-w-[140px] flex-1 bg-transparent px-1 outline-none placeholder:text-[#a8a8a8]"
        />
      </div>
      {expanded && (
        <div ref={list} id={listId} role="listbox" aria-label="Countries" className="mt-1.5 max-h-60 scroll-my-3 overflow-y-auto rounded-xl border border-[#e5e7eb] bg-white py-1">
          {shown.length === 0 ? (
            <p className="px-3.5 py-2.5 text-[14px] text-[#8a8a8a]">No country matches “{q.trim()}”.</p>
          ) : (
            shown.map((c, i) => {
              const off = blocked.includes(c.code);
              return (
                <button
                  key={c.code}
                  id={`${listId}-${c.code}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === active}
                  aria-disabled={off || undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => add(c.code)}
                  className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[14px] ${off ? "cursor-default text-[#a8a8a8]" : "text-[#1f1f1f]"} ${i === active && !off ? "bg-[#fbfaf7]" : ""}`}
                >
                  <span aria-hidden className="text-[16px]">{flagOf(c.code)}</span>
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="text-[12px] text-[#8a8a8a]">{off ? takenLabel : c.code}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
