
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type Cohort = {
  week: string;
  week_start: string;
  signups: number;
  activated: number;
  activation_pct: number;
};

function isoWeekKey(d: Date): { key: string; monday: Date } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - (day - 1));
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + (4 - day));
  const isoYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { key: `${isoYear}-W${String(week).padStart(2, "0")}`, monday };
}

export async function staffCohorts(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/cohorts: cross-tenant staff read-only board");

  const tenantsRes = await sb
    .from("tenants")
    .select("id, created_at")
    .order("created_at", { ascending: false })
    .limit(5000);

  type Tenant = { id: string; created_at: string | null };
  const tenants = (tenantsRes.data ?? []) as Tenant[];

  const buckets = new Map<string, { week_start: string; ids: string[] }>();
  for (const t of tenants) {
    if (!t.created_at) continue;
    const { key, monday } = isoWeekKey(new Date(t.created_at));
    const b = buckets.get(key);
    if (b) {
      b.ids.push(t.id);
    } else {
      buckets.set(key, { week_start: monday.toISOString().slice(0, 10), ids: [t.id] });
    }
  }

  const recent = Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .slice(0, 12);

  const scopedIds = recent.flatMap(([, b]) => b.ids);
  const activatedSet = new Set<string>();
  if (scopedIds.length > 0) {
    const runsRes = await sb
      .from("agent_runs")
      .select("tenant_id")
      .in("tenant_id", scopedIds)
      .limit(50000);
    for (const r of (runsRes.data ?? []) as Array<{ tenant_id: string | null }>) {
      if (r.tenant_id) activatedSet.add(r.tenant_id);
    }
  }

  const cohorts: Cohort[] = recent.map(([week, b]) => {
    const signups = b.ids.length;
    const activated = b.ids.filter((id) => activatedSet.has(id)).length;
    return {
      week,
      week_start: b.week_start,
      signups,
      activated,
      activation_pct: signups > 0 ? Math.round((activated / signups) * 100) : 0,
    };
  });

  const totalSignups = cohorts.reduce((s, c) => s + c.signups, 0);
  const totalActivated = cohorts.reduce((s, c) => s + c.activated, 0);

  res.json({
    cohorts,
    summary: {
      cohorts: cohorts.length,
      signups: totalSignups,
      activated: totalActivated,
      activation_pct: totalSignups > 0 ? Math.round((totalActivated / totalSignups) * 100) : 0,
    },
  });
}
