
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export type ValueReportRunInput = {
  tenant_id: string;
  agent_slug: string;
  agent_definition_hash: string | null;
  parsed: Record<string, unknown> | null;
  started_at: string | null;
  finished_at: string | null;
};

export type ValueReportRow = {
  tenant_id: string;
  runs: number;
  runtime_seconds: number;
};

export type ValueReportTotals = {
  tenants: number;
  runs: number;
  runtime_seconds: number;
};

export type ValueReportResponse = {
  window_days: number;
  metric: "agent_runtime_time_on_task";
  totals: ValueReportTotals;
  rows: ValueReportRow[];
};

export function isSeedRun(row: {
  agent_definition_hash?: string | null;
  parsed?: Record<string, unknown> | null;
}): boolean {
  if (row.agent_definition_hash === "seed-synthetic") return true;
  const seed = row.parsed?.["seed"];
  return seed === true || seed === "true";
}

export function aggregateRuntime(runs: ValueReportRunInput[]): {
  totals: ValueReportTotals;
  rows: ValueReportRow[];
} {
  const byTenant = new Map<string, { runs: number; runtime_seconds: number }>();
  for (const r of runs) {
    if (isSeedRun(r)) continue;
    if (!r.started_at || !r.finished_at) continue;
    const ms = Date.parse(r.finished_at) - Date.parse(r.started_at);
    if (!Number.isFinite(ms)) continue;
    const seconds = Math.max(0, Math.round(ms / 1000));
    const cur = byTenant.get(r.tenant_id) ?? { runs: 0, runtime_seconds: 0 };
    cur.runs += 1;
    cur.runtime_seconds += seconds;
    byTenant.set(r.tenant_id, cur);
  }
  const rows: ValueReportRow[] = [...byTenant.entries()]
    .map(([tenant_id, v]) => ({ tenant_id, runs: v.runs, runtime_seconds: v.runtime_seconds }))
    .sort((a, b) => b.runtime_seconds - a.runtime_seconds);
  const totals = rows.reduce<ValueReportTotals>(
    (acc, r) => ({
      tenants: acc.tenants + 1,
      runs: acc.runs + r.runs,
      runtime_seconds: acc.runtime_seconds + r.runtime_seconds,
    }),
    { tenants: 0, runs: 0, runtime_seconds: 0 },
  );
  return { totals, rows };
}

const WINDOW_DAYS = 7;

export async function staffValueReport(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = serviceClient();
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const runsQ = await sb
    .from("agent_runs")
    .select("tenant_id, agent_slug, agent_definition_hash, parsed, started_at, finished_at")
    .gte("finished_at", since)
    .not("finished_at", "is", null);

  if (runsQ.error) {
    res.status(500).json({ error: { code: "runs_query_failed", message: runsQ.error.message } });
    return;
  }

  const { totals, rows } = aggregateRuntime((runsQ.data ?? []) as ValueReportRunInput[]);
  const body: ValueReportResponse = {
    window_days: WINDOW_DAYS,
    metric: "agent_runtime_time_on_task",
    totals,
    rows,
  };
  res.json(body);
}
