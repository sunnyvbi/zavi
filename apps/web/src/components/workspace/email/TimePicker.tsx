"use client";

import { useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { cn } from "@/lib/cn";

const pad = (n: number) => String(n).padStart(2, "0");

export const QUARTER_HOURS: string[] = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`);

export function clockLabel(v: string): string {
  const hit = /^(\d{2}):(\d{2})$/.exec(v);
  if (!hit) return v;
  const h = Number(hit[1]);
  return `${h % 12 || 12}:${hit[2]} ${h < 12 ? "AM" : "PM"}`;
}

export function TimePicker({
  value,
  label,
  disabled,
  up,
  className,
  onChange,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  up?: boolean;
  className?: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const times = QUARTER_HOURS.includes(value) || !/^\d{2}:\d{2}$/.test(value) ? QUARTER_HOURS : [...QUARTER_HOURS, value].sort();

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "center" });
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full cursor-pointer items-center justify-between gap-3 rounded-[8px] border border-rule bg-white px-3 text-left text-[16px] text-ink outline-none transition-colors hover:border-inkLight focus:border-ink disabled:cursor-default disabled:bg-bone disabled:text-inkMuted sm:text-[14px]",
          className,
        )}
      >
        <span>{clockLabel(value)}</span>
        <Clock className="h-4 w-4 text-inkMuted" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={list}
          role="listbox"
          aria-label={label}
          className={cn("absolute left-0 z-30 max-h-60 w-full min-w-[140px] overflow-y-auto overscroll-contain rounded-xl border border-rule bg-cream p-1.5 shadow-xl", up ? "bottom-full mb-2" : "mt-2")}
        >
          {times.map((t) => (
            <button
              key={t}
              type="button"
              role="option"
              aria-selected={t === value}
              onClick={() => {
                onChange(t);
                setOpen(false);
              }}
              className={cn(
                "block w-full cursor-pointer rounded-lg px-3 py-1.5 text-left text-[14px] tabular-nums transition-colors",
                t === value ? "bg-ink font-semibold text-cream" : "text-ink hover:bg-creamDeep",
              )}
            >
              {clockLabel(t)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
