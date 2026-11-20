
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";

export type AddSideCostResult = "added" | "already" | "zero" | "run_finished" | "no_run";

export type AddRunSideCostInput = {
  tenantId: string;
  runId: string;
  usd: number;
  source: string;
  key: string;
};

export async function addRunSideCost(input: AddRunSideCostInput): Promise<AddSideCostResult> {
  const { tenantId, runId, usd, source, key } = input;
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`addRunSideCost: usd must be a finite non-negative number (got ${usd})`);
  }
  if (usd === 0) return "zero";
  const { data, error } = await tenantRpc(asTenantId(tenantId), "add_run_side_cost", {
    p_run_id: runId,
    p_cost_key: key,
    p_usd: usd,
    p_source: source,
  });
  if (error) throw new Error(`addRunSideCost: ${error.message}`);
  const res = data as AddSideCostResult;
  if (res === "run_finished" || res === "no_run") {
    void logEvent({
      level: "error",
      source: "billing.run_side_cost",
      code: `side_cost_${res}`,
      meta: { run_id_ref: runId, source, usd },
    });
  }
  return res;
}

export async function sumRunSideCostsUsd(tenantId: string, runId: string): Promise<number> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("agent_run_side_costs")
    .select("usd")
    .eq("run_id", runId);
  if (error) throw new Error(`sumRunSideCostsUsd: ${error.message}`);
  let total = 0;
  for (const row of (data ?? []) as Array<{ usd: number | string | null }>) {
    const v = Number(row.usd);
    if (Number.isFinite(v) && v > 0) total += v;
  }
  return total;
}
