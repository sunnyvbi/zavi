
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

type EvalRunRow = {
  tenant_id: string;
  ran_at: string;
  queries_run: number;
  top3_recall: number;
  mrr: number;
  cross_tenant_hits: number;
  alarmed: boolean;
  alert_threshold_top3_recall: number;
};

export async function staffBrainMetrics(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await serviceClient()
    .from("memory_recall_eval_run")
    .select("tenant_id, ran_at, queries_run, top3_recall, mrr, cross_tenant_hits, alarmed, alert_threshold_top3_recall")
    .eq("run_kind", "eval")
    .gte("ran_at", since)
    .order("ran_at", { ascending: false })
    .limit(5000);
  if (error) {
    res.status(500).json({ error: { code: "brain_metrics_query_failed", message: error.message } });
    return;
  }

  const latestByTenant = new Map<string, EvalRunRow>();
  for (const r of (data ?? []) as EvalRunRow[]) {
    if (!latestByTenant.has(r.tenant_id)) latestByTenant.set(r.tenant_id, r);
  }
  const tenants = Array.from(latestByTenant.values()).map((r) => ({
    tenant_id: r.tenant_id,
    ran_at: r.ran_at,
    queries_run: r.queries_run,
    top3_recall: r.top3_recall,
    mrr: r.mrr,
    cross_tenant_hits: r.cross_tenant_hits,
    alarmed: r.alarmed,
    slo: r.alert_threshold_top3_recall,
  }));

  const n = tenants.length;
  const avgTop3 = n > 0 ? Number((tenants.reduce((s, t) => s + Number(t.top3_recall), 0) / n).toFixed(4)) : null;
  const anyAlarmed = tenants.some((t) => t.alarmed);
  const anyCrossTenant = tenants.some((t) => t.cross_tenant_hits > 0);
  const slo = tenants.length > 0 ? tenants[0].slo : 0.85;

  res.json({
    window_days: days,
    run_kind: "eval",
    slo,
    fleet: { tenants_with_recent_eval: n, avg_top3_recall: avgTop3, any_alarmed: anyAlarmed, any_cross_tenant_leak: anyCrossTenant },
    tenants,
  });
}
