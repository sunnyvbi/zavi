"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { FIELD } from "./ui";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDay = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

function parse(v: string): { y: number; m: number; d: number } | null {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return hit ? { y: Number(hit[1]), m: Number(hit[2]) - 1, d: Number(hit[3]) } : null;
}

export function longDay(v: string): string | null {
  const p = parse(v);
  if (!p) return null;
  const day = new Date(Date.UTC(p.y, p.m, p.d)).getUTCDay();
  return `${WEEKDAYS[day]} ${p.d} ${MONTHS[p.m].slice(0, 3)} ${p.y}`;
}

export function monthGrid(y: number, m: number): Array<number | null> {
  const lead = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells: Array<number | null> = [...Array<null>(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function DatePicker({
  id,
  labelledBy,
  value,
  min,
  max,
  label,
  field,
  invalid,
  disabled,
  up,
  fieldClass,
  className,
  onChange,
}: {
  id?: string;
  labelledBy?: string;
  value: string;
  min: string;
  max?: string;
  label?: string;
  field?: string;
  invalid?: boolean;
  disabled?: boolean;
  up?: boolean;
  fieldClass?: string;
  className?: string;
  onChange: (v: string) => void;
}) {
  const start = parse(value) ?? parse(min) ?? { y: new Date().getFullYear(), m: new Date().getMonth(), d: 1 };
  const [open, setOpen] = useState(false);
  const [view, setView] = useState({ y: start.y, m: start.m });
  const root = useRef<HTMLDivElement>(null);
  const floor = parse(min);
  const ceil = max ? parse(max) : null;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);

  const toggle = () => {
    if (disabled) return;
    if (!open) setView({ y: start.y, m: start.m });
    setOpen((o) => !o);
  };
  const shift = (by: number) => setView(({ y, m }) => ({ y: y + Math.floor((m + by) / 12), m: (((m + by) % 12) + 12) % 12 }));
  const canGoBack = !floor || view.y > floor.y || (view.y === floor.y && view.m > floor.m);
  const canGoOn = !ceil || view.y < ceil.y || (view.y === ceil.y && view.m < ceil.m);
  const now = new Date();
  const today = isoDay(now.getFullYear(), now.getMonth(), now.getDate());
  const shown = longDay(value);

  return (
    <div ref={root} className="relative">
      <button
        id={id}
        type="button"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        data-field={field}
        disabled={disabled}
        onClick={toggle}
        className={`${fieldClass ?? FIELD} flex cursor-pointer items-center justify-between gap-3 text-left transition-colors hover:bg-bone disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent ${invalid ? "border-danger" : ""} ${className ?? ""}`}
      >
        <span className={shown ? "" : "text-inkMuted"}>{shown ?? "Pick a day"}</span>
        <CalendarDays className="h-4 w-4 text-inkMuted" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Choose a day"
          className={`absolute left-0 z-30 w-[296px] ${up ? "bottom-full mb-2" : "mt-2"} rounded-2xl border border-rule bg-cream p-3 shadow-xl`}
        >
          <div className="flex items-center justify-between px-1 pb-2">
            <button
              type="button"
              aria-label="Previous month"
              disabled={!canGoBack}
              onClick={() => shift(-1)}
              className="grid h-8 w-8 cursor-pointer place-items-center rounded-full text-ink hover:bg-bone disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="text-[15px] font-semibold text-ink" aria-live="polite">
              {MONTHS[view.m]} {view.y}
            </span>
            <button
              type="button"
              aria-label="Next month"
              disabled={!canGoOn}
              onClick={() => shift(1)}
              className="grid h-8 w-8 cursor-pointer place-items-center rounded-full text-ink hover:bg-bone disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center">
            {WEEKDAYS.map((w) => (
              <span key={w} className="pb-1 text-[12px] font-medium text-inkMuted">
                {w.slice(0, 2)}
              </span>
            ))}
            {monthGrid(view.y, view.m).map((d, i) => {
              if (d === null) return <span key={`e${i}`} />;
              const day = isoDay(view.y, view.m, d);
              const off = day < min || (!!max && day > max);
              const picked = day === value;
              return (
                <button
                  key={day}
                  type="button"
                  disabled={off}
                  aria-pressed={picked}
                  aria-label={longDay(day) ?? day}
                  onClick={() => {
                    onChange(day);
                    setOpen(false);
                  }}
                  className={`h-9 w-9 justify-self-center rounded-full text-[14px] transition-colors ${
                    picked
                      ? "cursor-pointer bg-ink font-semibold text-cream"
                      : off
                        ? "cursor-default text-inkMuted opacity-40"
                        : `cursor-pointer text-ink hover:bg-bone ${day === today ? "border border-ink" : ""}`
                  }`}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
