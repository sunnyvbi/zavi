
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export const RENDER_STARTER_USD_MO = 7;
export const NEON_USD_MO = 0;

export type TenantCostRunInput = {
  tenant_id: string;
  agent_slug: string;
  cost_tokens: number | null;
  cost_usd: number | null;
};

export type InfraCounts = { render: number; neon: number };

export type TenantAgentBreakdown = {
  agent_slug: string;
  runs: number;
  tokens: number;
  usd: number;
};

export type TenantCostRow = {
  tenant_id: string;
  slug: string;
  display_name: string;
  runs: number;
  tokens: number;
  llm_usd: number;
  render_count: number;
  neon_count: number;
  infra_monthly_usd: number;
  infra_window_usd: number;
  total_window_usd: number;
  byAgent: TenantAgentBreakdown[];
};

export type TenantCostTotals = {
  tenants: number;
  runs: number;
  tokens: number;
  llm_usd: number;
  infra_monthly_usd: number;
  infra_window_usd: number;
  total_window_usd: number;
};

export function estimateInfraMonthly(counts: InfraCounts): number {
  return counts.render * RENDER_STARTER_USD_MO + counts.neon * NEON_USD_MO;
}

export function prorateToWindow(monthlyUsd: number, days: number): number {
  return monthlyUsd * (days / 30);
}

type Labels = Map<string, { slug: string; display_name: string }>;

export function aggregateTenantCosts(
  runs: TenantCostRunInput[],
  infraByTenant: Map<string, InfraCounts>,
  labels: Labels,
  days: number,
): { rows: TenantCostRow[]; totals: TenantCostTotals } {
  const perTenant = new Map<string, Map<string, TenantAgentBreakdown>>();
  for (const r of runs) {
    const agents = perTenant.get(r.tenant_id) ?? new Map<string, TenantAgentBreakdown>();
    const cur = agents.get(r.agent_slug) ?? {
      agent_slug: r.agent_slug,
      runs: 0,
      tokens: 0,
      usd: 0,
    };
    cur.runs += 1;
    cur.tokens += r.cost_tokens ?? 0;
    cur.usd += r.cost_usd ?? 0;
    agents.set(r.agent_slug, cur);
    perTenant.set(r.tenant_id, agents);
  }

  const tenantIds = new Set<string>([...perTenant.keys(), ...infraByTenant.keys()]);

  const rows: TenantCostRow[] = [];
  for (const tid of tenantIds) {
    const agents = perTenant.get(tid);
    const byAgent = agents
      ? Array.from(agents.values()).sort((a, b) => b.usd - a.usd)
      : [];
    const runsN = byAgent.reduce((s, a) => s + a.runs, 0);
    const tokens = byAgent.reduce((s, a) => s + a.tokens, 0);
    const llm_usd = byAgent.reduce((s, a) => s + a.usd, 0);

    const counts = infraByTenant.get(tid) ?? { render: 0, neon: 0 };
    const infra_monthly_usd = estimateInfraMonthly(counts);
    const infra_window_usd = prorateToWindow(infra_monthly_usd, days);

    const label = labels.get(tid);
    rows.push({
      tenant_id: tid,
      slug: label?.slug ?? "(unknown)",
      display_name: label?.display_name ?? label?.slug ?? tid.slice(0, 8),
      runs: runsN,
      tokens,
      llm_usd,
      render_count: counts.render,
      neon_count: counts.neon,
      infra_monthly_usd,
      infra_window_usd,
      total_window_usd: llm_usd + infra_window_usd,
      byAgent,
    });
  }

  rows.sort((a, b) => b.total_window_usd - a.total_window_usd);

  const totals = rows.reduce<TenantCostTotals>(
    (acc, r) => ({
      tenants: acc.tenants + 1,
      runs: acc.runs + r.runs,
      tokens: acc.tokens + r.tokens,
      llm_usd: acc.llm_usd + r.llm_usd,
      infra_monthly_usd: acc.infra_monthly_usd + r.infra_monthly_usd,
      infra_window_usd: acc.infra_window_usd + r.infra_window_usd,
      total_window_usd: acc.total_window_usd + r.total_window_usd,
    }),
    {
      tenants: 0,
      runs: 0,
      tokens: 0,
      llm_usd: 0,
      infra_monthly_usd: 0,
      infra_window_usd: 0,
      total_window_usd: 0,
    },
  );

  return { rows, totals };
}

export async function staffTenantCosts(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: runs, error: runsErr } = await serviceClient()
    .from("agent_runs")
    .select("tenant_id, agent_slug, cost_tokens, cost_usd")
    .gte("enqueued_at", since)
    .limit(50000);
  if (runsErr) {
    res
      .status(500)
      .json({ error: { code: "tenant_costs_query_failed", message: runsErr.message } });
    return;
  }

  const infraByTenant = new Map<string, InfraCounts>();
  const { data: resources } = await serviceClient()
    .from("tenant_resources")
    .select("tenant_id, resource_kind, provider, status")
    .eq("status", "ready")
    .in("resource_kind", ["hosting", "db"]);
  for (const row of (resources ?? []) as Array<{
    tenant_id: string;
    resource_kind: string;
    provider: string | null;
  }>) {
    const c = infraByTenant.get(row.tenant_id) ?? { render: 0, neon: 0 };
    if (row.resource_kind === "hosting" && row.provider === "render") c.render += 1;
    if (row.resource_kind === "db" && row.provider === "neon") c.neon += 1;
    infraByTenant.set(row.tenant_id, c);
  }

  const tenantIds = Array.from(
    new Set<string>([
      ...((runs ?? []) as TenantCostRunInput[]).map((r) => r.tenant_id),
      ...infraByTenant.keys(),
    ]),
  );
  const labels: Labels = new Map();
  if (tenantIds.length > 0) {
    const { data: tens } = await serviceClient()
      .from("tenants")
      .select("id, slug, display_name")
      .in("id", tenantIds);
    for (const t of (tens ?? []) as Array<{
      id: string;
      slug: string;
      display_name: string | null;
    }>) {
      labels.set(t.id, { slug: t.slug, display_name: t.display_name ?? t.slug });
    }
  }

  const { rows, totals } = aggregateTenantCosts(
    (runs ?? []) as TenantCostRunInput[],
    infraByTenant,
    labels,
    days,
  );

  res.json({
    days,
    generated_at: new Date().toISOString(),
    pricing: { render_starter_usd_mo: RENDER_STARTER_USD_MO, neon_usd_mo: NEON_USD_MO },
    totals,
    tenants: rows,
  });
}
