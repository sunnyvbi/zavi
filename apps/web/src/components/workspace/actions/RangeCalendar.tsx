"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { cardButton } from "./card/styles";
import { addDays, addMonths, daysBetween, firstOfMonth, mediumDate, monthName, parseTypedDate, sameDay, toYmd } from "./dateRange";

const FOCUS = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ca-brand";
const NAV = cn("inline-flex size-8 items-center justify-center rounded-full text-ca-secondary hover:bg-ca-hover hover:text-ca-xdark disabled:pointer-events-none disabled:opacity-30", FOCUS);
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function RangeCalendar({ initial, today, maxDays, onBack, onCancel, onApply }: {
  initial: { from: Date; to: Date };
  today: Date;
  maxDays: number;
  onBack: (() => void) | null;
  onCancel: () => void;
  onApply: (from: Date, to: Date) => void;
}) {
  const [from, setFrom] = useState<Date | null>(initial.from);
  const [to, setTo] = useState<Date | null>(initial.to);
  const [hover, setHover] = useState<Date | null>(null);
  const [active, setActive] = useState<"start" | "end">("start");
  const [typed, setTyped] = useState<{ start: string; end: string } | null>(null);
  const [typoIn, setTypoIn] = useState<"start" | "end" | null>(null);
  const [view, setView] = useState(() => firstOfMonth(initial.to));
  const [focusDay, setFocusDay] = useState(initial.to);
  const grid = useRef<HTMLDivElement>(null);
  const startField = useRef<HTMLInputElement>(null);
  const typoId = useId();

  useEffect(() => {
    startField.current?.focus();
  }, []);

  function pickDay(d: Date) {
    setFocusDay(d);
    setTyped(null);
    setTypoIn(null);
    if (active === "start" || !from || d < from) {
      setFrom(d);
      if (active === "start" || (to && d > to)) setTo(null);
      setActive("end");
      return;
    }
    setTo(d);
    setHover(null);
    setActive("start");
  }

  function commitTyped(which: "start" | "end") {
    if (!typed) return;
    const d = parseTypedDate(typed[which], today);
    if (!d || d > today) return setTypoIn(which);
    if (which === "end" && from && d < from) return setTypoIn("end");
    setTypoIn(null);
    if (which === "start") {
      setFrom(d);
      if (to && d > to) setTo(null);
    } else setTo(d);
    setView(firstOfMonth(d));
    setTyped(null);
  }

  function onGridKey(e: KeyboardEvent<HTMLDivElement>) {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next: Date | null = null;
    if (e.key in step) next = addDays(focusDay, step[e.key]);
    else if (e.key === "PageUp") next = new Date(focusDay.getFullYear(), focusDay.getMonth() - 1, focusDay.getDate());
    else if (e.key === "PageDown") next = new Date(focusDay.getFullYear(), focusDay.getMonth() + 1, focusDay.getDate());
    else if (e.key === "Home") next = addDays(focusDay, -focusDay.getDay());
    else if (e.key === "End") next = addDays(focusDay, 6 - focusDay.getDay());
    if (!next) return;
    e.preventDefault();
    if (next > today) next = today;
    setFocusDay(next);
    setView(firstOfMonth(next));
    const key = toYmd(next);
    requestAnimationFrame(() => grid.current?.querySelector<HTMLButtonElement>(`[data-day="${key}"]`)?.focus());
  }

  const end = to ?? (from && hover && hover >= from && active === "end" ? hover : null);
  const span = from && to ? daysBetween(from, to) : 0;
  const tooLong = span > maxDays;
  const lead = view.getDay();
  const count = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const days = Array.from({ length: Math.ceil((lead + count) / 7) * 7 }, (_, i) => addDays(view, i - lead));
  const focusShown = sameDay(firstOfMonth(focusDay), view);
  const startText = typed?.start ?? (from ? mediumDate(from) : "");
  const endText = typed?.end ?? (to ? mediumDate(to) : "");
  const field = (which: "start" | "end") =>
    cn(
      "h-9 w-full min-w-0 rounded-xl border bg-ca-bg px-2.5 text-[13px] leading-5 text-ca-xdark outline-none placeholder:text-ca-secondary",
      typoIn === which ? "border-ca-danger" : active === which ? "border-ca-xdark ring-1 ring-ca-xdark" : "border-ca-strong hover:border-ca-secondary",
    );
  const status = tooLong ? `Pick ${maxDays} days or fewer` : from && to ? `${span} ${span === 1 ? "day" : "days"}` : from ? "Pick the end date" : "Pick the start date";

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 border-b border-ca-border px-1.5 py-1.5">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back to date ranges" className={NAV}>
            <ChevronLeft className="size-4" aria-hidden />
          </button>
        )}
        <p className={cn("text-sm font-semibold leading-5 text-ca-xdark", !onBack && "px-2 py-1.5")}>Custom range</p>
      </div>

      <div className="p-3">
        <div className="grid grid-cols-2 gap-2">
          {(["start", "end"] as const).map((which) => (
            <label key={which} className="flex min-w-0 flex-col gap-1">
              <span className="text-xs font-medium leading-4 text-ca-secondary">{which === "start" ? "Start date" : "End date"}</span>
              <input
                ref={which === "start" ? startField : undefined}
                value={which === "start" ? startText : endText}
                placeholder="MMM D, YYYY"
                onFocus={() => setActive(which)}
                onChange={(e) => setTyped({ start: startText, end: endText, [which]: e.target.value })}
                onBlur={() => commitTyped(which)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  commitTyped(which);
                }}
                aria-invalid={typoIn === which}
                aria-describedby={typoIn === which ? typoId : undefined}
                className={field(which)}
              />
            </label>
          ))}
        </div>
        {typoIn && (
          <p id={typoId} className="mt-1.5 text-xs font-medium leading-4 text-ca-danger">
            {typoIn === "end" && from ? `Use a date from ${mediumDate(from)} to today.` : `Use a date up to today, like ${mediumDate(today)}.`}
          </p>
        )}

        <div className="mt-3 flex h-8 items-center justify-between">
          <button type="button" onClick={() => setView(addMonths(view, -1))} aria-label="Previous month" className={NAV}>
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <p aria-live="polite" className="text-sm font-semibold leading-5 text-ca-xdark">{monthName(view)}</p>
          <button type="button" onClick={() => setView(addMonths(view, 1))} disabled={sameDay(view, firstOfMonth(today))} aria-label="Next month" className={NAV}>
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
        <div aria-hidden className="mt-1 grid grid-cols-7">
          {WEEKDAYS.map((w) => (
            <span key={w} className="flex h-7 items-center justify-center text-xs font-medium leading-4 text-ca-secondary">{w}</span>
          ))}
        </div>
        <div ref={grid} role="group" aria-label={monthName(view)} onKeyDown={onGridKey} onPointerLeave={() => setHover(null)} className="grid grid-cols-7 gap-y-0.5">
          {days.map((d) => {
            const key = toYmd(d);
            if (d.getMonth() !== view.getMonth()) return <span key={key} aria-hidden className="h-9" />;
            const isStart = sameDay(d, from);
            const isEnd = sameDay(d, end);
            const banded = !!from && !!end && !sameDay(from, end) && d >= from && d <= end;
            const dow = d.getDay();
            const isToday = sameDay(d, today);
            return (
              <span
                key={key}
                className={cn(
                  "flex h-9 items-center justify-center",
                  banded && "bg-ca-surface",
                  banded && (isStart || dow === 0 || d.getDate() === 1) && "rounded-l-full",
                  banded && (isEnd || dow === 6 || d.getDate() === count) && "rounded-r-full",
                )}
              >
                <button
                  type="button"
                  data-day={key}
                  tabIndex={(focusShown ? sameDay(d, focusDay) : d.getDate() === 1) ? 0 : -1}
                  disabled={d > today}
                  onClick={() => pickDay(d)}
                  onPointerEnter={() => setHover(d)}
                  onFocus={() => setFocusDay(d)}
                  aria-pressed={isStart || isEnd}
                  aria-current={isToday ? "date" : undefined}
                  aria-label={d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                  className={cn(
                    "relative flex size-9 items-center justify-center rounded-full text-[13px] font-medium leading-5 tabular-nums disabled:pointer-events-none disabled:text-ca-secondary disabled:opacity-40",
                    FOCUS,
                    isStart || isEnd ? "bg-ca-action text-ca-on-action" : "text-ca-dark hover:bg-ca-hover",
                  )}
                >
                  {d.getDate()}
                  {isToday && !(isStart || isEnd) && <span aria-hidden className="absolute bottom-1 size-1 rounded-full bg-ca-xdark" />}
                </button>
              </span>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-ca-border px-3 py-2.5">
        <p role="status" className={cn("min-w-0 flex-1 text-[13px] leading-5", tooLong ? "font-medium text-ca-danger" : "text-ca-secondary")}>{status}</p>
        <button type="button" onClick={onCancel} className={cn(cardButton.base, cardButton.ghost)}>Cancel</button>
        <button type="button" onClick={() => from && to && onApply(from, to)} disabled={!from || !to || tooLong} className={cn(cardButton.base, cardButton.primary, "disabled:pointer-events-none disabled:opacity-50")}>Apply</button>
      </div>
    </div>
  );
}
