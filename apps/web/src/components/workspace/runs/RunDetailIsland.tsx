"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

type RunStatus = "provisioning" | "active" | "halted" | "done" | "failed" | string;
type NodeStatus = "pending" | "dispatched" | "done" | "failed" | string;

type GoalNode = {
  id: string | null;
  stage: string | null;
  status: NodeStatus;
  child_run_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};

type AgentRun = {
  id: string;
  agent_slug: string;
  status: string;
  presentation_status?: "answered" | "failed" | "running" | "cancelled";
  side_effect_kind?: string | null;
  enqueued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  cost_usd: number;
  cost_tokens: number;
  error: string | null;
};

type LedgerRow = {
  id: string;
  node_id: string | null;
  action: string | null;
  target_agent_slug: string | null;
  child_run_id: string | null;
  outcome: string | null;
  error: string | null;
  spend_delta: number;
  evidence: unknown | null;
  created_at: string;
};

type DetailPayload = {
  run: {
    id: string;
    objective: string;
    status: RunStatus;
    spend_usd: number;
    max_usd: number | null;
    created_at: string;
    updated_at: string;
    stalled: boolean;
    goal_graph: GoalNode[];
  };
  target: {
    repo_url: string | null;
    live_url: string | null;
  };
  agent_runs: AgentRun[];
  ledger: LedgerRow[];
};

const PIPELINE_STAGES = ["provision", "spec", "scaffold", "build"] as const;

const POLL_MS = 10_000;

function isActiveStatus(s: RunStatus): boolean {
  return s === "active" || s === "provisioning";
}

function relativeTime(iso: string | null): string {
  if (!iso) return "-";
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
  if (n < 0.01 && n > 0) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function fmtDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return "-";
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "-";
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm.toString().padStart(2, "0")}m`;
}

export function RunDetailIsland({ runId }: { runId: string }) {
  const [data, setData] = useState<DetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [cancelAvailable, setCancelAvailable] = useState(false);
  const [cancelInFlight, setCancelInFlight] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const mounted = useRef(true);
  const statusRef = useRef<RunStatus>("active");
  statusRef.current = data?.run.status ?? "active";

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await apiFetch(`/api/workspace/autopilot/runs/${encodeURIComponent(runId)}`);
      if (!mounted.current) return;
      if (res.status === 401) {
        setSessionExpired(true);
        setError(null);
        return;
      }
      if (res.status === 404) {
        setNotFound(true);
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
      const payload = (await res.json()) as DetailPayload;
      if (!mounted.current) return;
      setData(payload);
      setError(null);
      setSessionExpired(false);
      setNotFound(false);
    } catch (e) {
      if (!mounted.current) return;
      setError((e as Error).message ?? "Network error");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/workspace/autopilot/runs/${encodeURIComponent(runId)}/cancel`,
          { method: "OPTIONS" },
        );
        if (cancelled) return;
        if (res.status !== 404) {
          setCancelAvailable(true);
        }
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    mounted.current = true;
    void load();

    const tick = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (isActiveStatus(statusRef.current)) void load();
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

  const onCancel = useCallback(async () => {
    if (cancelInFlight) return;
    setCancelInFlight(true);
    setCancelError(null);
    try {
      const res = await apiFetch(
        `/api/workspace/autopilot/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setCancelError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      await load();
    } catch (e) {
      setCancelError((e as Error).message ?? "Network error");
    } finally {
      setCancelInFlight(false);
    }
  }, [cancelInFlight, runId, load]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 mt-[var(--service-banner-h,0px)]">
      <BackBar />

      {sessionExpired ? (
        <SessionExpired runId={runId} />
      ) : notFound ? (
        <NotFoundState />
      ) : loading && !data ? (
        <SkeletonDetail />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !data ? (
        <SkeletonDetail />
      ) : (
        <DetailView
          payload={data}
          cancelAvailable={cancelAvailable && isActiveStatus(data.run.status)}
          cancelInFlight={cancelInFlight}
          cancelError={cancelError}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

function BackBar() {
  return (
    <div className="mb-6 flex items-center justify-between">
      <Link
        href="/workspace/runs"
        className="inline-flex items-center gap-2 rounded-full border border-ink/15 px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>
        All builds
      </Link>
      <Link
        href="/workspace"
        className="text-[13px] font-medium text-inkMuted hover:text-ink"
      >
        Workspace home
      </Link>
    </div>
  );
}

function DetailView({
  payload,
  cancelAvailable,
  cancelInFlight,
  cancelError,
  onCancel,
}: {
  payload: DetailPayload;
  cancelAvailable: boolean;
  cancelInFlight: boolean;
  cancelError: string | null;
  onCancel: () => void;
}) {
  const { run, target, agent_runs, ledger } = payload;

  const arById = new Map<string, AgentRun>();
  for (const ar of agent_runs) arById.set(ar.id, ar);

  const nodeByStage = new Map<string, GoalNode>();
  for (const n of run.goal_graph) {
    if (n.stage) nodeByStage.set(n.stage, n);
  }

  return (
    <>
      <Header run={run} />

      {run.stalled && <StalledBanner />}

      <SpendBar spend={run.spend_usd} max={run.max_usd} />

      {}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {target.repo_url && (
          <a
            href={target.repo_url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-ink/15 px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
          >
            Open repo
          </a>
        )}
        {target.live_url && (
          <a
            href={target.live_url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-transparent bg-ink px-3.5 py-1.5 text-[13px] font-semibold text-cream hover:bg-ink/90"
          >
            Open live URL
          </a>
        )}
        {cancelAvailable && (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelInFlight}
            className="rounded-full border border-rose-300 bg-white px-3.5 py-1.5 text-[13px] font-medium text-rose-800 hover:bg-rose-50 disabled:opacity-60"
          >
            {cancelInFlight ? "Cancelling…" : "Cancel build"}
          </button>
        )}
      </div>
      {cancelError && (
        <p className="mt-2 text-[12px] text-rose-700">{cancelError}</p>
      )}

      {}
      <section aria-labelledby="timeline-h" className="mt-8">
        <h2
          id="timeline-h"
          className="text-[13px] font-semibold uppercase tracking-wide text-inkMuted"
        >
          Pipeline timeline
        </h2>
        <ol className="mt-3 space-y-2">
          {PIPELINE_STAGES.map((stage) => {
            const node = nodeByStage.get(stage);
            const childAr = node?.child_run_id ? arById.get(node.child_run_id) ?? null : null;
            return (
              <li key={stage}>
                <TimelineNode stage={stage} node={node ?? null} agentRun={childAr} />
              </li>
            );
          })}
          {}
          {run.goal_graph
            .filter((n) => !n.stage || !PIPELINE_STAGES.includes(n.stage as (typeof PIPELINE_STAGES)[number]))
            .map((node, idx) => {
              const childAr = node.child_run_id ? arById.get(node.child_run_id) ?? null : null;
              return (
                <li key={node.id ?? `extra-${idx}`}>
                  <TimelineNode
                    stage={node.stage ?? "step"}
                    node={node}
                    agentRun={childAr}
                  />
                </li>
              );
            })}
        </ol>
      </section>

      {}
      {agent_runs.length > 0 && (
        <section aria-labelledby="agentruns-h" className="mt-8">
          <h2
            id="agentruns-h"
            className="text-[13px] font-semibold uppercase tracking-wide text-inkMuted"
          >
            Dispatched agent runs ({agent_runs.length})
          </h2>
          <div className="mt-3 overflow-hidden rounded-xl border border-ink/[0.08] bg-white">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-ink/[0.03] text-[12px] font-medium uppercase tracking-wide text-inkMuted">
                <tr>
                  <th className="px-4 py-2">Agent</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Duration</th>
                  <th className="px-4 py-2">Cost</th>
                  <th className="px-4 py-2">Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/[0.06]">
                {agent_runs.map((ar) => (
                  <tr key={ar.id}>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-ink">
                      {ar.agent_slug}
                    </td>
                    <td className="px-4 py-2.5">
                      <AgentRunStatusPill status={ar.status} presentationStatus={ar.presentation_status} sideEffectKind={ar.side_effect_kind} />
                    </td>
                    <td className="px-4 py-2.5 text-inkMuted">
                      {fmtDuration(ar.started_at, ar.finished_at)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-ink">
                      {fmtUsd(ar.cost_usd)}
                    </td>
                    <td className="px-4 py-2.5 text-inkMuted">
                      {(ar.cost_tokens ?? 0).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {}
      <section aria-labelledby="ledger-h" className="mt-8">
        <h2
          id="ledger-h"
          className="text-[13px] font-semibold uppercase tracking-wide text-inkMuted"
        >
          Activity ({ledger.length})
        </h2>
        {ledger.length === 0 ? (
          <p className="mt-3 rounded-xl border border-ink/[0.08] bg-white px-4 py-4 text-[13px] text-inkMuted">
            No ledger entries yet. Autopilot writes here whenever it dispatches,
            completes, undoes, or halts a node.
          </p>
        ) : (
          <ol className="mt-3 space-y-2">
            {ledger.map((row) => (
              <li key={row.id}>
                <LedgerRowCard row={row} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function Header({ run }: { run: DetailPayload["run"] }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium uppercase tracking-wide text-inkMuted">
          Build
        </p>
        <h1 className="mt-1 font-display text-[24px] font-semibold tracking-tight text-ink leading-[1.2] md:text-[28px]">
          {run.objective || "Untitled build"}
        </h1>
        <p className="mt-2 text-[13px] text-inkMuted">
          Started {relativeTime(run.created_at)} · Updated {relativeTime(run.updated_at)} ·{" "}
          <span className="font-mono text-[12px]">{run.id.slice(0, 8)}</span>
        </p>
      </div>
      <RunStatusBadge status={run.status} />
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
    <div className="mt-5 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
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
    <div className="mt-6">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px]">
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

function TimelineNode({
  stage,
  node,
  agentRun,
}: {
  stage: string;
  node: GoalNode | null;
  agentRun: AgentRun | null;
}) {
  const status: NodeStatus = node?.status ?? "pending";

  let bg = "bg-white";
  let ring = "ring-1 ring-inset ring-ink/[0.08]";
  let dot = "bg-slate-400";
  let pulse = false;
  let label = "Pending";
  let labelClass = "text-slate-600";

  if (status === "done") {
    dot = "bg-emerald-500";
    label = "Done";
    labelClass = "text-emerald-700";
  } else if (status === "dispatched") {
    dot = "bg-sky-500";
    pulse = true;
    label = "Running";
    labelClass = "text-sky-700";
    ring = "ring-1 ring-inset ring-sky-200";
  } else if (status === "failed") {
    dot = "bg-rose-500";
    label = "Failed";
    labelClass = "text-rose-700";
    ring = "ring-1 ring-inset ring-rose-200";
    bg = "bg-rose-50/40";
  }

  return (
    <div className={`rounded-xl px-4 py-3 ${bg} ${ring}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden
            className={`inline-block h-2 w-2 rounded-full ${dot} ${pulse ? "animate-pulse" : ""}`}
          />
          <span className="text-[13px] font-semibold capitalize text-ink">{stage}</span>
          <span className={`text-[12px] font-medium ${labelClass}`}>{label}</span>
        </div>
        <span className="text-[12px] text-inkMuted">
          {node?.finished_at
            ? `Finished ${relativeTime(node.finished_at)}`
            : node?.started_at
              ? `Started ${relativeTime(node.started_at)}`
              : ""}
        </span>
      </div>

      {}
      {agentRun && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-inkMuted">
          <span>
            <span className="text-inkMuted">Agent:</span>{" "}
            <span className="font-mono text-ink">{agentRun.agent_slug}</span>
          </span>
          <span>
            <span className="text-inkMuted">Duration:</span>{" "}
            {fmtDuration(agentRun.started_at, agentRun.finished_at)}
          </span>
          <span>
            <span className="text-inkMuted">Cost:</span>{" "}
            <span className="font-mono">{fmtUsd(agentRun.cost_usd)}</span>
          </span>
          <span className="font-mono text-[11px] text-ink/50">
            #{agentRun.id.slice(0, 8)}
          </span>
        </div>
      )}

      {}
      {node?.error && (
        <p className="mt-2 rounded border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[12px] text-rose-800">
          {node.error}
        </p>
      )}
    </div>
  );
}

function AgentRunStatusPill({
  status,
  presentationStatus,
  sideEffectKind,
}: {
  status: string;
  presentationStatus?: "answered" | "failed" | "running" | "cancelled";
  sideEffectKind?: string | null;
}) {
  let bg = "bg-slate-100";
  let text = "text-slate-700";
  let dot = "bg-slate-400";
  let pulse = false;
  let label = status;

  const shipped = sideEffectKind === "shipped";
  const answeredOverride =
    presentationStatus === "answered" &&
    (status === "parse_failed" || status === "dispatch_error");

  if (shipped) {
    bg = "bg-emerald-100";
    text = "text-emerald-800";
    dot = "bg-emerald-600";
    label = "Shipped";
  } else if (status === "success") {
    bg = "bg-emerald-50";
    text = "text-emerald-700";
    dot = "bg-emerald-500";
    label = "Success";
  } else if (answeredOverride) {
    bg = "bg-amber-50";
    text = "text-amber-700";
    dot = "bg-amber-500";
    label = "Answered";
  } else if (status === "running") {
    bg = "bg-sky-50";
    text = "text-sky-700";
    dot = "bg-sky-500";
    pulse = true;
    label = "Running";
  } else if (status === "queued") {
    bg = "bg-slate-100";
    text = "text-slate-700";
    dot = "bg-slate-400";
    label = "Queued";
  } else if (status === "parse_failed" || status === "dispatch_error") {
    bg = "bg-rose-50";
    text = "text-rose-700";
    dot = "bg-rose-500";
    label = status === "parse_failed" ? "Parse failed" : "Dispatch error";
  }

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none ${bg} ${text}`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${dot} ${pulse ? "animate-pulse" : ""}`}
      />
      <span className="capitalize">{label}</span>
    </span>
  );
}

function LedgerRowCard({ row }: { row: LedgerRow }) {
  let actionBg = "bg-slate-100";
  let actionText = "text-slate-700";
  if (row.action === "dispatch" || row.action === "dispatched") {
    actionBg = "bg-sky-50";
    actionText = "text-sky-700";
  } else if (row.action === "completed") {
    actionBg = "bg-emerald-50";
    actionText = "text-emerald-700";
  } else if (row.action === "halted" || row.action === "dispatch_failed") {
    actionBg = "bg-rose-50";
    actionText = "text-rose-700";
  } else if (row.action === "undo") {
    actionBg = "bg-amber-50";
    actionText = "text-amber-700";
  }

  return (
    <div className="rounded-xl border border-ink/[0.08] bg-white px-4 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide leading-none ${actionBg} ${actionText}`}
          >
            {row.action ?? "-"}
          </span>
          {row.target_agent_slug && (
            <span className="font-mono text-[12px] text-ink">
              {row.target_agent_slug}
            </span>
          )}
          {row.node_id && (
            <span className="text-[12px] text-inkMuted">
              node <span className="font-mono">{row.node_id}</span>
            </span>
          )}
          {row.outcome && (
            <span className="text-[12px] text-inkMuted">
              outcome <span className="font-medium text-ink">{row.outcome}</span>
            </span>
          )}
          {row.spend_delta !== 0 && (
            <span className="font-mono text-[12px] text-inkMuted">
              {row.spend_delta > 0 ? "+" : ""}
              {fmtUsd(row.spend_delta)}
            </span>
          )}
        </div>
        <span className="text-[11px] text-inkMuted">{relativeTime(row.created_at)}</span>
      </div>
      {row.error && (
        <p className="mt-1.5 text-[12px] text-rose-700">{row.error}</p>
      )}
    </div>
  );
}

function SkeletonDetail() {
  return (
    <div className="animate-pulse" aria-busy aria-label="Loading build">
      <div className="h-4 w-20 rounded bg-ink/[0.06]" />
      <div className="mt-2 h-7 w-2/3 rounded bg-ink/[0.06]" />
      <div className="mt-2 h-3 w-1/3 rounded bg-ink/[0.06]" />
      <div className="mt-6 h-1.5 w-full rounded-full bg-ink/[0.06]" />
      <div className="mt-8 space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-14 rounded-xl bg-ink/[0.04]" />
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-4">
      <p className="text-[16px] font-semibold text-rose-800">
        Couldn&apos;t load this build
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

function NotFoundState() {
  return (
    <div className="mt-6 rounded-xl border border-ink/[0.08] bg-white px-6 py-10 text-center">
      <p className="text-[16px] font-medium text-ink">Build not found</p>
      <p className="mt-2 text-[13px] text-inkMuted leading-[1.55]">
        This build either doesn&apos;t exist, was deleted, or belongs to a
        different workspace.
      </p>
      <Link
        href="/workspace/runs"
        className="mt-5 inline-flex items-center justify-center rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-cream hover:bg-ink/90"
      >
        Back to all builds
      </Link>
    </div>
  );
}

function SessionExpired({ runId }: { runId: string }) {
  return (
    <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
      <p className="text-[16px] font-semibold text-amber-800">Session expired</p>
      <p className="mt-1 text-[13px] text-amber-700 leading-[1.5]">
        Your sign-in token has timed out. Sign in again to see this build.
      </p>
      <Link
        href={`/login?next=${encodeURIComponent(`/workspace/runs/${runId}`)}`}
        className="mt-3 inline-flex items-center justify-center rounded-full bg-ink px-4 py-1.5 text-[13px] font-semibold text-cream hover:bg-ink/90"
      >
        Sign in
      </Link>
    </div>
  );
}
