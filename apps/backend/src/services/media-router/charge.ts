import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { isFlatJobPricingOn } from "@/services/billing/flat-pricing";
import { billedMediaUsdFor, priceForMedia } from "@/services/billing/job-prices";
import type { MediaTask } from "./types";

export type ChargeOutcome = "charged" | "already" | "not_enforced" | "zero" | "error";
export type PendingCharge = { tenant_id: string; run_id: string | null; key: string; cost_usd: number; task: MediaTask; model: string };

export type AffordCheck = "ok" | "short" | "unknown";

export async function checkAffordMedia(tenant_id: string, cost_usd: number): Promise<AffordCheck> {
  if (!(cost_usd > 0)) return "ok";
  try {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "media_credits_affordable", { p_cost_usd: cost_usd });
    if (error) throw new Error(error.message);
    return data === true ? "ok" : data === false ? "short" : "unknown";
  } catch (e) {
    console.error(`[media-router] affordability check failed (fail closed): ${(e as Error).message}`);
    return "unknown";
  }
}

export async function canAffordMedia(tenant_id: string, cost_usd: number): Promise<boolean> {
  return (await checkAffordMedia(tenant_id, cost_usd)) === "ok";
}

export async function billedMediaUsd(task: string, vendorUsd: number): Promise<number> {
  if (!(vendorUsd > 0) || !priceForMedia(task)) return vendorUsd;
  return billedMediaUsdFor(task, vendorUsd, await isFlatJobPricingOn());
}

export async function chargeMedia(a: PendingCharge): Promise<ChargeOutcome> {
  if (!(a.cost_usd > 0)) return "zero";
  a = { ...a, cost_usd: await billedMediaUsd(a.task, a.cost_usd) };
  try {
    const { data, error } = await tenantRpc(asTenantId(a.tenant_id), "charge_media_credits", {
      p_media_key: a.key,
      p_cost_usd: a.cost_usd,
      p_task: a.task,
      p_model: a.model,
      p_run_id: a.run_id,
    });
    if (error) throw new Error(error.message);
    return (data as ChargeOutcome) ?? "error";
  } catch (e) {
    void logEvent({ level: "error", source: "media-router.charge", code: "media_charge_failed", error: e, tenant_id: a.tenant_id, run_id: a.run_id ?? undefined });
    console.error(`[media-router] charge failed key=${a.key} cost=${a.cost_usd}: ${(e as Error).message}`);
    return "error";
  }
}

export async function mediaChargeRecorded(tenant_id: string, key: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_credit_ledger")
    .select("id")
    .eq("kind", "media")
    .eq("media_key", key)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

function isMissingFunction(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && (e.code === "PGRST202" || e.code === "42883" || /could not find the function|does not exist/i.test(e.message ?? ""));
}

export async function flushCharges(pending: PendingCharge[]): Promise<void> {
  const groups = new Map<string, PendingCharge[]>();
  for (const raw of pending) {
    if (!(raw.cost_usd > 0)) continue;
    const p = { ...raw, cost_usd: await billedMediaUsd(raw.task, raw.cost_usd) };
    const g = `${p.tenant_id}|${p.run_id ?? ""}`;
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  let failed = 0;
  for (const items of groups.values()) {
    if (items.length === 1 || items.length > 200) {
      for (const p of items) if ((await chargeMedia(p)) === "error") failed++;
      continue;
    }
    const { tenant_id, run_id } = items[0];
    try {
      const { error } = await tenantRpc(asTenantId(tenant_id), "charge_media_credits_batch", {
        p_run_id: run_id,
        p_items: items.map((p) => ({ key: p.key, cost_usd: p.cost_usd, task: p.task, model: p.model })),
      });
      if (error) throw new Error(isMissingFunction(error) ? `charge_media_credits_batch not deployed: ${error.message}` : error.message);
    } catch (e) {
      void logEvent({ level: "error", source: "media-router.charge", code: "media_charge_failed", error: e, tenant_id, run_id: run_id ?? undefined });
      console.error(`[media-router] batch charge failed (${items.length} items): ${(e as Error).message}`);
      failed += items.length;
    }
  }
  if (failed > 0) throw new Error(`media charge failed for ${failed} of ${pending.length} item(s); retry`);
}
