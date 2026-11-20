"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIsCompact } from "@/lib/responsive";

export type BackendWindowKey =
  | "last_7d"
  | "last_14d"
  | "last_28d"
  | "last_30d"
  | "this_month"
  | "last_month";

export type ResolvedRange = {
  key: BackendWindowKey;
  start: Date;
  end: Date;
  presetLabel: string;
  isCustom: boolean;
};

export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type PresetKey =
  | "today"
  | "yesterday"
  | "last_7d"
  | "last_14d"
  | "last_30d"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month";

type Preset = { key: PresetKey; label: string };

export const RANGE_PRESETS: Preset[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last_7d", label: "Last 7 days" },
  { key: "last_14d", label: "Last 14 days" },
  { key: "last_30d", label: "Last 30 days" },
  { key: "this_week", label: "This week" },
  { key: "last_week", label: "Last week" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
];

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfDay(d: Date): Date {
  const n = new Date(d);
  n.setHours(0, 0, 0, 0);
  return n;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86400000);
}
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function fmtDay(d: Date): string {
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function presetRange(
  key: PresetKey,
  now: Date,
): { start: Date; end: Date } {
  const today = startOfDay(now);
  switch (key) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { start: y, end: y };
    }
    case "last_7d":
      return { start: addDays(today, -6), end: today };
    case "last_14d":
      return { start: addDays(today, -13), end: today };
    case "last_30d":
      return { start: addDays(today, -29), end: today };
    case "this_week": {
      const start = addDays(today, -today.getDay());
      return { start, end: today };
    }
    case "last_week": {
      const thisStart = addDays(today, -today.getDay());
      return { start: addDays(thisStart, -7), end: addDays(thisStart, -1) };
    }
    case "this_month":
      return {
        start: new Date(today.getFullYear(), today.getMonth(), 1),
        end: today,
      };
    case "last_month": {
      const firstThis = new Date(today.getFullYear(), today.getMonth(), 1);
      return {
        start: new Date(today.getFullYear(), today.getMonth() - 1, 1),
        end: addDays(firstThis, -1),
      };
    }
    default:
      return { start: today, end: today };
  }
}

const PRESET_TO_BACKEND: Record<PresetKey, BackendWindowKey> = {
  today: "last_7d",
  yesterday: "last_7d",
  last_7d: "last_7d",
  last_14d: "last_14d",
  last_30d: "last_30d",
  this_week: "last_7d",
  last_week: "last_7d",
  this_month: "this_month",
  last_month: "last_month",
};

const EXACT_BACKEND_PRESETS = new Set<PresetKey>([
  "last_7d",
  "last_14d",
  "last_30d",
  "this_month",
  "last_month",
]);

export function resolveWindow(
  start: Date,
  end: Date,
  now: Date,
): ResolvedRange {
  for (const p of RANGE_PRESETS) {
    const r = presetRange(p.key, now);
    if (sameDay(r.start, start) && sameDay(r.end, end)) {
      return {
        key: PRESET_TO_BACKEND[p.key],
        start,
        end,
        presetLabel: p.label,
        isCustom: !EXACT_BACKEND_PRESETS.has(p.key),
      };
    }
  }
  const span = daysBetween(start, end) + 1;
  const key: BackendWindowKey =
    span <= 7 ? "last_7d" : span <= 14 ? "last_14d" : span <= 30 ? "last_30d" : "last_month";
  return { key, start, end, presetLabel: "Custom", isCustom: true };
}

export function rangeTriggerLabel(r: ResolvedRange): string {
  if (sameDay(r.start, r.end)) return `${r.presetLabel}: ${fmtDay(r.start)}`;
  return `${r.presetLabel}: ${fmtDay(r.start)} – ${fmtDay(r.end)}`;
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M3.5 9.5h17" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M7.5 3v3M16.5 3v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="3.5" y="5" width="17" height="16" rx="4" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8" cy="14" r="1" fill="currentColor" />
      <circle cx="12" cy="14" r="1" fill="currentColor" />
      <circle cx="16" cy="14" r="1" fill="currentColor" />
    </svg>
  );
}
function ChevronDown({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M6 9.5 12 15.5 18 9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function dayAriaLabel(d: Date): string {
  return `${WEEKDAYS[d.getDay()]}, ${fmtDay(d)}`;
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function MonthCalendar({
  month,
  year,
  start,
  end,
  onPickDay,
  hideHeader = false,
}: {
  month: number;
  year: number;
  start: Date | null;
  end: Date | null;
  onPickDay: (d: Date) => void;
  hideHeader?: boolean;
}) {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  const rangeEnd = end ?? start;
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusDay, setFocusDay] = useState<number | null>(null);
  const tabDay = Math.min(
    focusDay ??
      (start && start.getMonth() === month && start.getFullYear() === year ? start.getDate() : 1),
    daysInMonth,
  );

  const moveFocus = (e: React.KeyboardEvent<HTMLButtonElement>, day: number) => {
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    let next: number | null = null;
    if (e.key in step) next = day + step[e.key];
    else if (e.key === "Home") next = 1;
    else if (e.key === "End") next = daysInMonth;
    if (next == null) return;
    e.preventDefault();
    next = Math.max(1, Math.min(daysInMonth, next));
    setFocusDay(next);
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${next}"]`)?.focus();
  };

  return (
    <div className="flex w-[280px] max-w-full flex-col gap-3">
      {!hideHeader && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-[16px] font-semibold leading-5 text-[#0e0f11]">
              {MONTH_SHORT[month]}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[16px] font-semibold leading-5 text-[#0e0f11]">
              {year}
            </span>
          </div>
        </div>
      )}

      <div className="flex w-full text-center text-[13px] font-medium leading-[18px] text-[#8c8c8c] compact:grid compact:grid-cols-7">
        {WEEKDAYS.map((w) => (
          <span key={w} className="w-[40px] shrink-0 compact:w-auto">
            {w}
          </span>
        ))}
      </div>

      <div ref={gridRef} role="group" aria-label={`${MONTH_SHORT[month]} ${year}`} className="flex flex-wrap compact:grid compact:w-full compact:grid-cols-7">
        {cells.map((day, i) => {
          if (day === null) {
            return <div key={`b${i}`} className="h-[32px] w-[40px] compact:h-[40px] compact:w-auto" />;
          }
          const date = startOfDay(new Date(year, month, day));
          const inRange =
            start != null &&
            rangeEnd != null &&
            date >= start &&
            date <= rangeEnd;
          const isStart = start != null && sameDay(date, start);
          const isEnd = rangeEnd != null && sameDay(date, rangeEnd);
          const isEndpoint = isStart || isEnd;
          const cellBg = inRange ? "bg-[#f0f0f0]" : "";
          const cellRound =
            isStart && isEnd
              ? "rounded-block"
              : isStart
                ? "rounded-l-block"
                : isEnd
                  ? "rounded-r-block"
                  : "";
          return (
            <button
              key={day}
              type="button"
              data-day={day}
              tabIndex={day === tabDay ? 0 : -1}
              aria-label={dayAriaLabel(date)}
              aria-pressed={isEndpoint}
              onClick={() => onPickDay(date)}
              onFocus={() => setFocusDay(day)}
              onKeyDown={(e) => moveFocus(e, day)}
              className={`flex h-[32px] w-[40px] items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-[#027bff] compact:h-[40px] compact:w-full ${cellBg} ${cellRound}`}
            >
              <span
                className={`flex size-[32px] items-center justify-center rounded-[16px] text-[16px] font-medium leading-6 transition-colors compact:size-[36px] compact:rounded-[18px] ${
                  isEndpoint
                    ? "bg-[#1f1f1f] text-white"
                    : "text-[#0e0f11] hover:bg-[#e9e9e9]"
                }`}
              >
                {day}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const POPOVER_GAP = 8;
const VIEWPORT_PAD = 8;

type PopoverPos = { top: number; left: number; width: number };

function placePopover(
  trigger: DOMRect,
  height: number,
  align: "left" | "right",
): PopoverPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = vw < 640 ? 14 : VIEWPORT_PAD;
  const width = Math.min(312, vw - pad * 2);
  let left = align === "right" ? trigger.right - width : trigger.left;
  left = Math.max(pad, Math.min(left, vw - width - pad));
  let top = trigger.bottom + POPOVER_GAP;
  if (top + height > vh - pad && trigger.top - POPOVER_GAP - height >= pad) {
    top = trigger.top - POPOVER_GAP - height;
  }
  top = Math.max(pad, Math.min(top, vh - height - pad));
  return { top, left, width };
}

export function AdsManagerDateRangePicker({
  value,
  onChange,
  now,
  align = "left",
  disabled = false,
  compact = false,
}: {
  value: ResolvedRange;
  onChange: (r: ResolvedRange) => void;
  now?: Date;
  align?: "left" | "right";
  disabled?: boolean;
  compact?: boolean;
}) {
  const today = useMemo(() => now ?? new Date(), [now]);
  const viewportCompact = useIsCompact();
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState<Date | null>(value.start);
  const [draftEnd, setDraftEnd] = useState<Date | null>(value.end);
  const [viewMonth, setViewMonth] = useState(value.start.getMonth());
  const [viewYear, setViewYear] = useState(value.start.getFullYear());
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverPos | null>(null);

  const resetDraft = () => {
    setDraftStart(value.start);
    setDraftEnd(value.end);
    setViewMonth(value.start.getMonth());
    setViewYear(value.start.getFullYear());
  };

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const cancel = () => {
    resetDraft();
    close();
  };

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) {
      setDraftStart(value.start);
      setDraftEnd(value.end);
      setViewMonth(value.start.getMonth());
      setViewYear(value.start.getFullYear());
    }
  }, [value, open]);

  useEffect(() => {
    if (!open) return;
    const inside = (t: Node) =>
      Boolean(rootRef.current?.contains(t) || popRef.current?.contains(t));
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target as Node)) {
        resetDraft();
        close(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        resetDraft();
        close();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value, close]);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const pop = popRef.current;
    if (!trigger || !pop) return;
    setPos(placePopover(trigger.getBoundingClientRect(), pop.offsetHeight, align));
  }, [align]);

  useLayoutEffect(() => {
    if (!open || !compact) return;
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, compact, place, draftStart, draftEnd, viewMonth]);

  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [open]);

  const applyPreset = (key: PresetKey) => {
    const { start, end } = presetRange(key, today);
    setDraftStart(start);
    setDraftEnd(end);
    setViewMonth(start.getMonth());
    setViewYear(start.getFullYear());
  };

  const pickDay = (d: Date) => {
    if (draftStart == null || draftEnd != null || d < draftStart) {
      setDraftStart(d);
      setDraftEnd(null);
    } else {
      setDraftEnd(d);
    }
  };

  const stepMonth = (delta: number) => {
    const m = viewMonth + delta;
    const date = new Date(viewYear, m, 1);
    setViewMonth(date.getMonth());
    setViewYear(date.getFullYear());
  };

  const rightMonth = (viewMonth + 1) % 12;
  const rightYear = viewMonth === 11 ? viewYear + 1 : viewYear;

  const activePreset: PresetKey | null = useMemo(() => {
    if (draftStart == null || draftEnd == null) return null;
    for (const p of RANGE_PRESETS) {
      const r = presetRange(p.key, today);
      if (sameDay(r.start, draftStart) && sameDay(r.end, draftEnd)) return p.key;
    }
    return null;
  }, [draftStart, draftEnd, today]);

  const canApply = draftStart != null && draftEnd != null;

  const apply = () => {
    if (draftStart == null || draftEnd == null) return;
    onChange(resolveWindow(draftStart, draftEnd, today));
    close();
  };

  const compactPopover = (
    <div
      ref={popRef}
      role="dialog"
      aria-modal="false"
      aria-label="Select date range"
      style={
        pos
          ? { top: pos.top, left: pos.left, width: pos.width }
          : { top: 0, left: 0, width: "min(312px, calc(100vw - 16px))", visibility: "hidden" }
      }
      className="date-range-pop fixed z-50 overflow-hidden rounded-[12px] border border-[#f0f0f0] bg-white shadow-[0px_32px_64px_-12px_rgba(16,18,20,0.14)]"
    >
      <div className="flex flex-wrap gap-2 border-b border-[#f0f0f0] p-3">
        {RANGE_PRESETS.map((p) => {
          const active = activePreset === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => applyPreset(p.key)}
              aria-pressed={active}
              className={`rounded-full border px-2.5 py-1 text-[13px] font-medium leading-4 transition-colors compact:min-h-10 compact:px-3 compact:py-2.5 compact:text-[14px] ${
                active
                  ? "border-[#0e0f11] bg-[#0e0f11] text-white"
                  : "border-[#e5e5e5] bg-white text-[#1f1f1f] hover:bg-[#fafafa]"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center px-4 pt-3">
        <button
          type="button"
          onClick={() => stepMonth(-1)}
          aria-label="Previous month"
          className="flex size-8 compact:size-10 items-center justify-center rounded-full text-[#1f1f1f] transition-colors hover:bg-[#f0f0f0]"
        >
          <ChevronDown className="size-5 rotate-90" />
        </button>
        <span className="flex-1 text-center text-[16px] font-semibold leading-5 text-[#0e0f11]" aria-live="polite">
          {MONTH_SHORT[viewMonth]} {viewYear}
        </span>
        <button
          type="button"
          onClick={() => stepMonth(1)}
          aria-label="Next month"
          className="flex size-8 compact:size-10 items-center justify-center rounded-full text-[#1f1f1f] transition-colors hover:bg-[#f0f0f0]"
        >
          <ChevronDown className="size-5 -rotate-90" />
        </button>
      </div>
      <div className="overflow-x-auto px-4 pb-1 pt-1">
        <MonthCalendar
          key={`${viewYear}-${viewMonth}`}
          month={viewMonth}
          year={viewYear}
          start={draftStart}
          end={draftEnd}
          onPickDay={pickDay}
          hideHeader
        />
      </div>
      <div className="flex justify-end gap-2 px-4 py-3">
        <button
          type="button"
          onClick={cancel}
          className="flex h-[36px] items-center justify-center rounded-cta border border-[#f0f0f0] bg-white px-3.5 text-[16px] font-semibold leading-5 text-[#1f1f1f] transition-colors hover:bg-[#fafafa]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canApply}
          onClick={apply}
          className="flex h-[36px] items-center justify-center rounded-cta bg-[#0e0f11] px-3.5 text-[16px] font-semibold leading-5 text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Update
        </button>
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className={compact ? "date-range-root relative" : "date-range-root relative w-[352px]"}>
      {}
      {compact ? (
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={() => (open ? cancel() : setOpen(true))}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={rangeTriggerLabel(value)}
          title={rangeTriggerLabel(value)}
          className={`flex h-8 w-8 items-center justify-center rounded-cta transition-colors hover:bg-[#f0f0f0] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent ${
            open ? "bg-[#f0f0f0] text-[#0e0f11]" : "text-[#5c5c5c] hover:text-[#0e0f11]"
          }`}
        >
          <CalendarIcon className="size-4 shrink-0" />
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={() => (open ? cancel() : setOpen(true))}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex h-[40px] w-full items-center gap-2 rounded-cta border border-[#f0f0f0] bg-white px-[10px] text-left transition-colors hover:bg-[#fafafa] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-white"
        >
          <CalendarIcon className="size-5 shrink-0 text-[#1f1f1f]" />
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-[22px] text-[#0e0f11]">
            {rangeTriggerLabel(value)}
          </span>
          <ChevronDown className="size-5 shrink-0 text-[#1f1f1f]" />
        </button>
      )}

      {open &&
        compact &&
        typeof document !== "undefined" &&
        createPortal(
          compactPopover,
          (viewportCompact
            ? document.querySelector<HTMLElement>(".workspace-shell")
            : null) ?? document.body,
        )}

      {open && !compact && (
        <div
          ref={popRef}
          role="dialog"
          aria-label="Select date range"
          className={`date-range-pop absolute top-[calc(100%+8px)] z-50 flex items-start overflow-hidden rounded-[12px] border border-[#f0f0f0] bg-white shadow-[0px_32px_64px_-12px_rgba(16,18,20,0.14)] ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {}
          <div className="flex w-[180px] shrink-0 flex-col gap-[2px] border-r border-[#f0f0f0] py-4">
            {RANGE_PRESETS.map((p) => {
              const active = activePreset === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => applyPreset(p.key)}
                  aria-pressed={active}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left"
                >
                  <span
                    className={`flex size-[24px] shrink-0 items-center justify-center rounded-full border-2 ${
                      active
                        ? "border-[#0e0f11] shadow-[0px_0px_0px_2px_#f0f0f0]"
                        : "border-[#d9d9d9]"
                    }`}
                  >
                    {active && (
                      <span className="size-[10px] rounded-full bg-[#0e0f11]" />
                    )}
                  </span>
                  <span
                    className={`whitespace-nowrap text-[14px] font-medium leading-[22px] ${
                      active ? "text-[#027bff]" : "text-[#0e0f11]"
                    }`}
                  >
                    {p.label}
                  </span>
                </button>
              );
            })}
          </div>

          {}
          <div className="flex flex-col items-end">
            <div className="flex items-center gap-8 px-6 pt-4">
              <button
                type="button"
                onClick={() => stepMonth(-1)}
                aria-label="Previous month"
                className="flex size-8 items-center justify-center rounded-full text-[#1f1f1f] transition-colors hover:bg-[#f0f0f0]"
              >
                <ChevronDown className="size-5 rotate-90" />
              </button>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => stepMonth(1)}
                aria-label="Next month"
                className="flex size-8 items-center justify-center rounded-full text-[#1f1f1f] transition-colors hover:bg-[#f0f0f0]"
              >
                <ChevronDown className="size-5 -rotate-90" />
              </button>
            </div>
            <div className="flex gap-8 px-6 pb-2 pt-2">
              <MonthCalendar
                key={`${viewYear}-${viewMonth}`}
                month={viewMonth}
                year={viewYear}
                start={draftStart}
                end={draftEnd}
                onPickDay={pickDay}
              />
              <MonthCalendar
                key={`${rightYear}-${rightMonth}`}
                month={rightMonth}
                year={rightYear}
                start={draftStart}
                end={draftEnd}
                onPickDay={pickDay}
              />
            </div>
            <div className="flex gap-3 px-6 py-4">
              <button
                type="button"
                onClick={cancel}
                className="flex h-[40px] items-center justify-center rounded-cta border border-[#f0f0f0] bg-white px-4 text-[16px] font-semibold leading-5 text-[#1f1f1f] transition-colors hover:bg-[#fafafa]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canApply}
                onClick={apply}
                className="flex h-[40px] items-center justify-center rounded-cta bg-[#0e0f11] px-4 text-[16px] font-semibold leading-5 text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Update
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
