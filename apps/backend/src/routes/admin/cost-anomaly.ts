
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type Row = {
  tenant_id: string;
  display_name: string | null;
  slug: string | null;
  cost_24h: number;
  avg_daily_7d: number;
  x_multiple: number | null;
  spike: boolean;
  top_absolute: boolean;
  flag: string;
};

export const SPIKE_MULTIPLE = 3;
const TOP_N_ABSOLUTE = 10;

export async function staffCostAnomaly(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/cost-anomaly: cross-tenant staff read-only board");

  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since8d = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();

  const [runs, tenants] = await Promise.all([
    sb
      .from("agent_runs")
      .select("tenant_id, cost_usd, enqueued_at")
      .gte("enqueued_at", since8d)
      .limit(50000),
    sb.from("tenants").select("id, display_name, slug").limit(5000),
  ]);

  const tenantById = new Map<string, { display_name: string | null; slug: string | null }>();
  for (const t of (tenants.data ?? []) as Array<{ id: string; display_name: string | null; slug: string | null }>) {
    tenantById.set(t.id, { display_name: t.display_name ?? null, slug: t.slug ?? null });
  }

  const acc = new Map<string, { c24: number; cPrior: number }>();
  const bump = (id: string): { c24: number; cPrior: number } => {
    let a = acc.get(id);
    if (!a) {
      a = { c24: 0, cPrior: 0 };
      acc.set(id, a);
    }
    return a;
  };

  for (const run of (runs.data ?? []) as Array<{ tenant_id: string | null; cost_usd: number | null; enqueued_at: string | null }>) {
    if (!run.tenant_id || !run.enqueued_at) continue;
    const cost = Number(run.cost_usd) || 0;
    if (cost <= 0) continue;
    const a = bump(run.tenant_id);
    if (run.enqueued_at >= since24h) a.c24 += cost;
    else a.cPrior += cost;
  }

  const rows: Row[] = [];
  for (const [tenantId, a] of acc) {
    if (a.c24 <= 0) continue;
    const avgDaily = a.cPrior / 7;
    const meta = tenantById.get(tenantId) ?? { display_name: null, slug: null };
    const xMultiple = avgDaily > 0 ? a.c24 / avgDaily : null;
    const spike = avgDaily > 0 && a.c24 >= SPIKE_MULTIPLE * avgDaily;
    rows.push({
      tenant_id: tenantId,
      display_name: meta.display_name,
      slug: meta.slug,
      cost_24h: Math.round(a.c24 * 100) / 100,
      avg_daily_7d: Math.round(avgDaily * 100) / 100,
      x_multiple: xMultiple == null ? null : Math.round(xMultiple * 10) / 10,
      spike,
      top_absolute: false,
      flag: "",
    });
  }

  rows.sort((x, y) => y.cost_24h - x.cost_24h);
  rows.forEach((r, i) => {
    r.top_absolute = i < TOP_N_ABSOLUTE;
    r.flag = r.spike ? "spike" : r.top_absolute ? "top-spend" : "";
  });

  const flagged = rows.filter((r) => r.spike || r.top_absolute);

  res.json({ tenants: flagged });
}
