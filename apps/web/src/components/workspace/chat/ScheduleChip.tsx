"use client";

import { useEffect, useId, useState } from "react";
import { apiFetch } from "@/lib/api";
import { describeCron, nextRuns } from "../agent/cron-schedule-util";
import { formatInZone, timeZoneLabel } from "@/lib/timezones";
import { ScheduleView } from "../agent/ScheduleView";

type Schedule = {
  cron_expression: string;
  enabled: boolean;
  last_fired_at: string | null;
  timezone: string | null;
};

export function relativeUntil(next: Date, now: Date = new Date()): string {
  const ms = next.getTime() - now.getTime();
  if (ms <= 0) return "now";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min}m`;
  const h = Math.round(min / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

export function scheduleLine(s: Schedule | null, now: Date = new Date()): string {
  if (!s) return "No schedule yet";
  const tz = s.timezone ?? "UTC";
  const desc = describeCron(s.cron_expression, timeZoneLabel(tz)) ?? s.cron_expression;
  if (!s.enabled) return `${desc} · paused`;
  const next = nextRuns(s.cron_expression, s.timezone, 1, now)[0];
  return next ? `${desc} · next run ${relativeUntil(next, now)} (${formatInZone(next, tz)})` : desc;
}

export function ScheduleChip({ slug, label }: { slug: string; label?: string }) {
  const [schedule, setSchedule] = useState<Schedule | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const panelId = useId();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch(`/api/agents/${encodeURIComponent(slug)}/schedule`);
        if (!r.ok) {
          if (!cancelled) setSchedule(null);
          return;
        }
        const data = (await r.json()) as { schedule: Schedule | null };
        if (!cancelled) setSchedule(data.schedule ?? null);
      } catch {
        if (!cancelled) setSchedule(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, open]);

  const line = schedule === undefined ? "Checking schedule…" : scheduleLine(schedule);

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-full items-center gap-2 rounded-full border border-rule bg-white px-2.5 py-1 text-[14px] font-semibold text-ink hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
      >
        <span aria-hidden>🕒</span>
        {label && <span className="font-medium">{label} ·</span>}
        <span className="truncate">{line}</span>
        <span className="text-[13px] font-semibold text-violet">{schedule === null ? "Set one" : "Change"}</span>
      </button>
      {open && (
        <div id={panelId} className="mt-2 rounded-lg border border-rule bg-white p-3">
          <p className="mb-2 text-[13px] text-inkMuted">
            One schedule per channel. Saving replaces the existing one. Each run stages drafts for
            your approval; nothing posts on its own.
          </p>
          <ScheduleView slug={slug} />
        </div>
      )}
    </div>
  );
}
