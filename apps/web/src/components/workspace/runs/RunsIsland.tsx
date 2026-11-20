"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

type RunStatus = "provisioning" | "active" | "halted" | "done" | "failed" | string;
type NodeStatus = "pending" | "dispatched" | "done" | "failed" | string;

type NodeSummary = {
  stage: string;
  status: NodeStatus;
};

type RunRow = {
  id: string;
  objective: string;
  status: RunStatus;
  spend_usd: number;
  max_usd: number | null;
  created_at: string;
  updated_at: string;
  node_summary: NodeSummary[];
  stalled: boolean;
  site_id?: string | null;
  site?: RunSite | null;
};

type RunSite = {
  id: string;
  hostname: string;
  session_id: string | null;
  repo_url: string | null;
  live_url: string | null;
};

type RunsPayload = {
  runs: RunRow[];
  target: {
    repo_url: string | null;
    live_url: string | null;
  };
};

const PIPELINE_STAGES = ["provision", "spec", "scaffold", "build"] as const;
type PipelineStage = (typeof PIPELINE_STAGES)[number];

const POLL_MS = 30_000;

function isActiveStatus(s: RunStatus): boolean {
  return s === "active" || s === "provisioning";
}

function anyActive(runs: RunRow[]): boolean {
  return runs.some((r) => isActiveStatus(r.status));
}

function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return "-";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

export function RunsIsland() {
  const [data, setData] = useState<RunsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const mounted = useRef(true);
  const runsRef = useRef<RunRow[]>([]);
  runsRef.current = data?.runs ?? [];

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await apiFetch("/api/workspace/autopilot/runs");
      if (!mounted.current) return;
      if (res.status === 401) {
        setSessionExpired(true);
        setError(null);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const payload = (await res.json()) as RunsPayload;
      if (!mounted.current) return;
      setData(payload);
      setError(null);
      setSessionExpired(false);
    } catch (e) {
      if (!mounted.current) return;
      setError((e as Error).message ?? "Network error");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();

    const tick = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (anyActive(runsRef.current)) void load();
    }, POLL_MS);

    const onVis = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void load();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVis);
    }

    return () => {
      mounted.current = false;
      clearInterval(tick);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVis);
      }
    };
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 mt-[var(--service-banner-h,0px)]">
      <Header />

      {sessionExpired ? (
        <SessionExpired />
      ) : loading && !data ? (
        <SkeletonList />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !data || data.runs.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="mt-8 space-y-4">
          {data.runs.map((run) => (
            <li key={run.id}>
              <RunCard run={run} target={data.target} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-[28px] font-semibold tracking-tight text-ink leading-[1.15] md:text-[32px]">
          Your builds
        </h1>
        <p className="mt-3 text-[16px] text-inkMuted leading-[1.55]">
          Live status of every app your fleet is building. We poll every 30
          seconds while a build is in progress.
        </p>
      </div>
      <Link
        href="/workspace"
        className="shrink-0 rounded-full border border-ink/15 px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
      >
        Workspace home
      </Link>
    </div>
  );
}

export function runCardLinks(
  run: Pick<RunRow, "site_id" | "site">,
  target: RunsPayload["target"],
): { build_href: string | null; repo_url: string | null; live_url: string | null } {
  if (!run.site_id) return { build_href: null, repo_url: target.repo_url, live_url: target.live_url };
  const site = run.site ?? null;
  return {
    build_href: site?.session_id ? `/workspace?tab=build&build=${encodeURIComponent(site.session_id)}` : null,
    repo_url: site?.repo_url ?? null,
    live_url: site?.live_url ?? null,
  };
}

function RunCard({ run, target }: { run: RunRow; target: RunsPayload["target"] }) {
  const links = runCardLinks(run, target);
  return (
    <div className="rounded-xl border border-ink/[0.08] bg-white px-4 py-4 shadow-[0_1px_2px_rgba(25,25,25,0.04)]">
      {}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold text-ink leading-[1.4]">
            {run.objective || "Untitled build"}
          </p>
          <p className="mt-1 text-[12px] text-inkMuted">
            Started {relativeTime(run.created_at)} · Updated {relativeTime(run.updated_at)}
          </p>
        </div>
        <RunStatusBadge status={run.status} />
      </div>

      {}
      {run.stalled && <StalledBanner />}

      {}
      <SpendBar spend={run.spend_usd} max={run.max_usd} />

      {}
      <NodeTracker nodes={run.node_summary} />

      {}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {links.build_href && (
          <Link
            href={links.build_href}
            className="rounded-full border border-ink/15 px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
          >
            Open {run.site?.hostname ?? "site"}
          </Link>
        )}
        {links.repo_url && (
          <a
            href={links.repo_url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-ink/15 px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
          >
            Open repo
          </a>
        )}
        {links.live_url && (
          <a
            href={links.live_url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-transparent bg-ink px-3.5 py-1.5 text-[13px] font-semibold text-cream hover:bg-ink/90"
          >
            Open live URL
          </a>
        )}
      </div>
    </div>
  );
}

function RunStatusBadge({ status }: { status: RunStatus }) {
  let bg = "bg-slate-100";
  let text = "text-slate-700";
  let dot = "bg-slate-400";
  let label: string = status;
  let pulse = false;

  if (status === "active") {
    bg = "bg-sky-50";
    text = "text-sky-700";
    dot = "bg-sky-500";
    label = "Building";
    pulse = true;
  } else if (status === "provisioning") {
    bg = "bg-sky-50";
    text = "text-sky-700";
    dot = "bg-sky-500";
    label = "Provisioning";
    pulse = true;
  } else if (status === "done") {
    bg = "bg-emerald-50";
    text = "text-emerald-700";
    dot = "bg-emerald-500";
    label = "Done";
  } else if (status === "failed") {
    bg = "bg-rose-50";
    text = "text-rose-700";
    dot = "bg-rose-500";
    label = "Failed";
  } else if (status === "halted") {
    bg = "bg-amber-50";
    text = "text-amber-700";
    dot = "bg-amber-500";
    label = "Halted";
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium leading-none ${bg} ${text}`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${dot} ${pulse ? "animate-pulse" : ""}`}
      />
      <span className="capitalize">{label}</span>
    </span>
  );
}

function StalledBanner() {
  return (
    <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-amber-800">Build looks stuck</p>
        <p className="mt-0.5 text-[12px] text-amber-700 leading-[1.4]">
          No progress in the last 15 minutes. The fleet may have hit a snag.
          Check back in a few minutes or contact support if it stays stuck.
        </p>
      </div>
    </div>
  );
}

function SpendBar({ spend, max }: { spend: number; max: number | null }) {
  const hasCap = typeof max === "number" && max > 0;
  const pct = hasCap ? Math.min(100, Math.round((spend / (max as number)) * 100)) : 0;
  let barColor = "bg-ink/30";
  if (hasCap) {
    if (pct >= 90) barColor = "bg-rose-500";
    else if (pct >= 70) barColor = "bg-amber-500";
    else barColor = "bg-emerald-500";
  }
  return (
    <div className="mt-4">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-inkMuted">Spend</span>
        <span className="font-mono text-ink">
          {fmtUsd(spend)}
          {hasCap ? ` / ${fmtUsd(max as number)}` : ""}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.06]">
        <div
          className={`h-full ${barColor} transition-[width] duration-500`}
          style={{ width: hasCap ? `${pct}%` : "0%" }}
          aria-valuenow={hasCap ? pct : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          role="progressbar"
        />
      </div>
    </div>
  );
}

function NodeTracker({ nodes }: { nodes: NodeSummary[] }) {
  const byStage = new Map<string, NodeStatus>();
  for (const n of nodes) {
    if (n.stage) byStage.set(n.stage, n.status);
  }

  return (
    <div className="mt-4">
      <p className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-inkMuted">
        Pipeline
      </p>
      <ol className="flex flex-wrap items-center gap-2">
        {PIPELINE_STAGES.map((stage, i) => (
          <li key={stage} className="flex items-center gap-2">
            <StageChip stage={stage} status={byStage.get(stage) ?? "pending"} />
            {i < PIPELINE_STAGES.length - 1 && (
              <span aria-hidden className="h-px w-3 bg-ink/15" />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function StageChip({ stage, status }: { stage: PipelineStage; status: NodeStatus }) {
  let bg = "bg-slate-100";
  let text = "text-slate-700";
  let ring = "ring-1 ring-inset ring-slate-200";
  let dot = "bg-slate-400";
  let pulse = false;

  if (status === "done") {
    bg = "bg-emerald-50";
    text = "text-emerald-700";
    ring = "ring-1 ring-inset ring-emerald-200";
    dot = "bg-emerald-500";
  } else if (status === "dispatched") {
    bg = "bg-sky-50";
    text = "text-sky-700";
    ring = "ring-1 ring-inset ring-sky-200";
    dot = "bg-sky-500";
    pulse = true;
  } else if (status === "failed") {
    bg = "bg-rose-50";
    text = "text-rose-700";
    ring = "ring-1 ring-inset ring-rose-200";
    dot = "bg-rose-500";
  }

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium leading-none ${bg} ${text} ${ring}`}
      title={`${stage}: ${status}`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${dot} ${pulse ? "animate-pulse" : ""}`}
      />
      <span className="capitalize">{stage}</span>
    </span>
  );
}

function EmptyState() {
  return (
    <div className="mt-10 rounded-xl border border-ink/[0.08] bg-white px-6 py-12 text-center">
      <p className="text-[16px] font-medium text-ink">No builds yet</p>
      <p className="mt-2 text-[13px] text-inkMuted leading-[1.55]">
        Start a build from the workspace home and it will show up here with live
        progress, spend, and the deployed URL.
      </p>
      <Link
        href="/workspace"
        className="mt-5 inline-flex items-center justify-center rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-cream hover:bg-ink/90"
      >
        Go to workspace
      </Link>
    </div>
  );
}

function SkeletonList() {
  return (
    <ul className="mt-8 space-y-4" aria-busy aria-label="Loading builds">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="animate-pulse rounded-xl border border-ink/[0.08] bg-white px-4 py-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="h-4 w-2/3 rounded bg-ink/[0.06]" />
            <div className="h-5 w-20 rounded-full bg-ink/[0.06]" />
          </div>
          <div className="mt-3 h-3 w-1/3 rounded bg-ink/[0.06]" />
          <div className="mt-4 h-1.5 w-full rounded-full bg-ink/[0.06]" />
          <div className="mt-4 flex gap-2">
            {[0, 1, 2, 3, 4].map((j) => (
              <div key={j} className="h-6 w-16 rounded-full bg-ink/[0.06]" />
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-10 rounded-xl border border-rose-200 bg-rose-50 px-4 py-4">
      <p className="text-[16px] font-semibold text-rose-800">
        Couldn&apos;t load your builds
      </p>
      <p className="mt-1 text-[13px] text-rose-700 leading-[1.5]">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-full border border-rose-300 bg-white px-3.5 py-1.5 text-[13px] font-medium text-rose-800 hover:bg-rose-100"
      >
        Try again
      </button>
    </div>
  );
}

function SessionExpired() {
  return (
    <div className="mt-10 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
      <p className="text-[16px] font-semibold text-amber-800">Session expired</p>
      <p className="mt-1 text-[13px] text-amber-700 leading-[1.5]">
        Your sign-in token has timed out. Sign in again to see your builds.
      </p>
      <Link
        href={`/login?next=${encodeURIComponent("/workspace/runs")}`}
        className="mt-3 inline-flex items-center justify-center rounded-full bg-ink px-4 py-1.5 text-[13px] font-semibold text-cream hover:bg-ink/90"
      >
        Sign in
      </Link>
    </div>
  );
}
