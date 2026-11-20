
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type SubRow = {
  plan: string | null;
  status: string | null;
};

type PlanBreakdown = {
  plan: string;
  active: number;
  trialing: number;
  past_due: number;
  grandfathered: number;
  total: number;
};

const STATUSES = ["active", "trialing", "past_due", "canceled", "incomplete"] as const;

export async function staffRevenue(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/revenue: cross-tenant staff read-only board");

  const { data, error } = await sb
    .from("tenant_subscriptions")
    .select("plan, status")
    .limit(20000);

  if (error) {
    res.status(500).json({ error: { message: error.message } });
    return;
  }

  const rows = (data ?? []) as SubRow[];

  const totals: Record<string, number> = {
    active: 0,
    trialing: 0,
    past_due: 0,
    canceled: 0,
    incomplete: 0,
    grandfathered: 0,
    total: 0,
  };

  const byPlan = new Map<string, PlanBreakdown>();
  const getPlan = (plan: string): PlanBreakdown => {
    let p = byPlan.get(plan);
    if (!p) {
      p = { plan, active: 0, trialing: 0, past_due: 0, grandfathered: 0, total: 0 };
      byPlan.set(plan, p);
    }
    return p;
  };

  for (const r of rows) {
    const plan = r.plan ?? "unknown";
    const status = r.status ?? "unknown";
    const p = getPlan(plan);

    totals.total += 1;
    p.total += 1;

    if ((STATUSES as readonly string[]).includes(status)) {
      totals[status] += 1;
    }
    if (status === "active") p.active += 1;
    else if (status === "trialing") p.trialing += 1;
    else if (status === "past_due") p.past_due += 1;
  }

  const plans = [...byPlan.values()].sort(
    (a, b) => b.active - a.active || b.total - a.total || a.plan.localeCompare(b.plan),
  );

  res.json({
    totals,
    by_plan: plans,
    mrr_available: false,
    note: "Per-subscription dollar amounts are not stored in the DB (plan price lives in Stripe), so MRR/ARR is not shown. Counts are exact.",
  });
}
