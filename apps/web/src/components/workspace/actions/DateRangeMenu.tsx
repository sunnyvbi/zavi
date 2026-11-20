"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays, Check, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { GadsRange } from "../agent/google-ads/types";
import { CUSTOM_RANGE_ID, MAX_CUSTOM_DAYS, daysBetween, fromYmd, presetSpan, rangeLabel, spanLabel, startOfDay, toYmd, type CustomSpan, type PickedRange } from "./dateRange";
import { RangeCalendar } from "./RangeCalendar";

export const toolbarButton = "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border border-ca-strong bg-ca-bg text-ca-action tracking-[0.01em] text-ca-dark outline-none transition hover:bg-ca-subtle hover:shadow-ca-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ca-brand";

const PANEL_WIDTH = 312;
const GUTTER = 16;
const ROW = "flex min-h-9 w-full items-center justify-between gap-2 rounded-xl px-3 text-left text-sm leading-5 font-medium text-ca-dark outline-none hover:bg-ca-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ca-brand";
const ROW_ON = "bg-ca-surface font-semibold text-ca-xdark";

export function DateRangeMenu({ label, ranges, pickedId, onPick, allowCustom = false, custom = null, period = null, maxDays = MAX_CUSTOM_DAYS }: {
  label: string;
  ranges: readonly GadsRange[];
  pickedId: string;
  onPick: (range: PickedRange) => void;
  allowCustom?: boolean;
  custom?: CustomSpan | null;
  period?: { from: string; to: string } | null;
  maxDays?: number;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"list" | "custom">("list");
  const [today, setToday] = useState(() => startOfDay(new Date()));
  const [place, setPlace] = useState<{ right: number; width: number }>({ right: 0, width: PANEL_WIDTH });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const isCustom = allowCustom && pickedId === CUSTOM_RANGE_ID && !!custom;
  const preset = isCustom ? null : ranges.find((r) => r.id === pickedId) ?? null;
  const dates = preset && period ? { from: fromYmd(period.from), to: fromYmd(period.to) } : null;

  const fit = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(PANEL_WIDTH, window.innerWidth - 2 * GUTTER);
    setPlace({ right: Math.min(0, rect.right - width - GUTTER), width });
  };

  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    if (mode === "list") root.current?.querySelector<HTMLButtonElement>('[aria-selected="true"], [role="option"]')?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (mode === "custom" && !isCustom) setMode("list");
      else close(true);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", fit);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", fit);
    };
  }, [open, mode, isCustom]);

  const toggle = () => {
    if (open) return close();
    setToday(startOfDay(new Date()));
    setMode(isCustom ? "custom" : "list");
    fit();
    setOpen(true);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const at = list.findIndex((b) => b === document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      list[(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const draft = isCustom && custom ? { from: fromYmd(custom.since), to: fromYmd(custom.until) } : dates ?? presetSpan(preset?.days ?? 30, today);

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        className={cn(toolbarButton, "pl-3 pr-2.5 font-semibold compact:w-9 compact:justify-center compact:px-0")}
      >
        <CalendarDays className="size-4 shrink-0 text-ca-icon-light compact:text-ca-dark" aria-hidden />
        <span className="compact:sr-only">
          {isCustom && custom ? spanLabel(custom) : label}
          {dates && <span className="hidden font-normal text-ca-secondary xl:inline"> · {rangeLabel(dates.from, dates.to)}</span>}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-ca-icon-light transition-transform compact:hidden", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={mode === "custom" ? "Custom date range" : "Date range"}
          style={{ right: place.right, width: place.width }}
          className="absolute top-full z-30 mt-2 max-h-[calc(100dvh-96px)] overflow-y-auto rounded-2xl border border-ca-border bg-ca-bg shadow-ca-xl"
        >
          {mode === "list" ? (
            <div onKeyDown={onKey} className="flex flex-col gap-0.5 p-1.5">
              <ul role="listbox" aria-label="Date range" className="flex flex-col gap-0.5">
                {ranges.map((r) => {
                  const on = !isCustom && r.id === pickedId;
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={on}
                        onClick={() => {
                          onPick({ id: r.id, days: r.days });
                          close(true);
                        }}
                        className={cn(ROW, on && ROW_ON)}
                      >
                        {r.label}
                        {on && <Check className="size-4 shrink-0" aria-hidden />}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {allowCustom && (
                <>
                  <span aria-hidden className="mx-3 my-1 h-px bg-ca-border" />
                  <button type="button" aria-pressed={isCustom} onClick={() => setMode("custom")} className={cn(ROW, isCustom && ROW_ON)}>
                    <span className="flex min-w-0 flex-col">
                      Custom
                      {isCustom && custom && <span className="truncate text-xs font-normal leading-4 text-ca-secondary">{spanLabel(custom)}</span>}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-ca-icon-light" aria-hidden />
                  </button>
                </>
              )}
            </div>
          ) : (
            <RangeCalendar
              initial={draft}
              today={today}
              maxDays={maxDays}
              onBack={() => setMode("list")}
              onCancel={() => close(true)}
              onApply={(from, to) => {
                onPick({ id: CUSTOM_RANGE_ID, days: daysBetween(from, to), since: toYmd(from), until: toYmd(to) });
                close(true);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
