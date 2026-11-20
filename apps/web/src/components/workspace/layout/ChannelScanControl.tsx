"use client";

import { useEffect, useRef, useState } from "react";
import { Clock, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { planRefusalTier, useChannelPlanLock, type ChannelPlanLock } from "../actions/channelPlanLock";
import { ChannelControlsSlot } from "./ChannelHeaderRow";
import { useAgentDashboard, type DashboardState } from "../agent/dashboard-ui";
import type { ChannelScanSpec, ChannelScanState } from "../actions/types";
import { registerChannelScan, type ChannelScanHandle } from "./channelScanHandle";

const ERROR_CLEAR_MS = 6000;

const REFUSAL_FALLBACK: Record<string, string> = {
  rate_limited: "A scan ran a few minutes ago. Try again in a few minutes.",
  tenant_cap_reached: "This week's scan budget is used up. Scans resume as the 7-day window rolls.",
  fleet_cap_reached: "Zavi has hit today's Reddit scan limit across all workspaces. Try again tomorrow.",
};

type ScanRefusalBody = {
  reason?: unknown;
  message?: unknown;
  error?: unknown;
};

function refusalReason(b: ScanRefusalBody | undefined): string | undefined {
  if (!b) return undefined;
  if (typeof b.reason === "string") return b.reason;
  if (typeof b.error === "string") return b.error;
  const code = (b.error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function refusalMessage(b: ScanRefusalBody | undefined): string | undefined {
  if (!b) return undefined;
  if (typeof b.message === "string" && b.message) return b.message;
  const msg = (b.error as { message?: unknown } | null | undefined)?.message;
  return typeof msg === "string" && msg ? msg : undefined;
}

export function scanAgo(iso: string | null | undefined): string {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "-";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const LATCH_MAX_MS = 30_000;

function ScanAgo({ at }: { at: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return <>{scanAgo(at)}</>;
}

async function startScan(
  endpoint: string,
  channelName: string,
  planLock: ChannelPlanLock | null = null,
): Promise<string | null> {
  try {
    const res = await apiFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: "manual" }),
    });
    if (res.ok) return null;
    const body =
      res.status === 409 || res.status === 429 || res.status === 403
        ? await res
            .json()
            .then((b: ScanRefusalBody) => b)
            .catch(() => undefined)
        : undefined;
    if (res.status === 409) return "A scan is already running.";
    if (res.status === 429) {
      const reason = refusalReason(body);
      const message = refusalMessage(body);
      if (message) return message;
      return (reason && REFUSAL_FALLBACK[reason]) ?? "A scan ran a few minutes ago, or this week's scan budget is used up.";
    }
    if (res.status === 403) {
      const refusal = planRefusalTier(res.status, body);
      if (refusal) {
        if (planLock) {
          planLock.upgrade(refusal.tier);
          return "upgrade";
        }
        return refusalMessage(body) ?? `${channelName} needs the Starter plan ($20/mo).`;
      }
      return refusalMessage(body) ?? "Only an owner or an admin can change this.";
    }
    if (res.status === 422) {
      const reason = await res
        .json()
        .then((b: { reason?: string }) => b?.reason)
        .catch(() => undefined);
      if (reason === "disabled")
        return `${channelName} scanning is turned off.`;
      if (reason === "not_configured")
        return `${channelName} scanning isn't set up yet.`;
      return "Track a keyword, a competitor or a subreddit first, then scan.";
    }
    return "Couldn't start the scan. Try again in a moment.";
  } catch {
    return "Couldn't reach Zavi. Check your connection.";
  }
}

export function ChannelScanControl({
  slug,
  name,
  scan,
  dashboard,
  surfaceOff = false,
}: {
  slug: string;
  name: string;
  scan?: ChannelScanSpec;
  dashboard?: DashboardState<unknown>;
  surfaceOff?: boolean;
}) {
  if (!scan) return null;
  if (dashboard)
    return (
      <ScanView
        slug={slug}
        name={name}
        scan={scan}
        dashboard={dashboard}
        surfaceOff={surfaceOff}
      />
    );
  return (
    <ScanControl slug={slug} name={name} scan={scan} surfaceOff={surfaceOff} />
  );
}

function ScanControl({
  slug,
  name,
  scan,
  surfaceOff,
}: {
  slug: string;
  name: string;
  scan: ChannelScanSpec;
  surfaceOff: boolean;
}) {
  const dashboard = useAgentDashboard<unknown>(slug);
  return (
    <ScanView
      slug={slug}
      name={name}
      scan={scan}
      dashboard={dashboard}
      surfaceOff={surfaceOff}
    />
  );
}

function ScanView({
  slug,
  name,
  scan,
  dashboard,
  surfaceOff = false,
}: {
  slug: string;
  name: string;
  scan: ChannelScanSpec;
  dashboard: DashboardState<unknown>;
  surfaceOff?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const planLock = useChannelPlanLock();
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dataAtClick = useRef<unknown>(null);
  const inFlight = useRef(false);
  const posting = useRef(false);
  const latestData = useRef<unknown>(dashboard.data);
  latestData.current = dashboard.data;

  useEffect(() => {
    return () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
    };
  }, []);

  useEffect(() => {
    if (
      busy &&
      !posting.current &&
      dataAtClick.current !== null &&
      dashboard.data !== dataAtClick.current
    ) {
      dataAtClick.current = null;
      inFlight.current = false;
      setBusy(false);
    }
  }, [busy, dashboard.data]);

  const silentRefresh = useRef(dashboard.refreshSilent ?? dashboard.refresh);
  silentRefresh.current = dashboard.refreshSilent ?? dashboard.refresh;
  useEffect(() => {
    if (!busy) return;
    const id = setTimeout(() => {
      if (posting.current) return;
      dataAtClick.current = null;
      inFlight.current = false;
      setBusy(false);
      silentRefresh.current();
    }, LATCH_MAX_MS);
    return () => clearTimeout(id);
  }, [busy, posted]);

  const state: ChannelScanState | null = dashboard.data
    ? scan.freshnessOf(dashboard.data)
    : null;

  const firstLoad = dashboard.loading && dashboard.data === null;

  const running = busy || !!state?.running;
  const blockedWhy = !state
    ? null
    : state.blockedWhy
      ? state.blockedWhy
      : !state.enabled
        ? `${name} scanning is turned off.`
        : state.budgetExhausted
          ? "This week's scan budget is used up. Scans resume as the 7-day window rolls."
          : null;
  const blockedShort = !state || !blockedWhy
    ? null
    : !state.blockedWhy && state.enabled && state.budgetExhausted
      ? "Weekly scan limit reached"
      : blockedWhy;
  const canScan = !!state && !surfaceOff && !blockedWhy && !running;

  const onScan = async (): Promise<string | null> => {
    if (inFlight.current || running) return "A scan is already running.";
    if (!canScan) return blockedWhy ?? "Scanning is not available right now.";
    if (planLock?.tierName) {
      planLock.upgrade();
      return "upgrade";
    }
    inFlight.current = true;
    dataAtClick.current = dashboard.data;
    setBusy(true);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(null);
    posting.current = true;
    const err = await startScan(scan.endpoint, name, planLock);
    posting.current = false;
    if (err) {
      dataAtClick.current = null;
      inFlight.current = false;
      setBusy(false);
      if (err === "upgrade") return err;
      setError(err);
      errorTimer.current = setTimeout(() => setError(null), ERROR_CLEAR_MS);
      return err;
    }
    dataAtClick.current = latestData.current;
    setPosted((n) => n + 1);
    (dashboard.refreshSilent ?? dashboard.refresh)();
    return null;
  };

  const latest = useRef({ onScan, status: { canScan, running, blockedWhy, ready: !!state, loaded: !!dashboard.data } });
  latest.current = { onScan, status: { canScan, running, blockedWhy, ready: !!state, loaded: !!dashboard.data } };
  useEffect(() => {
    const handle: ChannelScanHandle = { status: () => latest.current.status, scan: () => latest.current.onScan() };
    return registerChannelScan(slug, handle);
  }, [slug]);

  if (firstLoad) return null;

  return (
    <>
      <ChannelControlsSlot>
        <div
          data-testid="channel-scan"
          className={`order-last flex flex-wrap items-center justify-end gap-2 text-[16px] text-inkMuted compact:min-w-0 compact:gap-2 compact:text-[14px] ${
            !running && blockedWhy ? "" : "compact:flex-nowrap"
          }`}
        >
          {running && (
            <span className="inline-flex items-center" aria-live="polite">
              <RefreshCw
                className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
              <span className="ml-1.5 whitespace-nowrap text-[14px]">Scanning…</span>
            </span>
          )}
          {!running && state?.lastFailed && (
            <span role="status" className="text-[14px] text-warn compact:hidden">
              {state.lastFailed}
            </span>
          )}
          {}
          {!running && blockedWhy && (
            <span
              title={blockedWhy}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-rule px-2.5 py-1 text-[13px] text-inkMuted compact:hidden"
            >
              <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {blockedShort}
              <span className="sr-only">{blockedShort === blockedWhy ? "" : blockedWhy}</span>
            </span>
          )}
          {!running && state?.lastAt && (
            <span className="whitespace-nowrap compact:hidden">
              Scanned <ScanAgo at={state.lastAt} />
            </span>
          )}
          <button
            type="button"
            disabled={busy || dashboard.refreshing}
            onClick={() => {
              if (canScan) return void onScan();
              if (running) {
                if (errorTimer.current) clearTimeout(errorTimer.current);
                setError("A scan is already running.");
                errorTimer.current = setTimeout(() => setError(null), ERROR_CLEAR_MS);
              }
              dashboard.refresh();
            }}
            aria-label={canScan ? "Scan now" : "Refresh"}
            title={
              canScan
                ? "Scan now"
                : blockedWhy
                  ? `${blockedWhy} This re-reads the latest numbers.`
                  : "Refresh"
            }
            className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-rule bg-cream text-ink after:absolute after:-inset-2 after:content-[''] hover:border-ink disabled:opacity-40"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 shrink-0 ${dashboard.refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
              aria-hidden
            />
          </button>
        </div>
      </ChannelControlsSlot>
      {!running && (state?.lastFailed || blockedWhy) && (
        <div className="hidden flex-col gap-1.5 compact:flex">
          {state?.lastFailed && <p className="text-[13px] text-warn">{state.lastFailed}</p>}
          {blockedWhy && (
            <p className="flex items-start gap-2 rounded-xl border border-rule px-3 py-2 text-[13px] text-inkMuted">
              <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                <span className="font-medium text-ink">{blockedShort}</span>
                {blockedShort !== blockedWhy && <span className="block">Scans resume as the 7-day window rolls.</span>}
              </span>
            </p>
          )}
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-coral/40 bg-coral/5 px-4 py-3 text-[16px] text-ink"
        >
          {error}
        </p>
      )}
    </>
  );
}
