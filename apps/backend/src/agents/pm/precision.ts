
import { serviceClient } from "@/services/supabase";
import type { AgentContext } from "@/services/agents/types";

export const PRECISION_WINDOW_DAYS = 45;
export const MAX_DISPATCHES_SCANNED = 30;
export const MIN_SETTLED_SAMPLE = 4;
export const PRECISION_THRESHOLD = 0.5;

export type DispatchPrecision = {
  precision: number | null;
  settled: number;
  good: number;
  bad: number;
  scanned: number;
  downgrade: boolean;
};

const NEUTRAL: DispatchPrecision = {
  precision: null,
  settled: 0,
  good: 0,
  bad: 0,
  scanned: 0,
  downgrade: false,
};

import { decisionVerdict } from "../../services/decisions/status";

export async function computeDispatchPrecision(ctx: AgentContext): Promise<DispatchPrecision> {
  const sb = serviceClient();
  const since = new Date(Date.now() - PRECISION_WINDOW_DAYS * 86400 * 1000).toISOString();

  const { data: dispData, error: dispErr } = await sb
    .from("dispatch_history")
    .select("target_run_id, dedup_key, created_at")
    .eq("tenant_id", ctx.tenant_id)
    .eq("source_agent_slug", "pm")
    .eq("target_agent_slug", "engineer")
    .gt("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_DISPATCHES_SCANNED);
  if (dispErr) {
    console.warn(`[pm precision] dispatch_history read failed for tenant=${ctx.tenant_id}: ${dispErr.message}`);
    return NEUTRAL;
  }
  const dispatches = ((dispData ?? []) as Array<{
    target_run_id: string | null;
    dedup_key: string | null;
    created_at: string;
  }>).filter((d) => typeof d.target_run_id === "string" && d.target_run_id);
  if (dispatches.length === 0) return NEUTRAL;

  const childRunIds = [...new Set(dispatches.map((d) => d.target_run_id as string))];
  const dedupKeys = [...new Set(dispatches.map((d) => d.dedup_key).filter((k): k is string => typeof k === "string" && k.length > 0))];

  const runStatusById = new Map<string, string>();
  {
    const { data, error } = await sb
      .from("agent_runs")
      .select("id, status")
      .eq("tenant_id", ctx.tenant_id)
      .in("id", childRunIds);
    if (error) {
      console.warn(`[pm precision] agent_runs read failed for tenant=${ctx.tenant_id}: ${error.message}`);
      return NEUTRAL;
    }
    for (const r of (data ?? []) as Array<{ id: string; status: string | null }>) {
      if (typeof r.status === "string") runStatusById.set(r.id, r.status);
    }
  }

  const decisionVerdictByRun = new Map<string, "accepted" | "rejected">();
  {
    const { data, error } = await sb
      .from("decisions")
      .select("agent_run_id, status, dispatch_error, body")
      .eq("tenant_id", ctx.tenant_id)
      .in("agent_run_id", childRunIds);
    if (error) {
      console.warn(`[pm precision] decisions read failed for tenant=${ctx.tenant_id}: ${error.message}`);
      return NEUTRAL;
    }
    for (const row of (data ?? []) as Array<{
      agent_run_id: string | null;
      status: string | null;
      dispatch_error?: string | null;
      body?: Record<string, unknown> | null;
    }>) {
      const runId = row.agent_run_id;
      const status = row.status;
      if (typeof runId !== "string" || typeof status !== "string") continue;
      const verdict = decisionVerdict({
        status,
        dispatch_error: row.dispatch_error ?? null,
        body: row.body ?? {},
      });
      if (verdict === null) continue;
      const prior = decisionVerdictByRun.get(runId);
      if (prior === "rejected") continue;
      if (verdict === "rejected") decisionVerdictByRun.set(runId, "rejected");
      else if (verdict === "accepted" && prior !== "accepted") decisionVerdictByRun.set(runId, "accepted");
    }
  }

  const roadmapOutcomeByKey = new Map<string, "won" | "recurred">();
  if (dedupKeys.length > 0) {
    const { data, error } = await sb
      .from("pm_roadmap")
      .select("dedup_key, outcome")
      .eq("tenant_id", ctx.tenant_id)
      .in("dedup_key", dedupKeys);
    if (error) {
      console.warn(`[pm precision] pm_roadmap read failed for tenant=${ctx.tenant_id}: ${error.message}`);
      return NEUTRAL;
    }
    for (const row of (data ?? []) as Array<{ dedup_key: string | null; outcome: string | null }>) {
      if (typeof row.dedup_key !== "string") continue;
      if (row.outcome === "won" || row.outcome === "recurred") roadmapOutcomeByKey.set(row.dedup_key, row.outcome);
    }
  }

  let good = 0;
  let bad = 0;
  for (const d of dispatches) {
    const runId = d.target_run_id as string;
    const dedupKey = typeof d.dedup_key === "string" ? d.dedup_key : "";
    const runStatus = runStatusById.get(runId);
    const decision = decisionVerdictByRun.get(runId);
    const roadmap = dedupKey ? roadmapOutcomeByKey.get(dedupKey) : undefined;

    const runFailed = runStatus === "failed" || runStatus === "dispatch_error" || runStatus === "parse_failed";
    const isBad = runFailed || decision === "rejected" || roadmap === "recurred";
    const isGood = decision === "accepted" || roadmap === "won";

    if (isBad) bad += 1;
    else if (isGood) good += 1;
  }

  const settled = good + bad;
  const precision = settled > 0 ? good / settled : null;
  const downgrade =
    settled >= MIN_SETTLED_SAMPLE && precision !== null && precision < PRECISION_THRESHOLD;

  return { precision, settled, good, bad, scanned: dispatches.length, downgrade };
}
