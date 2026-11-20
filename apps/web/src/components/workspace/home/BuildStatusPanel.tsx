"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { stageErrorLine } from "@/lib/workspace/buildFailureCopy";
import { AppPreviewFrame } from "./AppPreviewFrame";
import { buildEstimateText, designAwaitsPick, ESTIMATE_SLOW_FACTOR } from "@/lib/workspace/buildEstimate";
import { useSiteDesign } from "@/lib/workspace/useSiteDesign";
import { LookPicker } from "../build/LookPicker";

const STAGES = ["provision", "spec", "scaffold", "build"] as const;
type Stage = (typeof STAGES)[number];
type NodeStatus = "pending" | "active" | "running" | "done" | "failed" | string;

const STAGE_LABEL: Record<Stage, string> = {
  provision: "Provision infrastructure",
  spec: "Write the product spec",
  scaffold: "Scaffold the codebase",
  build: "Build the app",
};

type PreviewKind = "none" | "early" | "final";

type BuildStageStatus = {
  stage: Stage;
  status: NodeStatus;
  error: string | null;
  failure_class?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  run_id?: string | null;
  agent?: string | null;
  agent_status?: string | null;
  last_progress_at?: string | null;
  retry_count?: number;
  expected_ms?: number | null;
};

type BuildStatusResponse = {
  run: {
    id: string;
    status: string;
    spend_usd: number;
    max_usd: number | null;
    used_usd?: number | null;
    used_credits?: number | null;
    created_at?: string | null;
    updated_at?: string | null;
    stages: BuildStageStatus[];
    failure?: { class: string; message: string; stage: string | null } | null;
  } | null;
  target: { repo_url: string | null; live_url: string | null };
  preview?: { url: string | null; kind: PreviewKind } | null;
};

export const FAST_POLL_MS = 1500;

export const UNAUTHORIZED_BEFORE_GIVING_UP = 2;

function pillFor(status: NodeStatus): "pending" | "running" | "done" | "failed" {
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  if (status === "active" || status === "running" || status === "dispatched") return "running";
  return "pending";
}

export const IN_STAGE_CAP = 0.95;

export function stageFraction(elapsedMs: number, expectedMs: number): number {
  if (!(expectedMs > 0) || !(elapsedMs > 0)) return 0;
  return IN_STAGE_CAP * (1 - Math.exp((-1.5 * elapsedMs) / expectedMs));
}

type ProgressStage = {
  status: NodeStatus;
  started_at?: string | null;
  expected_ms?: number | null;
};

function timedFraction(stage: ProgressStage, nowMs: number | undefined): number | null {
  if (nowMs === undefined) return null;
  const expected = stage.expected_ms;
  if (typeof expected !== "number" || !Number.isFinite(expected) || expected <= 0) return null;
  const start = stage.started_at ? Date.parse(stage.started_at) : NaN;
  if (Number.isNaN(start)) return null;
  return stageFraction(nowMs - start, expected);
}

export function progressPct(
  stages: ReadonlyArray<ProgressStage>,
  nowMs?: number,
): number {
  if (stages.length === 0) return 0;
  const per = 100 / stages.length;
  let pct = 0;
  let timed = false;
  for (const s of stages) {
    const pill = pillFor(s.status);
    if (pill === "done" || pill === "failed") pct += per;
    else if (pill === "running") {
      const fraction = timedFraction(s, nowMs);
      if (fraction === null) pct += per / 2;
      else {
        timed = true;
        pct += per * fraction;
      }
    }
  }
  return Math.max(0, Math.min(100, timed ? Math.floor(pct) : Math.round(pct)));
}

export function progressHoldKey(stages: ReadonlyArray<ProgressStage & { stage?: string }>): string {
  const first = stages[0];
  if (!first) return "";
  const pill = pillFor(first.status);
  return pill === "done" || pill === "failed" ? `${first.stage ?? ""}:${first.started_at ?? ""}` : "start";
}

export function holdProgress(
  prev: { key: string; pct: number } | null,
  key: string,
  pct: number,
): { key: string; pct: number } {
  if (!prev || prev.key !== key) return { key, pct };
  return pct > prev.pct ? { key, pct } : prev;
}

const HELD_PCT_PREFIX = "zavi.buildPct.";

export function readHeldPct(runId: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(HELD_PCT_PREFIX + runId);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
  } catch {
    return null;
  }
}

function writeHeldPct(runId: string, pct: number): void {
  try {
    window.sessionStorage.setItem(HELD_PCT_PREFIX + runId, String(pct));
  } catch {
    return;
  }
}

export function hasFailedStage(stages: ReadonlyArray<ProgressStage>): boolean {
  return stages.some((s) => pillFor(s.status) === "failed");
}

export function useHeldProgress(pct: number, key: string, runId?: string | null, failed = false): number {
  const held = useRef<{ key: string; pct: number } | null>(null);
  if (!failed && runId && held.current?.key !== key) {
    const stored = readHeldPct(runId);
    if (stored !== null) held.current = { key, pct: stored };
  }
  if (!failed) held.current = holdProgress(held.current, key, pct);
  const value = failed ? pct : held.current!.pct;
  useEffect(() => {
    if (runId && !failed) writeHeldPct(runId, value);
  }, [runId, value, failed]);
  return value;
}

export function hasTimedStage(stages: ReadonlyArray<ProgressStage>): boolean {
  return stages.some(
    (s) => pillFor(s.status) === "running" && typeof s.expected_ms === "number" && s.expected_ms > 0,
  );
}

export const BUILD_SLOW_NOTE = "This step is taking longer than usual. We're still on it.";
export const STAGE_SLOW_FACTOR = ESTIMATE_SLOW_FACTOR;

export function slowRunningStage(stages: ReadonlyArray<ProgressStage>, nowMs: number): boolean {
  return stages.some((s) => {
    if (!hasTimedStage([s])) return false;
    const start = s.started_at ? Date.parse(s.started_at) : NaN;
    return Number.isFinite(start) && nowMs - start > STAGE_SLOW_FACTOR * (s.expected_ms as number);
  });
}

export function useProgressClock(on: boolean): number {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNowMs(Date.now());
    const clock = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [on]);
  return nowMs;
}

function usdToCredits(usd: number): string {
  return `${Math.round(usd / 0.0025).toLocaleString()} cr`;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["done", "failed", "halted", "paused"]);

export function isBuildTerminal(status: string | null | undefined): boolean {
  return typeof status === "string" && TERMINAL_STATUSES.has(status);
}

export function computeElapsedMs(
  createdAt: string | null | undefined,
  updatedAt: string | null | undefined,
  terminal: boolean,
  nowMs: number,
): number | null {
  if (!createdAt) return null;
  const start = Date.parse(createdAt);
  if (Number.isNaN(start)) return null;
  let end = nowMs;
  if (terminal && updatedAt) {
    const u = Date.parse(updatedAt);
    if (!Number.isNaN(u)) end = u;
  }
  return Math.max(0, end - start);
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

export function BuildStatusPanel({
  active,
  creditsEnforced = false,
  onOpenBuild,
}: {
  active: boolean;
  creditsEnforced?: boolean;
  onOpenBuild?: (runId: string) => void;
}) {
  const [data, setData] = useState<BuildStatusResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const mounted = useRef(true);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unauthorizedStreak = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/autopilot/build-status?app=workspace");
      if (!mounted.current) return;
      if (res.status === 401) {
        unauthorizedStreak.current += 1;
        if (unauthorizedStreak.current < UNAUTHORIZED_BEFORE_GIVING_UP) return;
        setAuthExpired(true);
        setError(null);
        if (tickRef.current) {
          clearInterval(tickRef.current);
          tickRef.current = null;
        }
        return;
      }
      unauthorizedStreak.current = 0;
      setAuthExpired(false);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as BuildStatusResponse;
      if (!mounted.current) return;
      setData(json);
      setError(null);
    } catch (e) {
      if (mounted.current) setError((e as Error).message ?? "network error");
    } finally {
      if (mounted.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const tick = active ? setInterval(() => void refresh(), FAST_POLL_MS) : null;
    tickRef.current = tick;
    return () => {
      mounted.current = false;
      if (tick) clearInterval(tick);
      tickRef.current = null;
    };
  }, [refresh, active]);

  useEffect(() => {
    if (!active) return;
    const clock = setInterval(() => {
      if (mounted.current) setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(clock);
  }, [active]);

  const siteDesign = useSiteDesign(data?.run?.id ?? null, active);
  const pct = useHeldProgress(
    progressPct(data?.run?.stages ?? [], nowMs),
    data?.run?.id ?? "",
    data?.run?.id,
    hasFailedStage(data?.run?.stages ?? []),
  );

  if (loaded && !error && !authExpired && !data?.run) return null;

  const run = data?.run ?? null;
  const stages: BuildStageStatus[] =
    run?.stages ??
    STAGES.map((stage) => ({ stage, status: "pending" as NodeStatus, error: null }));

  const buildTerminal = isBuildTerminal(run?.status);
  const awaitingPick = !!run && !buildTerminal && designAwaitsPick(siteDesign.design, siteDesign.started);
  const slow = !!run && !buildTerminal && !awaitingPick && slowRunningStage(stages, nowMs);
  const estimate =
    run && !buildTerminal && !slow
      ? buildEstimateText(stages, nowMs, { awaitingPick })
      : null;
  const elapsedMs = run
    ? computeElapsedMs(run.created_at, run.updated_at, buildTerminal, nowMs)
    : null;
  const preview = data?.preview ?? null;
  const previewUrl =
    preview && preview.kind !== "none" && typeof preview.url === "string"
      ? preview.url
      : null;
  const previewIsEarly = preview?.kind === "early";

  return (
    <section
      aria-label="Build progress"
      className="rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]"
    >
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[16px] font-semibold text-ink">
          {awaitingPick ? "Pick a website" : "Your AI team is building"}
        </h3>
        {run && (
          (creditsEnforced ? typeof run.used_credits === "number" : typeof run.used_usd === "number") && (
            <span className="text-[12px] tabular-nums text-inkSoft" title="Used so far">
              {creditsEnforced
                ? `Cost ${Math.round(run.used_credits ?? 0).toLocaleString()} cr`
                : `$${(run.used_usd ?? 0).toFixed(2)} used`}
            </span>
          )
        )}
      </header>

      {}
      {elapsedMs !== null && (
        <p className="mb-3 text-[12px] text-inkSoft">
          <span className="tabular-nums">
            {buildTerminal ? "Took " : "Elapsed "}
            {formatElapsed(elapsedMs)}
          </span>
          {estimate && <span className="text-inkMuted"> · {estimate}</span>}
        </p>
      )}

      {awaitingPick && run && siteDesign.design && (
        <div data-testid="build-status-pick" className="mb-3">
          <LookPicker
            design={siteDesign.design}
            starting={siteDesign.starting}
            started={siteDesign.started}
            startError={siteDesign.startError}
            onStart={siteDesign.start}
          />
          {onOpenBuild && (
            <button
              type="button"
              data-testid="build-status-open-build"
              onClick={() => onOpenBuild(run.id)}
              className="mt-2 text-[12px] font-medium text-ink underline-offset-2 hover:underline"
            >
              See the looks full size in Build
            </button>
          )}
        </div>
      )}

      {}
      {!awaitingPick && (
        <div
          className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.06]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Overall build progress"
        >
          <div
            className="h-full rounded-full bg-ink transition-[width] duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {slow && (
        <p data-testid="build-status-slow" role="status" className="mb-3 text-[12px] font-medium text-inkSoft">
          {BUILD_SLOW_NOTE}
        </p>
      )}

      <ol className="space-y-1.5">
        {stages.map((s) => {
          const pill = pillFor(s.status);
          return (
            <li key={s.stage} className="text-[13px]">
              <div className="flex items-center gap-2.5">
                <StageIcon state={pill} />
                <span
                  className={
                    pill === "done"
                      ? "text-ink"
                      : pill === "running"
                        ? "font-medium text-ink"
                        : pill === "failed"
                          ? "text-red-700"
                          : "text-inkMuted"
                  }
                >
                  {STAGE_LABEL[s.stage] ?? s.stage}
                </span>
                {typeof s.duration_ms === "number" && (
                  <span className="text-[12px] tabular-nums text-inkSoft">
                    {formatElapsed(s.duration_ms)}
                  </span>
                )}
                <span className="ml-auto text-[12px] uppercase tracking-wide text-inkSoft">
                  {pill}
                </span>
              </div>
              {stageErrorLine(s.error) && (
                <p className="ml-7 mt-1 break-words text-[12px] leading-[1.45] text-red-700">
                  {stageErrorLine(s.error)}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      {authExpired && loaded && (
        <p className="mt-3 text-[12px] text-inkSoft">
          Your session expired, so this stopped updating.{" "}
          <a className="underline" href="/login">
            Sign in again
          </a>{" "}
          to pick it back up.
        </p>
      )}

      {error && !authExpired && loaded && (
        <p className="mt-3 text-[12px] text-inkSoft">
          Status refresh failed ({error}). Will retry.
        </p>
      )}

      {data?.target.repo_url && (
        <p className="mt-3 text-[12px] text-inkSoft">
          Repo:{" "}
          <a
            href={data.target.repo_url}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-ink underline-offset-2 hover:underline"
          >
            {data.target.repo_url.replace(/^https?:\/\//, "")}
          </a>
        </p>
      )}

      {}
      {previewUrl && (
        <div className="mt-4 border-t border-ink/[0.06] pt-3">
          <div className="mb-1 flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500"
            />
            <span className="text-[12px] font-medium text-ink">
              {previewIsEarly ? "Preview, still building" : "Preview"}
            </span>
            {previewIsEarly && (
              <span className="text-[12px] text-inkSoft">
                Live scaffold; your AI team is still writing the app.
              </span>
            )}
          </div>
          {}
          <AppPreviewFrame liveUrl={previewUrl} cacheKey={preview?.kind ?? null} tall guardWhileBuilding={previewIsEarly && !buildTerminal} />
        </div>
      )}
    </section>
  );
}

function StageIcon({ state }: { state: "pending" | "running" | "done" | "failed" }) {
  const pillCls =
    "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold";
  if (state === "done")
    return <span aria-hidden className={`${pillCls} bg-emerald-100 text-emerald-700`}>✓</span>;
  if (state === "failed")
    return <span aria-hidden className={`${pillCls} bg-red-100 text-red-700`}>✕</span>;
  if (state === "running")
    return (
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="h-4 w-4 shrink-0 animate-spin text-ink"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <path d="M21 12a9 9 0 1 1-6.2-8.55" />
      </svg>
    );
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-ink/25 bg-bone"
    />
  );
}
