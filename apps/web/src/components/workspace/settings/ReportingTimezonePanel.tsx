"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock, LoaderCircle, Sparkles } from "lucide-react";
import { apiFetch } from "@/lib/api";

type TzSource = "stored" | "ga4_property" | "meta_ad_account" | "booking_config" | "default";
type TzBody = { reporting_timezone: string | null; effective: string; source: TzSource };
type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; body: TzBody };

const DETECTED_FROM: Record<string, string> = {
  ga4_property: "Google Analytics",
  meta_ad_account: "your Meta ad account",
  booking_config: "your booking settings",
};

const COMMON = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Australia/Sydney",
  "UTC",
];

function allZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list && list.length > 0) return list.includes("UTC") ? list : [...list, "UTC"];
  } catch {
  }
  return COMMON;
}

function utcMidnightLocal(): string | null {
  try {
    const d = new Date();
    const utcMidnight = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    if (utcMidnight.getTimezoneOffset() === 0) return null;
    return utcMidnight.toLocaleTimeString("en-US", { hour: "numeric" });
  } catch {
    return null;
  }
}

export function ReportingTimezonePanel({ readOnly = false }: { readOnly?: boolean }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [draft, setDraft] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      const res = await apiFetch("/api/tenant/me/reporting-timezone");
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as TzBody;
      setLoad({ state: "ready", body });
      setDraft(body.effective);
    } catch {
      setLoad({ state: "failed" });
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  const zones = useMemo(allZones, []);

  const write = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/tenant/me/reporting-timezone", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reporting_timezone: value }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Could not save the timezone. Try again.");
        return;
      }
      await read();
    } catch (e) {
      setError((e as Error).message || "Could not save the timezone. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const body = load.state === "ready" ? load.body : null;
  const dirty = !!body && draft !== body.effective;
  const localAt = utcMidnightLocal();

  return (
    <section className="rounded-2xl border border-rule bg-white p-4 dark:bg-cream" data-testid="reporting-timezone">
      <label htmlFor="reporting-tz" className="text-[14px] font-medium text-ink">
        Reporting timezone
      </label>

      {load.state === "loading" && (
        <p role="status" className="mt-2 flex h-[76px] items-start gap-2 text-[14px] text-inkMuted">
          <LoaderCircle aria-hidden className="mt-0.5 h-4 w-4 animate-spin" />
          Loading the reporting timezone
        </p>
      )}

      {load.state === "failed" && (
        <div className="mt-2 flex h-[76px] flex-col items-start gap-2 text-[14px] text-inkMuted">
          <p>The reporting timezone could not be loaded.</p>
          <button
            type="button"
            onClick={() => {
              setLoad({ state: "loading" });
              void read();
            }}
            className="inline-flex h-8 items-center rounded-cta border border-rule px-3 text-[13px] font-semibold text-ink hover:bg-creamDeep"
          >
            Try again
          </button>
        </div>
      )}

      {body && (
        <>
          {body.source === "stored" && (
            <p className="mt-1 text-[14px] text-inkMuted">Saved for this workspace.</p>
          )}
          {DETECTED_FROM[body.source] && (
            <p className="mt-1 flex items-center gap-2 text-[14px] text-inkMuted">
              <Sparkles aria-hidden className="h-3.5 w-3.5 text-brand" />
              {`Auto-detected from ${DETECTED_FROM[body.source]}: ${body.effective}`}
            </p>
          )}
          {body.source === "default" && (
            <p className="mt-2 flex items-start gap-2 rounded-lg border border-marigoldDeep/40 bg-warnBg px-3 py-2 text-[14px] text-warn">
              <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              {`No timezone found in your connected tools, so Zavi is using UTC. Set your timezone${
                localAt ? `: right now a day ends at ${localAt} your time.` : "."
              }`}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              id="reporting-tz"
              value={draft}
              disabled={readOnly || busy}
              onChange={(e) => setDraft(e.target.value)}
              className="h-10 min-w-[260px] max-w-full rounded-lg border border-rule bg-white px-3 text-[14px] font-medium text-ink disabled:opacity-60 dark:bg-cream"
            >
              {!zones.includes(draft) && draft && <option value={draft}>{draft}</option>}
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
            {!readOnly && (
              <button
                type="button"
                disabled={!dirty || busy}
                onClick={() => void write(draft)}
                className="inline-flex h-10 items-center rounded-cta bg-ink px-4 text-[14px] font-semibold text-cream hover:bg-inkSoft disabled:cursor-not-allowed disabled:opacity-35"
              >
                {busy ? "Saving..." : "Save"}
              </button>
            )}
            {!readOnly && body.source === "stored" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void write(null)}
                className="inline-flex h-10 items-center rounded-cta border border-rule px-3.5 text-[14px] font-semibold text-ink hover:bg-creamDeep disabled:opacity-50"
              >
                Reset to auto
              </button>
            )}
          </div>

          <p className="mt-3 flex items-center gap-2 text-[13px] text-inkMuted">
            <Clock aria-hidden className="h-3.5 w-3.5" />
            {`Days start at midnight in ${body.effective}. Every receipt shows this timezone.`}
          </p>
          <ul className="mt-3 grid gap-1 text-[13px] text-inkMuted sm:grid-cols-2">
            <li>Used for: chat answers and charts</li>
            <li>Used for: goal pace</li>
            <li>Used for: the numbers Autopilot acts on</li>
            <li>Used for: queries Zavi runs on your database</li>
          </ul>
        </>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
