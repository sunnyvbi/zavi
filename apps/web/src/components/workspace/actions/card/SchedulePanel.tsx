"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { dayParts } from "../ChannelSchedule";
import { SCHEDULE_DAYS_AHEAD, SCHEDULE_STRIP, clockOf, dayInTimeZone, monthLabel, shiftDay, shiftMonth, soonTime, time24, wallTimeInZone, type Clock } from "../scheduleTime";
import type { ActionHandlers, ActionItem } from "../types";
import { CardButton } from "./CardButton";

const block = "rounded-xl bg-ca-subtle p-2";
const arrow = "grid size-8 shrink-0 place-items-center rounded-full text-ca-secondary hover:bg-ca-hover hover:text-ca-primary focus-visible:shadow-ca-focus focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40";
const field = "h-10 w-12 rounded-xl border border-ca-border bg-ca-bg text-center text-sm font-semibold text-ca-xdark focus-visible:border-ca-border-focus focus-visible:outline-none";
const digits = (v: string): string => v.replace(/\D/g, "").slice(0, 2);

export function SchedulePanel({ action, onMove, onDone }: {
  action: ActionItem;
  onMove: NonNullable<ActionHandlers["onMovePlanDay"]>;
  onDone: () => void;
}) {
  const now = new Date();
  const timeZone = action.plan_timezone ?? null;
  const min = dayInTimeZone(now, timeZone);
  const max = shiftDay(min, SCHEDULE_DAYS_AHEAD);
  const timed = "plan_time" in action;
  const held = action.plan_day && action.plan_day >= min && action.plan_day <= max ? action.plan_day : min;
  const [day, setDay] = useState(held);
  const [start, setStart] = useState(held);
  const [clock, setClock] = useState<Clock>(() => clockOf(action.plan_time ?? (held === min ? soonTime(now, timeZone) : "09:00")));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = (to: string) => setStart(to < min ? min : to > max ? max : to);
  const days = Array.from({ length: SCHEDULE_STRIP }, (_, i) => shiftDay(start, i));
  const time = timed ? time24(clock) : null;
  const passed = !!time && day === min && time <= wallTimeInZone(now, timeZone);
  const ready = !busy && (!timed || (!!time && !passed));
  const send = async (to: string | null) => {
    setBusy(true);
    setError(null);
    const refusal = await onMove(action, to, to && time ? time : undefined);
    setBusy(false);
    if (refusal) setError(refusal);
    else onDone();
  };

  return (
    <div data-testid="day-picker" className="flex flex-col gap-2">
      <div className={cn(block, "flex items-center justify-between")}>
        <button type="button" aria-label="Previous month" disabled={start.slice(0, 7) <= min.slice(0, 7)} onClick={() => go(shiftMonth(start, -1))} className={arrow}>
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <p aria-live="polite" className="text-sm font-semibold text-ca-xdark">{monthLabel(start)}</p>
        <button type="button" aria-label="Next month" disabled={start.slice(0, 7) >= max.slice(0, 7)} onClick={() => go(shiftMonth(start, 1))} className={arrow}>
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>
      <div className={cn(block, "flex items-center gap-1")}>
        <button type="button" aria-label="Earlier days" disabled={start <= min} onClick={() => go(shiftDay(start, -SCHEDULE_STRIP))} className={arrow}>
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        {days.map((d) => {
          const p = dayParts(d);
          return (
            <button
              key={d}
              type="button"
              aria-label={`${p.dow} ${p.date}`}
              aria-pressed={day === d}
              disabled={busy || d > max}
              onClick={() => setDay(d)}
              className={cn(
                "flex min-w-0 flex-1 flex-col items-center rounded-xl py-1.5 transition-colors duration-ca-press focus-visible:shadow-ca-focus focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40",
                day === d ? "bg-ca-action text-ca-on-action" : "text-ca-secondary hover:bg-ca-hover hover:text-ca-primary",
              )}
            >
              <span className="text-xs font-medium">{p.dow}</span>
              <span className="text-base font-semibold">{Number(d.slice(8))}</span>
            </button>
          );
        })}
        <button type="button" aria-label="Later days" disabled={shiftDay(start, SCHEDULE_STRIP) > max} onClick={() => go(shiftDay(start, SCHEDULE_STRIP))} className={arrow}>
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>
      {timed && (
        <div className={cn(block, "flex items-center justify-center gap-2")}>
          <input aria-label="Hour" inputMode="numeric" autoComplete="off" value={clock.hour} disabled={busy} onChange={(e) => setClock({ ...clock, hour: digits(e.target.value) })} className={field} />
          <span className="text-sm font-semibold text-ca-secondary" aria-hidden>:</span>
          <input
            aria-label="Minute"
            inputMode="numeric"
            autoComplete="off"
            value={clock.minute}
            disabled={busy}
            onChange={(e) => setClock({ ...clock, minute: digits(e.target.value) })}
            onBlur={() => clock.minute && setClock({ ...clock, minute: clock.minute.padStart(2, "0") })}
            className={field}
          />
          <span className="ml-1 flex rounded-full border border-ca-border bg-ca-bg p-0.5">
            {[false, true].map((pm) => (
              <button
                key={String(pm)}
                type="button"
                aria-pressed={clock.pm === pm}
                disabled={busy}
                onClick={() => setClock({ ...clock, pm })}
                className={cn(
                  "h-8 rounded-full px-3 text-xs font-semibold transition-colors duration-ca-press focus-visible:shadow-ca-focus focus-visible:outline-none",
                  clock.pm === pm ? "bg-ca-action text-ca-on-action" : "text-ca-secondary hover:text-ca-primary",
                )}
              >
                {pm ? "PM" : "AM"}
              </button>
            ))}
          </span>
        </div>
      )}
      {timed && !time && <p role="status" className="px-1 text-xs text-ca-danger">Enter a time like 9:30.</p>}
      {passed && <p role="status" className="px-1 text-xs text-ca-danger">That time has passed. Pick a later one.</p>}
      {error && <p role="alert" className="px-1 text-xs text-ca-danger">{error}</p>}
      <div className="flex items-center justify-between gap-2 pt-1">
        {action.plan_day ? <CardButton variant="ghost" disabled={busy} onClick={() => void send(null)}>Take off the calendar</CardButton> : <span />}
        <CardButton variant="primary" disabled={!ready} aria-busy={busy || undefined} onClick={() => void send(day)}>
          {busy ? "Scheduling…" : "Schedule"}
        </CardButton>
      </div>
    </div>
  );
}
