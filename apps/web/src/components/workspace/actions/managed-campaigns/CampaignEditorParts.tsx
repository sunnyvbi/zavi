"use client";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { sheetLabel } from "./AdsSheet";

export function EditorSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-5">
    <h3 className="text-[16px] font-semibold leading-6 text-ca-xdark">{title}</h3>
    {children}
  </section>;
}

type Option = { value: string; label: string };

export function Segmented({ legend, value, options, onChange, disabled = false }: { legend: string; value: string; options: Option[]; onChange: (value: string) => void; disabled?: boolean }) {
  const name = useId();
  return <fieldset disabled={disabled} className="min-w-0 disabled:opacity-60">
    <legend className={sheetLabel}>{legend}</legend>
    <div role="radiogroup" aria-label={legend} className="mt-1.5 inline-flex max-w-full flex-wrap gap-1 rounded-3xl bg-ca-subtle p-1">
      {options.map((o) => <label key={o.value} className={cn("cursor-pointer rounded-full px-4 py-1.5 text-[14px] font-semibold leading-5 transition-colors has-[:focus-visible]:shadow-ca-focus", o.value === value ? "bg-ca-bg text-ca-xdark shadow-sm" : "text-ca-secondary hover:text-ca-primary", disabled && "cursor-not-allowed")}>
        <input type="radio" className="sr-only" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
        {o.label}
      </label>)}
    </div>
  </fieldset>;
}

export function TogglePills({ legend, selected, options, onChange, hint }: { legend: string; selected: string[]; options: Option[]; onChange: (value: string[]) => void; hint?: ReactNode }) {
  return <fieldset className="min-w-0">
    <legend className={sheetLabel}>{legend}</legend>
    <div className="mt-1.5 flex flex-wrap gap-2">
      {options.map((o) => {
        const on = selected.includes(o.value);
        return <label key={o.value} className={cn("cursor-pointer rounded-full border px-4 py-1.5 text-[14px] font-semibold leading-5 transition-colors has-[:focus-visible]:shadow-ca-focus", on ? "border-ca-xdark bg-ca-xdark text-ca-bg" : "border-ca-strong bg-ca-bg text-ca-secondary hover:text-ca-primary")}>
          <input type="checkbox" className="sr-only" checked={on} onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))} />
          {o.label}
        </label>;
      })}
    </div>
    {hint}
  </fieldset>;
}

export function PresetChips({ label, chips }: { label: string; chips: Array<{ label: string; active: boolean; disabled?: boolean; onPick: () => void }> }) {
  return <div role="group" aria-label={label} className="mt-2 flex flex-wrap gap-1.5">
    {chips.map((c) => <button key={c.label} type="button" aria-pressed={c.active} disabled={c.disabled} onClick={c.onPick} className={cn("rounded-full px-3 py-1 text-[13px] font-semibold leading-5 transition-colors disabled:cursor-not-allowed disabled:opacity-40", c.active ? "bg-ca-xdark text-ca-bg" : "bg-ca-subtle text-ca-secondary hover:text-ca-primary")}>{c.label}</button>)}
  </div>;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const localStamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export function morningIn(days: number, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return localStamp(d);
}

export function nextMonday(from = new Date()): string {
  const ahead = ((8 - from.getDay()) % 7) || 7;
  return morningIn(ahead, from);
}

export function daysAfter(start: string, days: number): string {
  const base = start ? new Date(start) : new Date();
  base.setDate(base.getDate() + days);
  return localStamp(base);
}
