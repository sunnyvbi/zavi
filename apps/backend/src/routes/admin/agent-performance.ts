
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { normalizeErrorSignature } from "./errors";

const PAGE = 1000;
const MAX_PAGES = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

export type PerfRunRow = {
  id: string;
  tenant_id: string;
  agent_slug: string | null;
  trigger: string | null;
  status: string | null;
  enqueued_at: string | null;
  started_at: string | null;
  cost_usd: number | null;
  error: string | null;
  liveness_tier: string | null;
  failure_class: string | null;
};

export type PerfDecisionRow = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  status: string | null;
};

export type DecisionBucket =
  | "acted"
  | "approved"
  | "rejected"
  | "expired"
  | "dispatch_failed"
  | "open"
  | "superseded"
  | "dispatching"
  | "other";

export const DECISION_BUCKETS: readonly DecisionBucket[] = [
  "acted", "approved", "rejected", "expired",
  "dispatch_failed", "open", "superseded", "dispatching", "other",
] as const;

export function bucketDecisionStatus(status: string | null | undefined): DecisionBucket {
  switch (status) {
    case "acted": return "acted";
    case "approved": return "approved";
    case "rejected": return "rejected";
    case "expired": return "expired";
    case "dispatch_failed": return "dispatch_failed";
    case "proposed": return "open";
    case "superseded": return "superseded";
    case "dispatching": return "dispatching";
    default: return "other";
  }
}

export type FunnelCounts = Record<DecisionBucket, number>;

export type DecisionFunnel = {
  total: number;
  counts: FunnelCounts;
  accepted: number;
  unattributed: number;
  by_agent: Array<{ agent_slug: string; total: number; counts: FunnelCounts; accepted: number }>;
};

function emptyCounts(): FunnelCounts {
  return {
    acted: 0, approved: 0, rejected: 0, expired: 0,
    dispatch_failed: 0, open: 0, superseded: 0, dispatching: 0, other: 0,
  };
}

export function rollupDecisions(
  rows: PerfDecisionRow[],
  slugByRunId: Map<string, string>,
): DecisionFunnel {
  const counts = emptyCounts();
  const byAgent = new Map<string, { total: number; counts: FunnelCounts }>();
  let unattributed = 0;

  for (const d of rows) {
    const b = bucketDecisionStatus(d.status);
    counts[b] += 1;

    const slug = d.agent_run_id ? slugByRunId.get(d.agent_run_id) : undefined;
    if (!slug) {
      unattributed += 1;
      continue;
    }
    let a = byAgent.get(slug);
    if (!a) {
      a = { total: 0, counts: emptyCounts() };
      byAgent.set(slug, a);
    }
    a.total += 1;
    a.counts[b] += 1;
  }

  const by_agent = [...byAgent.entries()]
    .map(([agent_slug, v]) => ({
      agent_slug,
      total: v.total,
      counts: v.counts,
      accepted: v.counts.acted + v.counts.approved,
    }))
    .sort((x, y) => y.total - x.total);

  return {
    total: rows.length,
    counts,
    accepted: counts.acted + counts.approved,
    unattributed,
    by_agent,
  };
}

export type LivenessCell = {
  runs_total: number;
  runs_classified: number;
  shipped: number;
  answered: number;
  plan_only: number;
  empty: number;
  other: number;
  shipped_rate: number | null;
  coverage: number | null;
};

function emptyCell(): LivenessCell {
  return {
    runs_total: 0, runs_classified: 0, shipped: 0, answered: 0,
    plan_only: 0, empty: 0, other: 0, shipped_rate: null, coverage: null,
  };
}

function addRun(cell: LivenessCell, tier: string | null): void {
  cell.runs_total += 1;
  if (tier == null || tier === "") return;
  cell.runs_classified += 1;
  switch (tier) {
    case "shipped": cell.shipped += 1; break;
    case "answered": cell.answered += 1; break;
    case "plan_only": cell.plan_only += 1; break;
    case "empty": cell.empty += 1; break;
    default: cell.other += 1; break;
  }
}

function sealCell(cell: LivenessCell): LivenessCell {
  cell.shipped_rate = cell.runs_classified > 0 ? cell.shipped / cell.runs_classified : null;
  cell.coverage = cell.runs_total > 0 ? cell.runs_classified / cell.runs_total : null;
  return cell;
}

export type LivenessRollup = {
  overall: LivenessCell;
  by_trigger: Array<{ trigger: string } & LivenessCell>;
  by_agent: Array<{ agent_slug: string } & LivenessCell>;
};

export function rollupLiveness(runs: PerfRunRow[]): LivenessRollup {
  const overall = emptyCell();
  const byTrigger = new Map<string, LivenessCell>();
  const byAgent = new Map<string, LivenessCell>();

  for (const r of runs) {
    addRun(overall, r.liveness_tier);
    const t = r.trigger ?? "(none)";
    if (!byTrigger.has(t)) byTrigger.set(t, emptyCell());
    addRun(byTrigger.get(t)!, r.liveness_tier);
    const s = r.agent_slug ?? "(none)";
    if (!byAgent.has(s)) byAgent.set(s, emptyCell());
    addRun(byAgent.get(s)!, r.liveness_tier);
  }

  return {
    overall: sealCell(overall),
    by_trigger: [...byTrigger.entries()]
      .map(([trigger, c]) => ({ trigger, ...sealCell(c) }))
      .sort((a, b) => b.runs_total - a.runs_total),
    by_agent: [...byAgent.entries()]
      .map(([agent_slug, c]) => ({ agent_slug, ...sealCell(c) }))
      .sort((a, b) => b.runs_total - a.runs_total),
  };
}

export type CostRow = {
  agent_slug: string;
  runs: number;
  cost_usd: number;
  shipped: number;
  runs_classified: number;
  cost_per_shipped: number | null;
  coverage: number | null;
};

export function rollupCost(runs: PerfRunRow[]): { by_agent: CostRow[]; total_usd: number } {
  const m = new Map<string, CostRow>();
  let total_usd = 0;
  for (const r of runs) {
    const slug = r.agent_slug ?? "(none)";
    let c = m.get(slug);
    if (!c) {
      c = { agent_slug: slug, runs: 0, cost_usd: 0, shipped: 0, runs_classified: 0, cost_per_shipped: null, coverage: null };
      m.set(slug, c);
    }
    c.runs += 1;
    const usd = Number(r.cost_usd ?? 0);
    if (Number.isFinite(usd)) {
      c.cost_usd += usd;
      total_usd += usd;
    }
    if (r.liveness_tier != null && r.liveness_tier !== "") {
      c.runs_classified += 1;
      if (r.liveness_tier === "shipped") c.shipped += 1;
    }
  }
  const by_agent = [...m.values()].map((c) => {
    c.cost_per_shipped = c.shipped > 0 ? c.cost_usd / c.shipped : null;
    c.coverage = c.runs > 0 ? c.runs_classified / c.runs : null;
    return c;
  });
  by_agent.sort((a, b) => (b.cost_per_shipped ?? -1) - (a.cost_per_shipped ?? -1));
  return { by_agent, total_usd };
}

export type FailureMix = {
  runs_total: number;
  failed_total: number;
  cancelled_total: number;
  by_class: Record<string, number>;
  by_agent: Array<{ agent_slug: string; failed: number; by_class: Record<string, number> }>;
  top_signatures: Array<{ signature: string; count: number; agents: string[] }>;
};

const FAILED_STATUSES = new Set(["failed", "parse_failed", "dispatch_error", "error"]);

export function isCancelledRun(r: PerfRunRow): boolean {
  return r.failure_class === "cancelled" || r.status === "cancelled";
}

export function isFailedRun(r: PerfRunRow): boolean {
  if (isCancelledRun(r)) return false;
  const cls = r.failure_class;
  if (cls != null && cls !== "" && cls !== "none") return true;
  return FAILED_STATUSES.has(r.status ?? "");
}

const MAX_SIGNATURES = 15;

export function rollupFailure(runs: PerfRunRow[]): FailureMix {
  const by_class: Record<string, number> = {};
  const byAgent = new Map<string, { failed: number; by_class: Record<string, number> }>();
  const sigs = new Map<string, { count: number; agents: Set<string> }>();
  let failed_total = 0;
  let cancelled_total = 0;

  for (const r of runs) {
    if (isCancelledRun(r)) {
      cancelled_total += 1;
      continue;
    }
    if (!isFailedRun(r)) continue;
    failed_total += 1;
    const cls = r.failure_class && r.failure_class !== "" ? r.failure_class : "unknown";
    by_class[cls] = (by_class[cls] ?? 0) + 1;

    const slug = r.agent_slug ?? "(none)";
    let a = byAgent.get(slug);
    if (!a) {
      a = { failed: 0, by_class: {} };
      byAgent.set(slug, a);
    }
    a.failed += 1;
    a.by_class[cls] = (a.by_class[cls] ?? 0) + 1;

    const sig = normalizeErrorSignature(r.error);
    let s = sigs.get(sig);
    if (!s) {
      s = { count: 0, agents: new Set() };
      sigs.set(sig, s);
    }
    s.count += 1;
    s.agents.add(slug);
  }

  return {
    runs_total: runs.length,
    failed_total,
    cancelled_total,
    by_class,
    by_agent: [...byAgent.entries()]
      .map(([agent_slug, v]) => ({ agent_slug, ...v }))
      .sort((a, b) => b.failed - a.failed),
    top_signatures: [...sigs.entries()]
      .map(([signature, v]) => ({ signature, count: v.count, agents: [...v.agents].sort() }))
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_SIGNATURES),
  };
}

export function percentile(sortedAsc: number[], q: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const qq = Math.min(1, Math.max(0, q));
  const idx = (n - 1) * qq;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

const TERMINAL_STATUSES = new Set([
  "success", "failed", "parse_failed", "dispatch_error", "cancelled", "error",
]);

export type QueueWait = {
  sample: number;
  p50_ms: number | null;
  p95_ms: number | null;
  still_waiting: number;
  never_started: number;
  oldest_waiting_ms: number | null;
  negative_waits: number;
  by_agent: Array<{ agent_slug: string; sample: number; p50_ms: number | null; p95_ms: number | null }>;
};

export function computeQueueWait(runs: PerfRunRow[], nowMs: number): QueueWait {
  const all: number[] = [];
  const byAgent = new Map<string, number[]>();
  let still_waiting = 0;
  let never_started = 0;
  let negative_waits = 0;
  let oldest_waiting_ms: number | null = null;

  for (const r of runs) {
    if (!r.enqueued_at) continue;
    const enq = Date.parse(r.enqueued_at);
    if (!Number.isFinite(enq)) continue;

    if (!r.started_at) {
      if (TERMINAL_STATUSES.has(r.status ?? "")) {
        never_started += 1;
        continue;
      }
      still_waiting += 1;
      const age = nowMs - enq;
      if (age >= 0 && (oldest_waiting_ms === null || age > oldest_waiting_ms)) {
        oldest_waiting_ms = age;
      }
      continue;
    }
    const st = Date.parse(r.started_at);
    if (!Number.isFinite(st)) continue;
    const wait = st - enq;
    if (wait < 0) {
      negative_waits += 1;
      continue;
    }
    all.push(wait);
    const slug = r.agent_slug ?? "(none)";
    if (!byAgent.has(slug)) byAgent.set(slug, []);
    byAgent.get(slug)!.push(wait);
  }

  all.sort((a, b) => a - b);
  return {
    sample: all.length,
    p50_ms: percentile(all, 0.5),
    p95_ms: percentile(all, 0.95),
    still_waiting,
    never_started,
    oldest_waiting_ms,
    negative_waits,
    by_agent: [...byAgent.entries()]
      .map(([agent_slug, xs]) => {
        xs.sort((a, b) => a - b);
        return { agent_slug, sample: xs.length, p50_ms: percentile(xs, 0.5), p95_ms: percentile(xs, 0.95) };
      })
      .sort((a, b) => (b.p95_ms ?? -1) - (a.p95_ms ?? -1)),
  };
}

type PageFn<T> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

export async function fetchAllPaged<T>(page: PageFn<T>): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const from = i * PAGE;
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export function attributeParentRuns(
  decisions: PerfDecisionRow[],
  parents: Array<{ id: string; tenant_id: string; agent_slug: string | null }>,
  into: Map<string, string>,
): Map<string, string> {
  const tenantsByRunId = new Map<string, Set<string>>();
  for (const d of decisions) {
    if (!d.agent_run_id) continue;
    let seen = tenantsByRunId.get(d.agent_run_id);
    if (!seen) tenantsByRunId.set(d.agent_run_id, (seen = new Set()));
    seen.add(d.tenant_id);
  }
  for (const p of parents) {
    if (!p.agent_slug) continue;
    if (!tenantsByRunId.get(p.id)?.has(p.tenant_id)) continue;
    into.set(p.id, p.agent_slug);
  }
  return into;
}

export function parseDays(raw: unknown): number {
  const n = Number(raw ?? 30);
  if (!Number.isFinite(n)) return 30;
  return Math.min(90, Math.max(1, Math.floor(n)));
}

export async function staffAgentPerformance(req: Request, res: Response): Promise<void> {
  assertStaff(req);

  const days = parseDays(req.query.days);
  const tenantId = typeof req.query.tenant_id === "string" ? req.query.tenant_id : undefined;
  const agentSlug = typeof req.query.agent_slug === "string" ? req.query.agent_slug : undefined;

  if (tenantId !== undefined && !UUID_RE.test(tenantId)) {
    res.status(400).json({ error: { code: "bad_tenant_id", message: "tenant_id must be a uuid" } });
    return;
  }
  if (agentSlug !== undefined && !SLUG_RE.test(agentSlug)) {
    res.status(400).json({ error: { code: "bad_agent_slug", message: "agent_slug must be a slug" } });
    return;
  }

  const nowMs = Date.now();
  const until = new Date(nowMs).toISOString();
  const since = new Date(nowMs - days * 86400_000).toISOString();

  const sb = staffCrossTenantClient("admin/agent-performance: cross-tenant staff fleet metrics board");

  try {
    const runsQ = (from: number, to: number) => {
      let q = sb
        .from("agent_runs")
        .select(
          "id, tenant_id, agent_slug, trigger, status, enqueued_at, started_at, cost_usd, error, liveness_tier:outcome->>liveness_tier, failure_class:outcome->failure->>class",
        )
        .gte("enqueued_at", since)
        .lt("enqueued_at", until)
        .order("enqueued_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
      if (tenantId) q = q.eq("tenant_id", tenantId);
      if (agentSlug) q = q.eq("agent_slug", agentSlug);
      return q;
    };

    const decisionsQ = (from: number, to: number) => {
      let q = sb
        .from("decisions")
        .select("id, tenant_id, agent_run_id, status")
        .gte("emitted_at", since)
        .lt("emitted_at", until)
        .order("emitted_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
      if (tenantId) q = q.eq("tenant_id", tenantId);
      return q;
    };

    const [runsRes, decRes] = await Promise.all([
      fetchAllPaged<PerfRunRow>(runsQ),
      fetchAllPaged<PerfDecisionRow>(decisionsQ),
    ]);
    const runs = runsRes.rows;
    const decisions = decRes.rows;

    const slugByRunId = attributeParentRuns(decisions, runs, new Map());

    const missing = [
      ...new Set(
        decisions
          .map((d) => d.agent_run_id)
          .filter((x): x is string => !!x && !slugByRunId.has(x)),
      ),
    ];
    for (let i = 0; i < missing.length; i += 200) {
      const chunk = missing.slice(i, i + 200);
      let q = sb.from("agent_runs").select("id, tenant_id, agent_slug").in("id", chunk);
      if (tenantId) q = q.eq("tenant_id", tenantId);
      const { data, error } = await q;
      if (error) throw new Error(`parent-run lookup failed: ${error.message}`);
      attributeParentRuns(
        decisions,
        (data ?? []) as Array<{ id: string; tenant_id: string; agent_slug: string | null }>,
        slugByRunId,
      );
    }

    const scopedDecisions = agentSlug
      ? decisions.filter((d) => d.agent_run_id && slugByRunId.get(d.agent_run_id) === agentSlug)
      : decisions;

    const liveness = rollupLiveness(runs);

    res.json({
      window: { days, since, until },
      truncated: runsRes.truncated || decRes.truncated,
      coverage: {
        runs_total: liveness.overall.runs_total,
        runs_classified: liveness.overall.runs_classified,
        pct_classified: liveness.overall.coverage,
        decisions_total: scopedDecisions.length,
        note:
          "shipped_rate is computed over runs_classified only; liveness_tier exists from 2026-07-07 and is not backfilled",
      },
      decision_funnel: rollupDecisions(scopedDecisions, slugByRunId),
      liveness,
      cost: rollupCost(runs),
      failure: rollupFailure(runs),
      queue_wait: computeQueueWait(runs, nowMs),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    res.status(500).json({ error: { code: "agent_performance_query_failed", message } });
  }
}
