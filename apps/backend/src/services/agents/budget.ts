
import { serviceClient } from "@/services/supabase";
import { getAppSetting } from "@/services/settings";
import type { AgentCostClass } from "@/services/agents/types";

const COST_ESTIMATE_USD: Record<AgentCostClass, number> = {
  cheap: 0.02,
  standard: 0.1,
  expensive: 0.8,
};

export function estimateRunCost(costClass: AgentCostClass): number {
  return COST_ESTIMATE_USD[costClass] ?? COST_ESTIMATE_USD.standard;
}

export function shouldAbortForBudget(
  accruedUsd: number,
  headroomUsd: number,
  marginUsd: number,
  reservationUsd = 0,
): boolean {
  if (!Number.isFinite(headroomUsd)) return false;
  const threshold = Math.max(reservationUsd, headroomUsd - marginUsd);
  return accruedUsd >= threshold;
}

export function resolveEnvDailyCapUsd(): number {
  const raw = process.env.PRAXIS_DAILY_BUDGET_USD;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function resolveGlobalDefaultCapUsd(): Promise<number> {
  const fromSetting = await getAppSetting("daily_budget_usd");
  if (fromSetting !== undefined) {
    const n = Number(fromSetting);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return resolveEnvDailyCapUsd();
}

export async function resolveDailyCapUsd(tenantId?: string): Promise<number> {
  const envCap = await resolveGlobalDefaultCapUsd();
  if (!tenantId) return envCap;
  try {
    const { data, error } = await serviceClient()
      .from("tenant_budget_override")
      .select("daily_cap_usd")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) {
      console.warn(
        `[budget] tenant_budget_override lookup failed (tenant=${tenantId}): ${error.message} — falling back to env cap $${envCap}`,
      );
      return envCap;
    }
    if (data && data.daily_cap_usd != null) {
      const n = Number(data.daily_cap_usd);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return envCap;
  } catch (e) {
    console.warn(
      `[budget] tenant_budget_override resolver threw (tenant=${tenantId}): ${(e as Error).message} — falling back to env cap $${envCap}`,
    );
    return envCap;
  }
}

export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export type ConsumeBudgetInput = {
  tenant_id: string;
  estimate: number;
  dailyCap: number;
  day?: string;
};

export async function consumeBudgetOrReject(
  input: ConsumeBudgetInput,
): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("consume_budget_or_reject", {
    p_tenant_id: input.tenant_id,
    p_day: input.day ?? utcDay(),
    p_estimate: input.estimate,
    p_daily_cap: input.dailyCap,
  });
  if (error) {
    throw new Error(`consume_budget_or_reject failed: ${error.message}`);
  }
  return data === true;
}

export async function releaseBudgetReservation(input: { tenant_id: string; estimate: number; day: string }): Promise<boolean> {
  try {
    const { data, error } = await serviceClient().rpc("release_budget_reservation", {
      p_tenant_id: input.tenant_id,
      p_day: input.day,
      p_estimate: input.estimate,
    });
    if (error) throw new Error(error.message);
    return data === true;
  } catch (e) {
    console.warn(`[budget] release_budget_reservation failed (tenant=${input.tenant_id} day=${input.day}): ${(e as Error).message}`);
    return false;
  }
}
