
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { resolveDailyCapUsd, utcDay } from "@/services/agents/budget";

export type CostRunInput = {
  tenant_id: string;
  agent_slug: string;
  cost_tokens: number | null;
  cost_usd: number | null;
  status: string;
};

type CostRollupEntry = {
  tenant_id: string;
  agent_slug: string;
  runs: number;
  tokens: number;
  usd: number;
};
type CostTotals = { runs: number; tokens: number; usd: number };

export type TenantCapStatus = {
  tenant_id: string;
  daily_cap_usd: number;
  today_usd: number;
  pct: number;
  flag: "ok" | "amber" | "red";
};

export function classifyCapStatus(
  tenant_id: string,
  daily_cap_usd: number,
  today_usd: number,
): TenantCapStatus {
  if (!(daily_cap_usd > 0)) {
    return { tenant_id, daily_cap_usd: 0, today_usd, pct: 0, flag: "ok" };
  }
  const pct = today_usd / daily_cap_usd;
  const flag: TenantCapStatus["flag"] =
    pct >= 1 ? "red" : pct >= 0.8 ? "amber" : "ok";
  return { tenant_id, daily_cap_usd, today_usd, pct, flag };
}

export function aggregateCosts(rows: CostRunInput[]): {
  rollup: CostRollupEntry[];
  totals: CostTotals;
} {
  const map = new Map<string, CostRollupEntry>();
  for (const r of rows) {
    const k = `${r.tenant_id}::${r.agent_slug}`;
    const cur = map.get(k) ?? {
      tenant_id: r.tenant_id,
      agent_slug: r.agent_slug,
      runs: 0,
      tokens: 0,
      usd: 0,
    };
    cur.runs += 1;
    cur.tokens += r.cost_tokens ?? 0;
    cur.usd += r.cost_usd ?? 0;
    map.set(k, cur);
  }
  const rollup = Array.from(map.values()).sort((a, b) => b.usd - a.usd);
  const totals = rollup.reduce<CostTotals>(
    (acc, r) => ({
      runs: acc.runs + r.runs,
      tokens: acc.tokens + r.tokens,
      usd: acc.usd + r.usd,
    }),
    { runs: 0, tokens: 0, usd: 0 },
  );
  return { rollup, totals };
}

export async function staffCosts(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 7)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("tenant_id, agent_slug, cost_tokens, cost_usd, status")
    .gte("enqueued_at", since)
    .limit(10000);
  if (error) {
    res.status(500).json({ error: { code: "costs_query_failed", message: error.message } });
    return;
  }

  const { rollup, totals } = aggregateCosts((data ?? []) as CostRunInput[]);

  const tenantIds = Array.from(new Set(rollup.map((r) => r.tenant_id)));
  const capStatuses: TenantCapStatus[] = [];
  if (tenantIds.length > 0) {
    const today = utcDay();
    const { data: counters } = await serviceClient()
      .from("tenant_budget_counters")
      .select("tenant_id, spend_estimate")
      .eq("day", today)
      .in("tenant_id", tenantIds);
    const todayByTenant = new Map<string, number>(
      ((counters ?? []) as Array<{ tenant_id: string; spend_estimate: number | null }>).map(
        (c) => [c.tenant_id, Number(c.spend_estimate ?? 0)],
      ),
    );
    for (const tid of tenantIds) {
      const cap = await resolveDailyCapUsd(tid);
      capStatuses.push(classifyCapStatus(tid, cap, todayByTenant.get(tid) ?? 0));
    }
  }

  res.json({ days, totals, rollup, capStatuses });
}
