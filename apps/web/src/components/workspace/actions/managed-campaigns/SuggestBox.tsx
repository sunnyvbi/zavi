"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Search } from "lucide-react";

export type SuggestItem = { key: string; label: string; detail?: string; selected: boolean; note?: string; disabled?: boolean };

export function SuggestBox({ label, placeholder, query, onQuery, items, busy, error, empty, hint, disabled = false, onPick, openRequest = 0 }: {
  label: string; placeholder: string; query: string; onQuery: (query: string) => void;
  items: SuggestItem[] | null; busy: boolean; error: string; empty: string; hint?: string;
  disabled?: boolean; onPick: (key: string) => void; openRequest?: number;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const pickable = (items ?? []).filter(i => !i.disabled);
  const activeKey = active >= 0 ? pickable[Math.min(active, pickable.length - 1)]?.key : undefined;
  const typed = query.trim().length >= 2;
  const show = open && !disabled && (typed || !!hint);
  function openList() { if (!disabled) setOpen(true); }
  useEffect(() => {
    if (!openRequest || disabled) return;
    input.current?.focus();
    setActive(-1);
    setOpen(true);
  }, [openRequest]);
  function move(step: number) {
    openList();
    if (!pickable.length) return;
    setActive(a => (a < 0 ? (step > 0 ? 0 : pickable.length - 1) : (a + step + pickable.length) % pickable.length));
  }
  function pick(key: string) { onPick(key); input.current?.focus(); }
  let body: ReactNode;
  if (!typed) body = hint ? <p className="px-3 py-2.5 text-[13px] font-medium text-inkMuted">{hint}</p> : null;
  else if (error) body = <p role="alert" className="px-3 py-2.5 text-[13px] font-medium text-danger">{error}</p>;
  else if (busy || items === null) body = <p role="status" className="px-3 py-2.5 text-[13px] font-medium text-inkMuted">Searching…</p>;
  else if (items.length === 0) body = <p className="px-3 py-2.5 text-[13px] font-medium text-inkMuted">{empty}</p>;
  else body = <ul role="listbox" id={`${id}-list`} aria-label={`${label} suggestions`} aria-multiselectable="true" className="py-1">
    {items.map(item => <li key={item.key} id={`${id}-${item.key}`} role="option" aria-selected={item.selected} aria-disabled={item.disabled || undefined}
      onMouseDown={e => e.preventDefault()} onMouseEnter={() => { const at = pickable.findIndex(p => p.key === item.key); if (at >= 0) setActive(at); }}
      onClick={() => { if (!item.disabled) pick(item.key); }}
      className={`flex cursor-pointer items-start gap-2.5 px-3 py-2 text-[14px] font-medium leading-5 text-ink ${item.disabled ? "cursor-not-allowed opacity-50" : ""} ${item.key === activeKey ? "bg-creamDeep" : ""}`}>
      <span aria-hidden className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-[5px] border ${item.selected ? "border-ink bg-ink text-cream" : "border-rule bg-cream"}`}>{item.selected && <Check className="size-3" strokeWidth={3} />}</span>
      <span className="min-w-0">{item.label}{item.detail && <span className="block text-[12px] font-normal text-inkMuted">{item.detail}</span>}{item.note && <span className="block text-[12px] font-normal text-inkMuted">{item.note}</span>}</span>
    </li>)}
  </ul>;
  return <div className="relative mt-1.5">
    <span className="relative block">
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-inkMuted" />
      <input ref={input} role="combobox" aria-label={label} aria-expanded={show && !!body} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={show && activeKey ? `${id}-${activeKey}` : undefined}
        autoComplete="off" disabled={disabled} value={query} maxLength={120} placeholder={placeholder}
        className={`min-h-11 w-full rounded-[10px] border border-rule bg-cream text-base font-medium leading-[22px] tracking-[0.15px] text-ink outline-none placeholder:text-inkMuted focus:border-ink disabled:opacity-60 pl-9 pr-2.5`}
        onFocus={openList} onClick={openList} onBlur={() => { setOpen(false); setActive(-1); }}
        onChange={e => { onQuery(e.target.value); setActive(-1); openList(); }}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
          else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
          else if (e.key === "Enter") { e.preventDefault(); if (show && activeKey) pick(activeKey); }
          else if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setActive(-1); }
        }} />
    </span>
    {show && body && <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-[10px] border border-rule bg-cream shadow-lg">{body}</div>}
  </div>;
}
