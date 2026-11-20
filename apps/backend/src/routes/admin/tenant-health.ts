
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

const FAILED = new Set(["failed", "parse_failed", "dispatch_error"]);

type Health = "at_risk" | "watch" | "healthy";

type Row = {
  tenant_id: string;
  tenant: string;
  slug: string;
  created_at: string | null;
  runs_7d: number;
  failed_7d: number;
  fail_rate: number;
  cost_7d: number;
  health: Health;
};

export async function staffTenantHealth(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/tenant-health: cross-tenant staff read-only board");

  const now = Date.now();
  const weekAgoMs = now - 7 * 24 * 60 * 60 * 1000;
  const weekAgoIso = new Date(weekAgoMs).toISOString();

  const [runs, tenants] = await Promise.all([
    sb
      .from("agent_runs")
      .select("tenant_id, status, cost_usd")
      .gte("enqueued_at", weekAgoIso)
      .limit(20000),
    sb.from("tenants").select("id, slug, display_name, created_at"),
  ]);

  type RunRow = { tenant_id: string | null; status: string | null; cost_usd: number | string | null };
  type Agg = { runs: number; failed: number; cost: number };
  const byTenant = new Map<string, Agg>();
  for (const r of (runs.data ?? []) as RunRow[]) {
    if (!r.tenant_id) continue;
    const a = byTenant.get(r.tenant_id) ?? { runs: 0, failed: 0, cost: 0 };
    a.runs += 1;
    if (r.status && FAILED.has(r.status)) a.failed += 1;
    a.cost += Number(r.cost_usd) || 0;
    byTenant.set(r.tenant_id, a);
  }

  type Tenant = { id: string; slug: string; display_name: string | null; created_at: string | null };
  const rows: Row[] = ((tenants.data ?? []) as Tenant[]).map((t) => {
    const a = byTenant.get(t.id) ?? { runs: 0, failed: 0, cost: 0 };
    const failRate = a.runs > 0 ? (a.failed / a.runs) * 100 : 0;
    const olderThan7d = t.created_at ? new Date(t.created_at).getTime() < weekAgoMs : false;

    let health: Health = "healthy";
    if (failRate >= 20 || (a.runs === 0 && olderThan7d)) health = "at_risk";
    else if (failRate >= 5) health = "watch";

    return {
      tenant_id: t.id,
      tenant: t.display_name || t.slug || t.id.slice(0, 8),
      slug: t.slug,
      created_at: t.created_at,
      runs_7d: a.runs,
      failed_7d: a.failed,
      fail_rate: Math.round(failRate * 10) / 10,
      cost_7d: Math.round(a.cost * 100) / 100,
      health,
    };
  });

  const rank: Record<Health, number> = { at_risk: 0, watch: 1, healthy: 2 };
  rows.sort(
    (a, b) => rank[a.health] - rank[b.health] || b.fail_rate - a.fail_rate || b.runs_7d - a.runs_7d,
  );

  res.json({
    tenants: rows,
    summary: {
      total: rows.length,
      at_risk: rows.filter((r) => r.health === "at_risk").length,
      watch: rows.filter((r) => r.health === "watch").length,
    },
  });
}
