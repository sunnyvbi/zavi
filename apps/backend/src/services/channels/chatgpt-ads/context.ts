import { resourceOptions } from "@/services/connectors/chatgpt-ads/resources";
import { servingReady } from "@/services/connectors/chatgpt-ads/serving";
import { chatgptAdsGet } from "@/services/connectors/chatgpt-ads/http";
import { CHATGPT_MIN_DAILY_USD } from "@/services/connectors/chatgpt-ads/campaign-settings";
import { getChatgptAdsApiKey } from "@/services/connectors/chatgpt-ads/key-provider";
import { fundingEnabled } from "./wallet";
import { readChatgptFundingContext } from "./funding-context";

function host(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

export function accountReadiness(account: Record<string, any>, website: string | null = process.env.CHATGPT_ADS_ADVERTISER_WEBSITE ?? null) {
  const advertiserHost = host(website);
  const accountHost = host(account.url);
  return {
    access: "verified",
    status: typeof account.status === "string" ? account.status : "unverified",
    brand_review: typeof account.review?.status === "string" ? account.review.status : "unverified",
    advertiser_website_matches: advertiserHost && accountHost ? advertiserHost === accountHost : null,
    currency: typeof account.currency_code === "string" ? account.currency_code : null,
    launch_approval: servingReady(account) ? "approved" : "requires_operator_review",
  };
}

export async function chatgptAdsRunContext(tenantId: string) {
  let account: Record<string, unknown> = { access: "unverified" };
  try {
    const key = await getChatgptAdsApiKey();
    account = accountReadiness(await chatgptAdsGet<Record<string, unknown>>(key, "/ad_account"));
  } catch {
    account = { access: "unverified", next_check: "Zavi must verify shared advertiser access, brand and website review before activation." };
  }
  let resources: unknown = { status: "unverified", responsibility: "zavi" };
  try { resources = await resourceOptions(tenantId); } catch {  }
  return {
    resources,
    operating_model: "zavi_managed_api",
    advertiser: "zavi_shared_account",
    account,
    funding: { enabled: fundingEnabled(), wallet: await readChatgptFundingContext(tenantId), auto_refill: "optional_explicit_consent" },
    growth_control: { mode: "approval_rail", monthly_growth_budget_covers_this_channel: true, paid_delegation: await (await import("@/services/growth/channel-autorun")).readChannelAutorunView(tenantId, "chatgpt-context").then((v) => v.resolve("chatgpt_ads").display).catch(() => null), automatic_activation_requires: ["explicit_paid_delegation", "global_autopilot", "active_growth_budget", "campaign_wallet_coverage", "serving_readiness"], wallet_refill_consent: "separate" },
    controls: { create_campaign: "paused", budget: ["lifetime", "daily_with_end_date"], bidding: ["clicks", "impressions", "conversions"], conversion_setup: "requires_verified_workspace_event", daily_minimum_usd: CHATGPT_MIN_DAILY_USD, daily_max_duration_days: 90 },
  };
}
