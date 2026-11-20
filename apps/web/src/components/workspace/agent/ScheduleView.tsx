"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Input } from "@/components/Input";
import { Skeleton } from "../Skeleton";
import {
  cronNextRun,
  cronRunsPerDay,
  cronToShape,
  describeCron,
  nextRuns,
  parseTimeOfDay,
  shapeToCron,
  timeOfDay,
  type ScheduleShape,
} from "./cron-schedule-util";
import {
  browserTimeZone,
  formatInZone,
  timeZoneLabel,
  timeZoneOptions,
} from "@/lib/timezones";

type Schedule = {
  agent_slug: string;
  cron_expression: string;
  enabled: boolean;
  last_fired_at: string | null;
  timezone: string | null;
};

const SHAPES: { id: ScheduleShape; label: string }[] = [
  { id: "daily", label: "Every day" },
  { id: "weekdays", label: "Weekdays (Mon to Fri)" },
  { id: "weekly", label: "Every week (Monday)" },
  { id: "hourly", label: "Every hour" },
  { id: "custom", label: "Custom (advanced)" },
];

const HOURLY_MINUTES = [0, 5, 10, 15, 20, 30, 45];

function summarize(shape: ScheduleShape, time: string, zoneLabel: string, cron: string): string {
  const { hour, minute } = parseTimeOfDay(time);
  const hour12 = ((hour + 11) % 12) + 1;
  const clock = `${hour12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
  switch (shape) {
    case "daily":
      return `Every day at ${clock} in ${zoneLabel}.`;
    case "weekdays":
      return `Weekdays at ${clock} in ${zoneLabel}.`;
    case "weekly":
      return `Every Monday at ${clock} in ${zoneLabel}.`;
    case "hourly":
      return `Every hour at :${String(minute).padStart(2, "0")} past the hour, in ${zoneLabel}.`;
    case "custom":
      return describeCron(cron, zoneLabel) ?? "Not a valid 5-field cron expression.";
  }
}

export function ScheduleView({ slug }: { slug: string }) {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [cron, setCron] = useState("0 9 * * *");
  const [enabled, setEnabled] = useState(true);
  const [lastFired, setLastFired] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [tz, setTz] = useState<string>("UTC");
  const [stopWarning, setStopWarning] = useState<string | null>(null);
  const [savedTz, setSavedTz] = useState<string | null>(null);
  const [savedCron, setSavedCron] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    setSaveMsg(null);
    setTz(browserTimeZone());
    apiFetch(`/api/agents/${encodeURIComponent(slug)}/schedule`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          setErrorMsg(`Couldn't load schedule (${r.status}).`);
          setLoading(false);
          return;
        }
        const { schedule, warning } = (await r.json()) as {
          schedule: Schedule | null;
          warning?: string;
        };
        setStopWarning(warning ?? null);
        if (schedule) {
          setCron(schedule.cron_expression);
          setEnabled(schedule.enabled);
          setLastFired(schedule.last_fired_at);
          setExists(true);
          setSavedCron(schedule.cron_expression);
          setSavedTz(schedule.timezone ?? null);
          if (schedule.timezone) setTz(schedule.timezone);
        }
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setErrorMsg((e as Error).message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function save() {
    setBusy(true);
    setSaveMsg(null);
    setErrorMsg(null);
    try {
      const r = await apiFetch(`/api/agents/${encodeURIComponent(slug)}/schedule`, {
        method: "PUT",
        body: JSON.stringify({ cron_expression: cron, enabled, timezone: tz }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        warning?: string;
        error?: { message?: string };
      };
      if (!r.ok) {
        setErrorMsg(j.error?.message ?? `Save failed (${r.status}).`);
      } else {
        setExists(true);
        setSavedCron(cron);
        setSavedTz(tz);
        setStopWarning(j.warning ?? null);
        setSaveMsg(j.warning ? `Saved. ${j.warning}` : "Saved.");
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setRunning(true);
    setSaveMsg(null);
    setErrorMsg(null);
    try {
      const r = await apiFetch(`/api/agents/${encodeURIComponent(slug)}/run`, {
        method: "POST",
        body: JSON.stringify({}),
        idempotent: true,
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
        setErrorMsg(j.error?.message ?? `Couldn't start a run (${r.status}).`);
      } else {
        setSaveMsg("Run started. Track it in the Runs tab.");
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function remove() {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Delete this schedule? The agent will stop running automatically until you set a new one.",
      )
    ) {
      return;
    }
    setBusy(true);
    setSaveMsg(null);
    setErrorMsg(null);
    try {
      const r = await apiFetch(`/api/agents/${encodeURIComponent(slug)}/schedule`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
        setErrorMsg(j.error?.message ?? `Delete failed (${r.status}).`);
      } else {
        setExists(false);
        setLastFired(null);
        setSavedCron(null);
        setSavedTz(null);
        setStopWarning(null);
        setSaveMsg("Schedule removed.");
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const { shape, time } = useMemo(() => cronToShape(cron), [cron]);
  const zoneLabel = useMemo(() => timeZoneLabel(tz), [tz]);
  const zoneChoices = useMemo(() => timeZoneOptions(savedTz), [savedTz]);
  const runsPerDay = useMemo(() => cronRunsPerDay(cron), [cron]);
  const upcoming = useMemo(
    () => (enabled ? nextRuns(cron, tz, 3) : []),
    [cron, tz, enabled],
  );
  const legacyLocalFire = useMemo(() => {
    if (!savedCron || savedTz !== null || !exists) return null;
    const next = cronNextRun(savedCron, new Date(), null);
    return next ? formatInZone(next, browserTimeZone()) : null;
  }, [savedCron, savedTz, exists]);

  if (loading) {
    return (
      <div role="status" aria-busy="true" className="space-y-5">
        <div>
          <Skeleton className="mb-2 h-[20px] w-28" />
          <Skeleton className="h-3 w-full max-w-[520px]" delayMs={60} />
          <Skeleton className="mt-1.5 h-3 w-4/5 max-w-[440px]" delayMs={120} />
        </div>

        <section className="space-y-4 rounded-lg border border-ink/10 bg-white p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i}>
                <Skeleton className="mb-1 h-3 w-20" delayMs={i * 80} />
                <Skeleton className="h-[30px] w-full" delayMs={i * 80 + 40} />
              </div>
            ))}
          </div>

          <div>
            <Skeleton className="mb-1 h-3 w-16" delayMs={160} />
            <Skeleton className="h-[30px] w-full" delayMs={200} />
            <Skeleton className="mt-1 h-[11px] w-3/4 max-w-[380px]" delayMs={240} />
          </div>

          <div className="rounded-md border border-ink/10 bg-bone/60 p-3">
            <Skeleton className="h-3.5 w-52" delayMs={280} />
            <Skeleton className="mt-2 h-3 w-24" delayMs={320} />
            <div className="mt-1 space-y-1">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-3 w-40" delayMs={360 + i * 40} />
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 shrink-0" delayMs={480} />
            <Skeleton className="h-3.5 w-16" delayMs={520} />
          </div>

          <Skeleton className="h-3 w-44" delayMs={560} />

          <div className="rounded-md border border-ink/10 bg-white p-2">
            <Skeleton className="h-3 w-20" delayMs={600} />
          </div>

          <div className="flex gap-3">
            <Skeleton className="h-8 w-16" delayMs={640} />
            <Skeleton className="h-8 w-16" delayMs={680} />
          </div>
        </section>

        <span className="sr-only">Loading schedule</span>
      </div>
    );
  }

  const summary = summarize(shape, time, zoneLabel, cron);
  const spendHint =
    runsPerDay && runsPerDay > 0
      ? `About ${runsPerDay} run${runsPerDay === 1 ? "" : "s"} a day. More often means more spend (each run uses agent credits).`
      : "More often means more spend (each run uses agent credits).";

  const onShapeChange = (next: ScheduleShape) => {
    const built = shapeToCron(next, time);
    if (built) setCron(built);
  };
  const onTimeChange = (next: string) => {
    const built = shapeToCron(shape, next);
    if (built) setCron(built);
  };
  const onHourlyMinuteChange = (minute: number) => {
    const built = shapeToCron("hourly", timeOfDay(0, minute));
    if (built) setCron(built);
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 font-display text-[16px] font-semibold text-ink">
          Schedule
        </h2>
        <p className="text-[13px] text-inkMuted">
          Run this agent automatically. The time you pick is the time where you
          are, and it stays right through daylight saving. Minimum cadence: every
          5 minutes.
        </p>
      </div>

      {stopWarning && (
        <div
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-[13px] text-amber-900"
        >
          <p className="font-medium">This schedule will not run.</p>
          <p className="mt-1 leading-[1.5]">{stopWarning}</p>
        </div>
      )}

      {savedTz === null && exists && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-[13px] text-amber-900">
          <p className="font-medium">This schedule has no timezone yet.</p>
          <p className="mt-1 leading-[1.5]">
            Until you set one, its time is read as UTC, so it does not fire at
            the hour the label suggests.{" "}
            {legacyLocalFire
              ? `Right now the next run lands at ${legacyLocalFire} in ${timeZoneLabel(browserTimeZone())}.`
              : ""}{" "}
            Pick your timezone below and save to fix it.
          </p>
        </div>
      )}

      <section className="space-y-4 rounded-lg border border-ink/10 bg-white p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="schedule-shape"
              className="mb-1 block text-[14px] font-medium text-inkMuted"
            >
              How often
            </label>
            <select
              id="schedule-shape"
              className="w-full rounded-md border border-ink/15 bg-white px-2 py-1.5 text-[14px] font-medium text-ink"
              value={shape}
              onChange={(e) => onShapeChange(e.target.value as ScheduleShape)}
            >
              {SHAPES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {shape === "hourly" ? (
            <div>
              <label
                htmlFor="schedule-hourly-minute"
                className="mb-1 block text-[14px] font-medium text-inkMuted"
              >
                Minutes past the hour
              </label>
              <select
                id="schedule-hourly-minute"
                className="w-full rounded-md border border-ink/15 bg-white px-2 py-1.5 text-[14px] font-medium text-ink"
                value={parseTimeOfDay(time).minute}
                onChange={(e) => onHourlyMinuteChange(Number(e.target.value))}
              >
                {HOURLY_MINUTES.map((m) => (
                  <option key={m} value={m}>
                    :{String(m).padStart(2, "0")}
                  </option>
                ))}
              </select>
            </div>
          ) : shape === "custom" ? (
            <div>
              <span className="mb-1 block text-[14px] font-medium text-inkMuted">
                Time
              </span>
              <p className="pt-1.5 text-[13px] text-inkMuted leading-[1.5]">
                Set by the expression under Advanced below.
              </p>
            </div>
          ) : (
            <div>
              <label
                htmlFor="schedule-time"
                className="mb-1 block text-[14px] font-medium text-inkMuted"
              >
                At
              </label>
              <Input
                id="schedule-time"
                type="time"
                value={time}
                onChange={(e) => onTimeChange(e.target.value)}
                className="text-[14px] font-medium"
              />
            </div>
          )}
        </div>

        <div>
          <label
            htmlFor="schedule-timezone"
            className="mb-1 block text-[14px] font-medium text-inkMuted"
          >
            Timezone
          </label>
          <select
            id="schedule-timezone"
            className="w-full rounded-md border border-ink/15 bg-white px-2 py-1.5 text-[14px] font-medium text-ink"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
          >
            {zoneChoices.map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[13px] text-inkMuted">{spendHint}</p>
        </div>

        <div className="rounded-md border border-ink/10 bg-bone/60 p-3">
          <div className="text-[13px] font-medium text-ink">{summary}</div>
          <div className="mt-2 text-[13px] text-inkMuted">
            {!enabled ? (
              <span>Next 3 runs: paused while this schedule is off.</span>
            ) : upcoming.length > 0 ? (
              <>
                <span className="block">Next 3 runs</span>
                <ul className="mt-1 space-y-0.5">
                  {upcoming.map((d) => (
                    <li key={d.toISOString()} className="text-ink">
                      {formatInZone(d, tz)}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <span>
                Next 3 runs: none. Check the expression under Advanced.
              </span>
            )}
          </div>
        </div>

        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-ink"
          />
          Enabled
        </label>

        <div className="text-[13px] text-inkMuted">
          Last run:{" "}
          <span className="text-ink">
            {lastFired ? formatInZone(new Date(lastFired), tz) : "never"}
          </span>
        </div>

        <details className="rounded-md border border-ink/10 bg-white p-2">
          <summary className="cursor-pointer text-[13px] font-semibold text-inkMuted">
            Advanced
          </summary>
          <div className="mt-2">
            <label
              htmlFor="schedule-cron"
              className="mb-1 block text-[14px] font-medium text-inkMuted"
            >
              Cron expression
            </label>
            <Input
              id="schedule-cron"
              type="text"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              spellCheck={false}
              className="font-mono text-[14px] font-medium"
              placeholder="0 9 * * *"
            />
            <p className="mt-1 text-[13px] text-inkMuted">
              {describeCron(cron, zoneLabel) ??
                "Not a valid 5-field cron expression."}
            </p>
          </div>
        </details>

        {errorMsg && (
          <div className="rounded-md border border-rose-300 bg-rose-50 p-2 text-[13px] text-rose-900">
            {errorMsg}
          </div>
        )}
        {saveMsg && (
          <div className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-[13px] text-emerald-900">
            {saveMsg}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="rounded-cta border border-transparent bg-ink px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-inkSoft disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            disabled={busy || running}
            onClick={runNow}
            className="rounded-cta border border-ink/15 bg-white px-3 py-1.5 text-[13px] font-semibold text-ink hover:border-ink/30 disabled:opacity-50"
          >
            {running ? "Starting…" : "Run now"}
          </button>
          {exists && (
            <button
              type="button"
              disabled={busy}
              onClick={remove}
              className="rounded-cta border border-ink/15 bg-white px-3 py-1.5 text-[13px] font-semibold text-ink hover:border-ink/30 disabled:opacity-50"
            >
              Delete
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
