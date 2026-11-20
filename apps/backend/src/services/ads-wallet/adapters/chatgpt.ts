import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { ownedCampaign } from "@/services/connectors/chatgpt-ads/workspace";
import { chatgptAdsGet, chatgptAdsPost } from "@/services/connectors/chatgpt-ads/http";
import { fundingEnabled, readWallet } from "../wallet";
import { findCampaignBinding, getCampaignBinding } from "../bindings";
import { scopedCampaignBinding } from "../campaign-context";
async function checked<T>(promise: PromiseLike<{ data: T; error: unknown }>): Promise<T> { const r = await promise; if (r.error) throw new Error("Ads wallet storage is unavailable"); return r.data; }
function configured() { if (!fundingEnabled()) throw new ExpectedToolError("ads_funding_unavailable", "Ads funding is not configured yet. Your balance has not changed."); }
export async function lifetimeSpend(tenantId: string, campaignId: string, bindingId?: string) {
  const { key, campaign, binding } = await ownedCampaign(tenantId, campaignId, bindingId);
  const end = Math.floor(Date.now() / 3600_000) * 3600;
  const created = Number(campaign.created_at);
  if (!Number.isFinite(created) || created <= 0 || created < end - 5 * 365 * 86400 + 86400) throw new Error("Campaign lifetime spend is outside the supported reporting window");
  const start = created - 2 * 86400;
  const r = await chatgptAdsGet<{ data: Array<{ campaign_id?: string; spend?: number }>; has_more?: boolean }>(key, `/campaigns/${encodeURIComponent(campaignId)}/insights`, { aggregation_level: "campaign", time_granularity: "none", time_ranges: [JSON.stringify({ type: "unix_range", start: Math.floor(start / 3600) * 3600, end })], fields: ["campaign.id", "campaign.spend"], includes: ["zero_impression_items"] });
  if (r.has_more || !Array.isArray(r.data) || r.data.length !== 1 || (r.data[0].campaign_id != null && r.data[0].campaign_id !== campaignId) || typeof r.data[0].spend !== "number" || !Number.isFinite(r.data[0].spend) || r.data[0].spend < 0) throw new Error("Campaign lifetime spend could not be confirmed");
  return { cents: Math.ceil(r.data[0].spend * 100), key, campaign, binding };
}

type FundingAmount = number | { daily_micros: number; start: number; end: number };
export async function reserveCampaign(tenantId: string, campaignId: string, lifetimeMicros: FundingAmount, bindingId?: string) {
  const owned=await ownedCampaign(tenantId,campaignId,bindingId);
  if (owned.binding?.funding_source === "provider") return;
  const account = await chatgptAdsGet<{ currency_code: string }>(owned.key, "/ad_account");
  if (account.currency_code !== "USD") throw new ExpectedToolError("ads_currency_unsupported", "Campaign funding and the monthly budget currently support USD accounts only.");
  configured();
  const { cents, key, binding } = await lifetimeSpend(tenantId, campaignId, bindingId);
  const r = typeof lifetimeMicros === "number"
    ? await tenantRpc(asTenantId(tenantId), "ads_wallet_reserve_bound", { p_tenant_id: tenantId, p_campaign_binding_id: binding.id, p_lifetime_cents: Math.ceil(lifetimeMicros / 10000), p_observed_spend_cents: cents })
    : await tenantRpc(asTenantId(tenantId), "ads_wallet_reserve_chatgpt_daily_bound", { p_tenant_id: tenantId, p_campaign_binding_id: binding.id, p_daily_micros: lifetimeMicros.daily_micros, p_start: lifetimeMicros.start, p_end: lifetimeMicros.end, p_observed_spend_cents: cents });
  if (r.error) {
    if (r.error.code === "P0001" && r.error.message === "ads_balance_insufficient") throw new ExpectedToolError("ads_balance_insufficient", "Available ads balance must cover the campaign’s reserved campaign budget. Daily campaigns reserve conservative coverage for the full schedule. Add balance or reduce the campaign budget or duration.");
    throw new ExpectedToolError("ads_reservation_unavailable", "The campaign budget could not be reserved. No activation was sent. Try again when storage is available.");
  }
}

const FINAL_RELEASE_GRACE_MS = 48 * 3600_000;

const graceOver = (seconds: unknown): boolean =>
  typeof seconds === "number" && Number.isFinite(seconds) && seconds * 1000 + FINAL_RELEASE_GRACE_MS <= Date.now();

const terminallyOver = (campaign: { status?: unknown; end_time?: unknown; updated_at?: unknown }): boolean =>
  (campaign.status === "archived" && graceOver(campaign.updated_at)) || graceOver(campaign.end_time);

async function pauseForWallet(tenantId: string, campaignId: string, key: string, campaign: Awaited<ReturnType<typeof ownedCampaign>>["campaign"]) {
  const result = await chatgptAdsPost<{ id?: string; status?: string }>(key, `/campaigns/${encodeURIComponent(campaignId)}`, { status: "paused" });
  if (result.id !== campaignId || result.status !== "paused") throw new ExpectedToolError("chatgpt_ads_bad_response", "The wallet safety pause could not be confirmed.");
  const { recordAdObjectChanges } = await import("@/services/decisions/ad-changes");
  await recordAdObjectChanges(tenantId, [{ platform: "chatgpt", object_id: campaignId, campaign_id: campaignId, level: "campaign", object_name: campaign.name ?? null,
    source: "zavi", action_table: null, action_id: null, change_kind: "status", before_status: "ACTIVE", after_status: "PAUSED",
    before_daily_usd: campaign.budget?.daily_spend_limit_micros == null ? null : campaign.budget.daily_spend_limit_micros / 1e6,
    after_daily_usd: campaign.budget?.daily_spend_limit_micros == null ? null : campaign.budget.daily_spend_limit_micros / 1e6,
  }]).catch((e: Error) => console.warn(`[chatgpt-wallet] pause provenance could not be saved: ${e.message}`));
}

export async function settleCampaign(tenantId: string, campaignId: string, bindingId?: string) {
  let observation: Awaited<ReturnType<typeof lifetimeSpend>>;
  try { observation = await lifetimeSpend(tenantId, campaignId, bindingId); }
  catch (reportError) {
    const w = await readWallet(tenantId);
    if (w.available_cents < 0) {
      const { key, campaign } = await ownedCampaign(tenantId, campaignId, bindingId);
      if (campaign.status === "active") await pauseForWallet(tenantId, campaignId, key, campaign);
    }
    throw reportError;
  }
  const { cents, key, campaign, binding } = observation;
  if (terminallyOver(campaign)) {
    await checked(tenantRpc(asTenantId(tenantId), "ads_wallet_finalize_bound", { p_tenant_id: tenantId, p_campaign_binding_id: binding.id, p_final_spend_cents: cents }));
    return;
  }
  await checked(tenantRpc(asTenantId(tenantId), "ads_wallet_settle_bound", { p_tenant_id: tenantId, p_campaign_binding_id: binding.id, p_spend_cents: cents }));
  if (campaign.status === "active") {
    const f = await checked(tenantClient(asTenantId(tenantId)).from("ads_campaign_reservations").select("reserved_cents").eq("tenant_id", tenantId).eq("campaign_binding_id", binding.id).maybeSingle()) as { reserved_cents?: number } | null;
    if (f && Number(f.reserved_cents) === 0) {
      const { fundingArgument } = await import("@/services/connectors/chatgpt-ads/workspace");
      try { await reserveCampaign(tenantId, campaignId, fundingArgument(campaign), binding.id); }
      catch (e) {
        await pauseForWallet(tenantId, campaignId, key, campaign);
        throw e;
      }
    }
  }
  const w = await readWallet(tenantId);
  if (w.available_cents < 0 && campaign.status === "active") await pauseForWallet(tenantId, campaignId, key, campaign);
}

export async function reserveIfFunded(tenantId: string, campaignId: string, amount: FundingAmount) {
  const scoped=scopedCampaignBinding(tenantId,"chatgpt",campaignId);
  const binding = scoped?await getCampaignBinding(tenantId,scoped):await findCampaignBinding(tenantId, "chatgpt", campaignId);
  if (!binding) return;
  if(binding.funding_source==="provider")return;
  const r = await tenantClient(asTenantId(tenantId)).from("ads_campaign_reservations").select("campaign_id").eq("tenant_id", tenantId).eq("campaign_binding_id", binding.id).maybeSingle();
  if (r.error) throw new ExpectedToolError("ads_reservation_unavailable", "Existing campaign coverage could not be checked. No budget change was sent.");
  if (r.data) await reserveCampaign(tenantId, campaignId, amount, binding.id);
}
