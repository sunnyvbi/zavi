import { settleBoundCampaign } from "@/services/ads-wallet/providers";
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { ensureRefillEntitlement, refillWallet } from "@/services/ads-wallet/wallet";
import { logEvent } from "@/services/logging/logEvent";
import { alertMoneyJobErrors } from "./_money-job-alert";

export const ADS_WALLET_BATCH_SIZE = 25;
export const ADS_WALLET_EVENTS_PER_STEP = 500;
export const chatgptAdsWalletFn = inngest.createFunction(
  { id: "chatgpt-ads-wallet", concurrency: { limit: 1 }, retries: 2 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const { tenants, slot } = await step.run("wallets", async () => {
      const rows: Array<{ tenant_id: string }> = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await serviceClient().from("ads_wallets").select("tenant_id").order("tenant_id").range(offset, offset + 499);
        if (error) throw new Error("Could not read ads wallets");
        rows.push(...data ?? []);
        if (!data || data.length < 500) return { tenants: rows, slot: Math.floor(Date.now() / 300_000) };
      }
    });
    const batches: Array<{ id: string; name: "ads-wallet/tick.batch"; data: { tenant_ids: string[] } }> = [];
    for (let i = 0; i < tenants.length; i += ADS_WALLET_BATCH_SIZE)
      batches.push({ id: `ads-wallet-tick:${slot}:${i / ADS_WALLET_BATCH_SIZE}`, name: "ads-wallet/tick.batch", data: { tenant_ids: tenants.slice(i, i + ADS_WALLET_BATCH_SIZE).map(t => t.tenant_id) } });
    for (let i = 0; i < batches.length; i += ADS_WALLET_EVENTS_PER_STEP)
      await step.sendEvent(`fan-out-${i / ADS_WALLET_EVENTS_PER_STEP}`, batches.slice(i, i + ADS_WALLET_EVENTS_PER_STEP));
    return { wallets: tenants.length, batches: batches.length };
  },
);

const failureCode = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && code) return code;
  return (e instanceof Error ? e.message : String(e)).slice(0, 120) || "unknown";
};

export const adsWalletBatchFn = inngest.createFunction(
  { id: "ads-wallet-batch", concurrency: { limit: 1 }, retries: 2 },
  { event: "ads-wallet/tick.batch" },
  async ({ event, step }) => {
    const tenants = Array.isArray(event.data?.tenant_ids) ? event.data.tenant_ids.filter((t): t is string => typeof t === "string") : [];
    const failed: string[] = [];
    for (const tenant_id of tenants) {
      const problems: string[] = [];
      try {
        const campaigns = await step.run(`settle-${tenant_id}`, async () => {
          const out: Array<{ campaign: string; code: string }> = [];
          for (let offset = 0; ; offset += 500) {
            const { data, error } = await serviceClient().from("ads_campaign_reservations")
              .select("campaign_binding_id").eq("tenant_id", tenant_id).order("campaign_binding_id").range(offset, offset + 499);
            if (error || !Array.isArray(data)) throw new Error("Could not read campaign funding");
            for (const c of data) {
              try { await settleBoundCampaign(tenant_id, c.campaign_binding_id); }
              catch (e) { out.push({ campaign: c.campaign_binding_id, code: failureCode(e) }); }
            }
            if (data.length < 500) break;
          }
          return out;
        });
        for (const c of campaigns) problems.push(`campaign ${c.campaign} settlement: ${c.code}`);
      } catch (e) {
        problems.push(`settlement: ${failureCode(e)}`);
      }
      const settled = problems.length === 0;
      try {
        const refillAllowed = await step.run(`entitlement-${tenant_id}`, () => ensureRefillEntitlement(tenant_id));
        if (refillAllowed) await step.run(`refill-${tenant_id}`, () => refillWallet(tenant_id));
      } catch (e) {
        problems.push(`refill: ${failureCode(e)}`);
      }
      if (problems.length) {
        failed.push(`${tenant_id} (${problems.slice(0, 3).join("; ")}${problems.length > 3 ? `; +${problems.length - 3} more` : ""})`);
        await logEvent({level:"error",source:"ads-wallet",code:"ads_wallet.reconciliation_failed",tenant_id,message:!settled?"Campaign settlement could not be reconciled. Existing coverage is retained.":"Wallet entitlement or refill could not be completed."}).catch(()=>undefined);
      }
    }
    if (failed.length) await step.run("alert", () => alertMoneyJobErrors("chatgpt-ads-wallet", failed, tenants.length));
    if(failed.length)throw new Error(`${failed.length} ads wallets need reconciliation`);
    return { wallets: tenants.length, failed_wallets: failed };
  },
);
