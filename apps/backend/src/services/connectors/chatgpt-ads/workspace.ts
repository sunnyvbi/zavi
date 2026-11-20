import { bindCampaign, claimCampaignAccount, findCampaignBinding, getAccountBinding, getCampaignBinding, legacyChatgptAccount } from "@/services/ads-wallet/bindings";
import { resolveChatgptAccount } from "./account-binding";
import { scopedCampaignBinding } from "@/services/ads-wallet/campaign-context";
import { assertAccountAvailableForNewCampaign } from "@/services/ads-wallet/accounts";
import { withWorkspaceGrowthBudget } from "./growth-workspace-budget";
import { assertServingReady } from "./serving";
import { createHash } from "node:crypto";
import { stableCreativeUpload } from "./creative-upload";
import { signOwnImageForVendor } from "@/services/chat-images/sign-own-image";
import { signGeneratedAdImage } from "./generated-image";
import { z } from "zod";
import { AD_IMAGE_PATH_RE, type ChatgptAdEntity, type ChatgptCampaign, type ChatgptAdsMetrics } from "@zavi/shared";
import { ExpectedToolError } from "@/services/tools/types";
import { chatgptAdsGet, chatgptAdsPost, type ChatgptAdsQuery } from "./http";
import { getChatgptAdsApiKey } from "./key-provider";
import { normalizeCampaignName, ownsCampaignName, resolveTenantCampaignPrefix } from "./tenant-scope";
import { campaignBudget, listChatgptAdsCampaigns } from "./client";
import { purchaseWindow } from "./purchases";
import { scheduleFields, checkResources, validateSchedule, fundingLimit, resourceId, CHATGPT_MIN_DAILY_MICROS } from "./campaign-settings";
export { CHATGPT_MIN_DAILY_USD, CHATGPT_MIN_DAILY_MICROS } from "./campaign-settings";

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const name = z.string().trim().min(3).max(800).refine(v => !v.includes("--") && !v.startsWith("-"), "Use a name without double hyphens.");
export const campaignChange = z.object({
  name: name.optional(), status: z.enum(["active", "paused", "archived"]).optional(),
  lifetime_budget_micros: z.number().int().min(1_000_000).max(1_000_000_000_000).optional(),
  daily_budget_micros: z.number().int().min(CHATGPT_MIN_DAILY_MICROS).max(1_000_000_000_000).optional(),
  ...scheduleFields,
  expected_updated_at: z.number().int().optional(),
}).strict().refine(v => Object.keys(v).some(k => k !== "expected_updated_at"), "No changes supplied.");
export const campaignCreate = z.object({
  name, lifetime_budget_micros: z.number().int().min(1_000_000).max(1_000_000_000_000).optional(),
  daily_budget_micros: z.number().int().min(CHATGPT_MIN_DAILY_MICROS).max(1_000_000_000_000).optional(),
  bidding_type: z.enum(["impressions", "clicks", "conversions"]),
  conversion_event_setting_ids: z.array(resourceId).length(1).optional(),
  mode: z.literal("product_feed").optional(), product_feed_id: resourceId.optional(),
  ...scheduleFields,
}).strict().refine(v => (v.lifetime_budget_micros != null) !== (v.daily_budget_micros != null), "Choose one budget type.")
.refine(v => (v.bidding_type === "conversions") === !!v.conversion_event_setting_ids?.length, "Select one conversion event for conversion campaigns.")
.refine(v => (v.mode === "product_feed") === !!v.product_feed_id, "Select a feed for a product campaign.");
export type CampaignChange = z.infer<typeof campaignChange>;

export function createKey(tenantId: string, operation: string, requestId: string) {
  z.string().uuid().parse(requestId);
  return createHash("sha256").update(JSON.stringify([tenantId, operation, requestId])).digest("hex");
}

type Row = Record<string, any>;
const bad = (code: string, message: string): never => { throw new ExpectedToolError(code, message); };

export async function ownedCampaign(tenantId: string, campaignId: string, bindingId?: string) {
  id.parse(campaignId);
  bindingId ??= scopedCampaignBinding(tenantId,"chatgpt",campaignId);
  const prefix = await resolveTenantCampaignPrefix(tenantId);
  let binding = bindingId ? await getCampaignBinding(tenantId, bindingId) : await findCampaignBinding(tenantId, "chatgpt", campaignId);
  if (binding && (binding.platform !== "chatgpt" || binding.provider_campaign_id !== campaignId)) bad("chatgpt_ads_not_found", "Campaign not found in this workspace.");
  const account = binding ? await getAccountBinding(tenantId, binding.account_binding_id) : await legacyChatgptAccount(tenantId);
  const { key, account:providerAccount } = await resolveChatgptAccount(tenantId, account);
  const campaign = await chatgptAdsGet<Row>(key, `/campaigns/${encodeURIComponent(campaignId)}`);
  if (campaign.id !== campaignId || (binding?.funding_source!=="provider" && !ownsCampaignName(campaign.name, prefix))) bad("chatgpt_ads_not_found", "Campaign not found in this workspace.");
  binding ??= await bindCampaign(tenantId, account, campaignId);
  return { prefix, key, campaign, binding, providerAccountId:providerAccount?.id??account.provider_account_id, providerCurrency:providerAccount?.currency_code??account.currency };
}

export function publicCampaign(row: Row): ChatgptCampaign {
  return { id: row.id, name: row.name, status: row.status ?? null, updated_at: row.updated_at, bidding_type: row.bidding_type, budget: campaignBudget(row.budget), start_time: row.start_time, end_time: row.end_time, created_at: row.created_at, targeting: row.targeting, conversion_event_setting_ids: row.conversion_event_setting_ids, mode: row.mode, product_feed_id: row.product_feed_id, landing_page_configuration: row.landing_page_configuration };
}

async function list(key: string, path: string, query: ChatgptAdsQuery): Promise<Row[]> {
  const rows: Row[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await chatgptAdsGet<{ data: Row[]; has_more?: boolean; last_id?: string }>(key, path, { ...query, limit: 500, after });
    if (!Array.isArray(r.data)) return bad("chatgpt_ads_bad_response", "The Ads API returned an unreadable list.");
    rows.push(...r.data);
    if (!r.has_more) return rows;
    if (!r.last_id || r.last_id === after) break;
    after = r.last_id;
  }
  return bad("chatgpt_ads_incomplete", "The Ads API list is incomplete. Narrow the campaign selection and refresh.");
}

function metrics(row: Row | undefined): ChatgptAdsMetrics {
  const result: ChatgptAdsMetrics = {};
  for (const k of ["impressions", "clicks", "spend", "ctr", "cpc", "cpm"] as const) {
    if (typeof row?.[k] === "number" && Number.isFinite(row[k])) result[k] = row[k];
  }
  return result;
}

export async function readCampaignEntities(tenantId: string, campaignId: string, level: "ad_group" | "ad", days: number): Promise<ChatgptAdEntity[]> {
  const { key, campaign, binding } = await ownedCampaign(tenantId, campaignId);
  const groups = (await list(key, "/ad_groups", { campaign_id: campaignId, include: ["serving_issues"] })).filter(g => g.campaign_id == null || g.campaign_id === campaignId);
  const items: Row[] = [];
  if (level === "ad_group") {
    for (const g of groups) items.push({ ...g, parent_name: campaign.name });
  } else {
    if (groups.length > 50) return bad("chatgpt_ads_incomplete", "This campaign has too many ad groups for one view.");
    for (let i = 0; i < groups.length; i += 5) {
      const batch = await Promise.all(groups.slice(i, i + 5).map(async g => {
        const ads = await list(key, "/ads", { ad_group_id: g.id, include: ["serving_issues"] });
        return ads.filter(a => (a.ad_group_id == null || a.ad_group_id === g.id) && (a.campaign_id == null || a.campaign_id === campaignId)).map(a => ({ ...a, ad_group_id: g.id, parent_name: g.name }));
      }));
      items.push(...batch.flat());
    }
  }
  let insightRows: Row[] = [];
  let metricsUnavailable = false;
  try {
  const account = await chatgptAdsGet<{ timezone: string }>(key, "/ad_account");
  const period = purchaseWindow(days, account.timezone);
  insightRows = await list(key, `/campaigns/${encodeURIComponent(campaignId)}/insights`, {
    aggregation_level: level, time_granularity: "none", time_ranges: [JSON.stringify({ type: "date_range", since: period.from, until: period.to, timezone: period.timezone })],
    fields: ["campaign.id", `${level}.id`, ...["impressions", "clicks", "spend", "ctr", "cpc", "cpm"].map(f => `${level}.${f}`)],
  });
  } catch { metricsUnavailable = true; }
  const byId = new Map(insightRows.filter(r => r.campaign_id == null || r.campaign_id === campaignId).map(r => [r[`${level}_id`], r]));
  return items.filter(r => typeof r.id === "string").map(r => ({
    id: r.id, name: typeof r.name === "string" ? r.name : "Unnamed", status: typeof r.status === "string" ? r.status : null,
    campaign_id: campaignId, ad_group_id: r.ad_group_id, parent_name: r.parent_name,
    metrics_unavailable: metricsUnavailable || undefined,
    landing_page_configuration: r.landing_page_configuration,
    serving_issues: Array.isArray(r.serving_issues) ? r.serving_issues.map((issue: Row) => issue?.code).filter((code: unknown) => typeof code === "string" && /^[a-z_]{1,100}$/.test(code)).map((code: string) => code.replaceAll("_", " ")) : undefined,
    review_status: typeof r.review_status === "string" ? r.review_status : undefined,
    bidding_config: r.bidding_config ? Object.fromEntries(["strategy", "billing_event_type", "max_bid_micros"].filter(k => r.bidding_config[k] != null).map(k => [k, r.bidding_config[k]])) : undefined,
    context_hints: Array.isArray(r.context_hints) ? r.context_hints.filter((h: unknown) => typeof h === "string") : undefined,
    creative: r.creative && typeof r.creative === "object" ? Object.fromEntries(["type", "title", "body", "target_url", "image_url", "file_id"].filter(k => typeof r.creative[k] === "string").map(k => [k, r.creative[k]])) : undefined,
    ...metrics(byId.get(r.id)),
  }));
}

export async function updateCampaign(tenantId: string, campaignId: string, input: CampaignChange): Promise<ChatgptCampaign> {
  const change = campaignChange.parse(input);
  const { prefix, key, campaign, binding, providerCurrency } = await ownedCampaign(tenantId, campaignId);
  if (campaign.status === "archived") return bad("chatgpt_ads_conflict", "Archived campaigns cannot be edited.");
  if (change.expected_updated_at !== undefined && campaign.updated_at !== change.expected_updated_at) return bad("chatgpt_ads_conflict", "This campaign changed. Refresh it before saving.");
  const body: Row = {};
  if (change.name !== undefined) body.name = binding.funding_source==="provider"?change.name:prefix + change.name;
  if (change.status !== undefined) body.status = change.status;
  if (change.lifetime_budget_micros !== undefined && change.daily_budget_micros !== undefined) return bad("chatgpt_ads_conflict", "Choose one budget type.");
  if (change.lifetime_budget_micros !== undefined) {
    if (campaign.budget?.daily_spend_limit_micros != null) return bad("chatgpt_ads_conflict", "Create a new campaign to change budget type.");
    body.budget = { ...campaign.budget, lifetime_spend_limit_micros: change.lifetime_budget_micros };
  }
  if (change.daily_budget_micros !== undefined) {
    if (campaign.budget?.daily_spend_limit_micros == null) return bad("chatgpt_ads_conflict", "Create a new campaign to change budget type.");
    body.budget = { ...campaign.budget, daily_spend_limit_micros: change.daily_budget_micros };
  }
  for (const field of ["start_time", "end_time", "targeting", "landing_page_configuration"] as const) if (change[field] !== undefined) body[field] = change[field];
  const next = { ...campaign, ...body };
  const stopping = change.status === "paused" || change.status === "archived";
  const financialEdit = body.budget || body.start_time !== undefined || body.end_time !== undefined;
  if (financialEdit || !stopping && next.status === "active") validateSchedule(next);
  await checkResources(tenantId, body, {key,accountId:binding.account_id});
  return withWorkspaceGrowthBudget(tenantId, campaign as any, next as any, "campaign", async () => {
  if (!stopping && next.status === "active") {
    await assertServingReady(key,binding.funding_source);
    await checkResources(tenantId, campaign, {key,accountId:binding.account_id});
    const { reserveCampaign } = await import("@/services/channels/chatgpt-ads/wallet");
    await reserveCampaign(tenantId, campaignId, fundingArgument(next));
  } else if (financialEdit) {
    const { reserveIfFunded } = await import("@/services/channels/chatgpt-ads/wallet");
    await reserveIfFunded(tenantId, campaignId, fundingArgument(next));
  }
  const updated = await chatgptAdsPost<Row>(key, `/campaigns/${encodeURIComponent(campaignId)}`, body);
  if (updated.id !== campaignId || (binding.funding_source !== "provider" && !ownsCampaignName(updated.name, prefix)) || (change.status !== undefined && updated.status !== change.status)) return bad("chatgpt_ads_bad_response", "The campaign update could not be verified. Refresh before trying again.");
  return publicCampaign(updated);
  },{binding,currency:providerCurrency??"USD"});
}

export async function createCampaign(tenantId: string, input: z.infer<typeof campaignCreate>, requestId: string): Promise<ChatgptCampaign> {
  const value = campaignCreate.parse(input);
  const idem = createKey(tenantId, "campaign", requestId);
  const prefix = await resolveTenantCampaignPrefix(tenantId);
  const account = await claimCampaignAccount(tenantId, "chatgpt", requestId);
  await assertAccountAvailableForNewCampaign(tenantId,account);
  const { key } = await resolveChatgptAccount(tenantId, account);
  const { lifetime_budget_micros, daily_budget_micros, ...settings } = value;
  const body = { ...settings, name: prefix + value.name, status: "paused", budget: daily_budget_micros != null ? { daily_spend_limit_micros: daily_budget_micros } : { lifetime_spend_limit_micros: lifetime_budget_micros } };
  validateSchedule(body);
  await checkResources(tenantId, value, {key,accountId:account.account_id});
  const row = await chatgptAdsPost<Row>(key, "/campaigns", body, idem);
  if (!row.id || !ownsCampaignName(row.name, prefix)) return bad("chatgpt_ads_bad_response", "The created campaign could not be verified. Refresh before trying again.");
  await bindCampaign(tenantId, account, row.id);
  return publicCampaign(row);
}

export const SERVER_MADE = "server_made" as const;
function assertConfirmedCampaign(campaign: Row, status: "active" | "paused", expectedCampaignUpdatedAt: number | typeof SERVER_MADE | undefined) {
  if (expectedCampaignUpdatedAt === SERVER_MADE) return;
  if (status === "active" && campaign.updated_at !== expectedCampaignUpdatedAt) return bad("chatgpt_ads_conflict", "This campaign changed. Refresh it before activating.");
}

export async function updateAdStatus(tenantId: string, campaignId: string, adGroupId: string, adId: string, status: "active" | "paused", expectedCampaignUpdatedAt?: number | typeof SERVER_MADE) {
  id.parse(adGroupId); id.parse(adId); z.enum(["active", "paused"]).parse(status);
  const { key, campaign, binding, providerCurrency } = await ownedCampaign(tenantId, campaignId);
  assertConfirmedCampaign(campaign, status, expectedCampaignUpdatedAt);
  if (expectedCampaignUpdatedAt === SERVER_MADE) {
    if (status === "active" && campaign.status !== "active") return bad("chatgpt_ads_conflict", "The campaign is not on, so its ads were not switched on.");
    if (!visible(await pointChild(key, "ad_groups", adGroupId, { campaign_id: campaignId }))) return bad("chatgpt_ads_not_found", "Ad group not found in this campaign.");
    if (!visible(await pointChild(key, "ads", adId, { ad_group_id: adGroupId, campaign_id: campaignId }))) return bad("chatgpt_ads_not_found", "Ad not found in this campaign.");
  } else {
    const groups = await list(key, "/ad_groups", { campaign_id: campaignId });
    if (!groups.some(g => g.id === adGroupId && (g.campaign_id == null || g.campaign_id === campaignId))) return bad("chatgpt_ads_not_found", "Ad group not found in this campaign.");
    const ads = await list(key, "/ads", { ad_group_id: adGroupId });
    if (!ads.some(a => a.id === adId && (a.ad_group_id == null || a.ad_group_id === adGroupId) && (a.campaign_id == null || a.campaign_id === campaignId))) return bad("chatgpt_ads_not_found", "Ad not found in this campaign.");
  }
  return withWorkspaceGrowthBudget(tenantId, campaign as any, { ...campaign, status: status === "active" ? campaign.status : "paused" } as any, "ad", async () => {
  if (status === "active" && campaign.status === "active") {
    await assertServingReady(key,binding.funding_source);
    await checkResources(tenantId, campaign, {key,accountId:binding.account_id});
    const { reserveCampaign } = await import("@/services/channels/chatgpt-ads/wallet");
    await reserveCampaign(tenantId, campaignId, fundingArgument(campaign));
  }
  const row = await chatgptAdsPost<Row>(key, `/ads/${encodeURIComponent(adId)}`, { status });
  if (row.id !== adId || row.status !== status) return bad("chatgpt_ads_bad_response", "The ad change could not be verified. Refresh before retrying.");
  return { id: adId, status };
  },{binding,currency:providerCurrency??"USD"});
}

export const groupCreate = z.object({ name: z.string().trim().min(3).max(1000), context_hints: z.array(z.string().trim().min(1).max(500)).max(20), max_bid_micros: z.number().int().min(1).max(1_000_000_000).optional(), strategy: z.enum(["fixed_bid", "maximize_clicks", "maximize_conversions"]).optional(), landing_page_configuration: scheduleFields.landing_page_configuration }).strict();
export function groupBidding(campaign: Row, value: z.infer<typeof groupCreate>) {
  const strategy = value.strategy ?? "fixed_bid";
  if (!["clicks", "impressions", "conversions"].includes(campaign.bidding_type)) return bad("chatgpt_ads_conflict", "Unsupported campaign objective.");
  if (strategy === "fixed_bid" && value.max_bid_micros == null) return bad("chatgpt_ads_conflict", 'Omitted group.strategy defaults to "fixed_bid", which requires group.max_bid_micros. For automatic bidding with a daily budget, explicitly set group.strategy to "maximize_clicks" for campaign.bidding_type="clicks", or "maximize_conversions" for "conversions", and omit group.max_bid_micros. Impressions require a fixed bid.');
  if (strategy !== "fixed_bid" && value.max_bid_micros != null) return bad("chatgpt_ads_conflict", "Automatic bidding must omit group.max_bid_micros; remove it rather than setting it to null.");
  if (strategy !== "fixed_bid" && (strategy !== `maximize_${campaign.bidding_type}` || campaign.budget?.daily_spend_limit_micros == null)) return bad("chatgpt_ads_conflict", "Automatic bidding requires a matching objective and daily budget.");
  return { billing_event_type: campaign.bidding_type === "impressions" ? "impression" : "click", strategy, ...(strategy === "fixed_bid" ? { max_bid_micros: value.max_bid_micros } : {}) };
}
export async function createAdGroup(tenantId: string, campaignId: string, input: z.infer<typeof groupCreate>, requestId: string) {
  const value = groupCreate.parse(input);
  const idem = createKey(tenantId, `group:${campaignId}`, requestId);
  const { key, campaign, binding } = await ownedCampaign(tenantId, campaignId);
  await checkResources(tenantId, campaign, {key,accountId:binding.account_id});
  const row = await chatgptAdsPost<Row>(key, "/ad_groups", { campaign_id: campaignId, name: value.name, context_hints: value.context_hints, status: "paused", bidding_config: groupBidding(campaign, value), ...(value.landing_page_configuration ? { landing_page_configuration: value.landing_page_configuration } : {}) }, idem);
  if (typeof row.id !== "string") return bad("chatgpt_ads_bad_response", "Ad group creation could not be verified. Refresh before retrying.");
  return { id: row.id };
}

export const publicUrl = z.string().url().refine(value => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[|0\.)/i.test(u.hostname);
  } catch {
    return false;
  }
}, "Use a public HTTPS URL.");
export const adCreative = z.object({
  ad_group_id: id, name: z.string().trim().min(3).max(1000), title: z.string().trim().min(3).max(50), body: z.string().trim().min(1).max(100),
  target_url: publicUrl.optional(), image_url: publicUrl.optional(),
  image_path: z.string().regex(AD_IMAGE_PATH_RE).optional(),
  image_artifact_id: z.string().uuid().optional(),
  creative_type: z.enum(["chat_card", "product_ad_template"]).optional(),
  landing_page_configuration: scheduleFields.landing_page_configuration,
  tracking: z.string().max(2000).default(""),
}).strict();

export async function saveAdCreative(tenantId: string, campaignId: string, input: z.infer<typeof adCreative>, adId?: string, requestId?: string, createdGroupId?: string) {
  const value = adCreative.parse(input);
  if ([value.image_url, value.image_path, value.image_artifact_id].filter(Boolean).length > 1) return bad("chatgpt_ads_conflict", "Choose one image for the ad.");
  const idem = adId ? undefined : createKey(tenantId, `ad:${campaignId}`, requestId!);
  const destination = value.target_url ? new URL(value.target_url) : null;
  if (destination && value.landing_page_configuration) {
    for (const k of [...destination.searchParams.keys()]) if (k.startsWith("utm_") || k === "click_id") destination.searchParams.delete(k);
  }
  const tracking = new URLSearchParams(value.tracking.replace(/^\?/, ""));
  for (const [key, val] of tracking) {
    if (!/^utm_[a-z_]+$/.test(key)) return bad("chatgpt_ads_conflict", "Tracking fields must use utm_ names.");
    destination?.searchParams.set(key, val);
  }
  const { key, campaign, binding } = await ownedCampaign(tenantId, campaignId);
  if (adId || value.ad_group_id !== createdGroupId) {
    const groups = await list(key, "/ad_groups", { campaign_id: campaignId });
    if (!groups.some(g => g.id === value.ad_group_id && (g.campaign_id == null || g.campaign_id === campaignId))) return bad("chatgpt_ads_not_found", "Ad group not found in this campaign.");
  }
  let existing: Row | undefined;
  if (adId) {
    id.parse(adId);
    const ads = await list(key, "/ads", { ad_group_id: value.ad_group_id });
    existing = ads.find(a => a.id === adId && (a.ad_group_id == null || a.ad_group_id === value.ad_group_id));
    if (!existing || (existing.campaign_id != null && existing.campaign_id !== campaignId)) return bad("chatgpt_ads_not_found", "Ad not found in this campaign.");
    if (existing.creative?.type !== (value.creative_type ?? "chat_card")) return bad("chatgpt_ads_conflict", "An ad’s creative type cannot be changed.");
  }
  const product = value.creative_type === "product_ad_template";
  if (product !== (campaign.mode === "product_feed")) return bad("chatgpt_ads_conflict", "Creative type must match the campaign source.");
  if (product) {
    await checkResources(tenantId, { product_feed_id: campaign.product_feed_id }, {key,accountId:binding.account_id});
    if (value.image_url || value.image_path || value.image_artifact_id || value.target_url) return bad("chatgpt_ads_conflict", "Product ads use catalog images and destinations.");
    const ads = await list(key, "/ads", { ad_group_id: value.ad_group_id });
    if (ads.some(a => a.id !== adId && a.status !== "archived" && a.creative?.type === "product_ad_template")) return bad("chatgpt_ads_conflict", "This group already has a product ad. Edit it instead.");
  } else if (!destination) return bad("chatgpt_ads_conflict", "Choose a destination URL.");
  let fileId = existing?.creative?.file_id;
  if (value.image_url || value.image_path || value.image_artifact_id) {
    const fetchUrl = value.image_artifact_id
      ? await signGeneratedAdImage(tenantId, value.image_artifact_id)
      : value.image_path ? await signOwnImageForVendor(tenantId, value.image_path) : value.image_url!;
    const uploaded = idem ? await stableCreativeUpload(tenantId, idem, value, key, fetchUrl) : await chatgptAdsPost<Row>(key, "/upload", { image_url: fetchUrl });
    fileId = uploaded.file_id;
    if (typeof fileId !== "string") return bad("chatgpt_ads_bad_response", "The image upload could not be verified.");
  }
  if (!product && !fileId) return bad("chatgpt_ads_conflict", "Choose an image for the ad.");
  const body: Row = { name: value.name, status: "paused", creative: { type: product ? "product_ad_template" : "chat_card", title: value.title, body: value.body, ...(!product ? { target_url: destination!.href, file_id: fileId } : {}) }, ...(value.landing_page_configuration ? { landing_page_configuration: value.landing_page_configuration } : {}) };
  if (!adId) body.ad_group_id = value.ad_group_id;
  const row = await chatgptAdsPost<Row>(key, adId ? `/ads/${encodeURIComponent(adId)}` : "/ads", body, idem);
  if (typeof row.id !== "string" || (adId && row.id !== adId)) return bad("chatgpt_ads_bad_response", "Ad save could not be verified. Refresh before retrying.");
  return { id: row.id, status: row.status };
}

export async function updateGroupStatus(tenantId: string, campaignId: string, groupId: string, status: "active" | "paused", expectedCampaignUpdatedAt?: number | typeof SERVER_MADE) {
  id.parse(groupId); z.enum(["active", "paused"]).parse(status);
  const { key, campaign, binding, providerCurrency } = await ownedCampaign(tenantId, campaignId);
  assertConfirmedCampaign(campaign, status, expectedCampaignUpdatedAt);
  if (expectedCampaignUpdatedAt === SERVER_MADE && status === "active" && campaign.status !== "active") return bad("chatgpt_ads_conflict", "The campaign is not on, so its ad group was not switched on.");
  const member = expectedCampaignUpdatedAt === SERVER_MADE
    ? visible(await pointChild(key, "ad_groups", groupId, { campaign_id: campaignId }))
    : (await list(key, "/ad_groups", { campaign_id: campaignId })).some(g => g.id === groupId && (g.campaign_id == null || g.campaign_id === campaignId));
  if (!member) return bad("chatgpt_ads_not_found", "Ad group not found in this campaign.");
  return withWorkspaceGrowthBudget(tenantId, campaign as any, { ...campaign, status: status === "active" ? campaign.status : "paused" } as any, "group", async () => {
  if (status === "active" && campaign.status === "active") {
    await assertServingReady(key,binding.funding_source);
    await checkResources(tenantId, campaign, {key,accountId:binding.account_id});
    const { reserveCampaign } = await import("@/services/channels/chatgpt-ads/wallet");
    await reserveCampaign(tenantId, campaignId, fundingArgument(campaign));
  }
  const row = await chatgptAdsPost<Row>(key, `/ad_groups/${encodeURIComponent(groupId)}`, { status });
  if (row.id !== groupId || row.status !== status) return bad("chatgpt_ads_bad_response", "The group change could not be verified. Refresh before retrying.");
  return { id: groupId, status };
  },{binding,currency:providerCurrency??"USD"});
}

export async function readCampaignSafety(tenantId: string) {
  const prefix = await resolveTenantCampaignPrefix(tenantId);
  const key = await getChatgptAdsApiKey();
  const inventory = await listChatgptAdsCampaigns(key);
  return {
    campaigns: inventory.campaigns.filter(c => ownsCampaignName(c.name, prefix)).map(c => ({ id: c.id, name: c.name.trim().slice(prefix.length), status: c.status, updated_at: c.updated_at })),
    complete: !inventory.pages_exhausted && inventory.unreadable_campaigns === 0 && !inventory.campaigns.some(c => normalizeCampaignName(c.name).startsWith(prefix) && !ownsCampaignName(c.name, prefix)),
  };
}

export function fundingArgument(campaign: Row) {
  const limit = fundingLimit(campaign);
  return campaign.budget?.daily_spend_limit_micros != null ? { daily_micros: campaign.budget.daily_spend_limit_micros as number, start: Math.min(campaign.start_time, campaign.created_at ?? campaign.start_time), end: campaign.end_time as number } : limit;
}
export async function readCampaign(tenantId: string, campaignId: string) {
  return publicCampaign((await ownedCampaign(tenantId, campaignId)).campaign);
}

export async function readCampaignTree(tenantId: string, campaignId: string) {
  const { key, campaign, binding, providerAccountId, providerCurrency } = await ownedCampaign(tenantId, campaignId);
  const groups = (await list(key, "/ad_groups", { campaign_id: campaignId }))
    .filter(g => typeof g.id === "string" && (g.campaign_id == null || g.campaign_id === campaignId) && g.status !== "archived");
  if (groups.length > 50) return bad("chatgpt_ads_incomplete", "This campaign has too many ad groups to launch at once. Use the campaign list.");
  const ads: Row[] = [];
  for (const g of groups) {
    const rows = await list(key, "/ads", { ad_group_id: g.id, include: ["serving_issues"] });
    ads.push(...rows.filter(a => typeof a.id === "string" && (a.ad_group_id == null || a.ad_group_id === g.id) && (a.campaign_id == null || a.campaign_id === campaignId) && a.status !== "archived").map(a => ({ ...a, ad_group_id: g.id })));
  }
  return { campaign, groups, ads, binding, providerAccountId, providerCurrency };
}

async function pointChild(key: string, kind: "ad_groups" | "ads", childId: string, parents: { campaign_id: string; ad_group_id?: string }): Promise<Row | null | "archived"> {
  id.parse(childId);
  let row: Row;
  try { row = await chatgptAdsGet<Row>(key, `/${kind}/${encodeURIComponent(childId)}`); }
  catch (e) {
    if (e instanceof ExpectedToolError && e.code === "chatgpt_ads_http_error" && (e.meta as { status?: number } | undefined)?.status === 404) return null;
    throw e;
  }
  if (row.id !== childId) return bad("chatgpt_ads_bad_response", "The Ads API returned a different object than the one asked for.");
  if ((row.campaign_id != null && row.campaign_id !== parents.campaign_id) || (parents.ad_group_id && row.ad_group_id != null && row.ad_group_id !== parents.ad_group_id))
    return bad("chatgpt_ads_not_found", kind === "ads" ? "Ad not found in this campaign." : "Ad group not found in this campaign.");
  return row.status === "archived" ? ARCHIVED : row;
}
const ARCHIVED = "archived" as const;
const visible = (r: Row | null | typeof ARCHIVED): r is Row => !!r && r !== ARCHIVED;

export type ServerMadeManifest = {
  groupId: string;
  adIds: string[];
  terms?: { budget: unknown; start_time: unknown; end_time: unknown; max_bid_micros: number | null };
};

export async function serverMadeDrift(tenantId: string, campaignId: string, manifest: ServerMadeManifest, tree: { campaign: Row; groups: Row[] }): Promise<string | null> {
  const t = manifest.terms;
  if (t) {
    const c = tree.campaign;
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    if (!same(campaignBudget(c.budget), campaignBudget(t.budget as Row)) || !same(c.start_time, t.start_time) || !same(c.end_time, t.end_time))
      return "The campaign's budget or schedule changed after Zavi made it, so it was not turned on.";
    const bid = tree.groups[0]?.bidding_config?.max_bid_micros ?? null;
    if (t.max_bid_micros != null && bid !== t.max_bid_micros) return "The ad group's bid changed after Zavi made it, so the campaign was not turned on.";
  }
  const { key } = await ownedCampaign(tenantId, campaignId);
  const groups = await list(key, "/ad_groups", { campaign_id: campaignId });
  if (groups.some(g => g.id !== manifest.groupId && g.status === "active" && (g.campaign_id == null || g.campaign_id === campaignId)))
    return "Another ad group in this campaign is switched on, so Zavi did not turn the campaign on.";
  for (const g of groups.filter(g => g.status !== "archived")) {
    const ads = await list(key, "/ads", { ad_group_id: g.id });
    if (ads.some(a => !manifest.adIds.includes(a.id) && a.status === "active")) return "Another ad in this campaign is switched on, so Zavi did not turn the campaign on.";
  }
  return null;
}

export async function readServerMadeTree(tenantId: string, campaignId: string, manifest: ServerMadeManifest) {
  const { key, campaign, binding, providerAccountId, providerCurrency } = await ownedCampaign(tenantId, campaignId);
  const group = await pointChild(key, "ad_groups", manifest.groupId, { campaign_id: campaignId });
  const found = await Promise.all(manifest.adIds.map(a => pointChild(key, "ads", a, { campaign_id: campaignId, ad_group_id: manifest.groupId })));
  const ads: Row[] = found.filter(visible).map((a): Row => ({ ...a, ad_group_id: manifest.groupId }));
  const missing = [...(group === null ? [manifest.groupId] : []), ...manifest.adIds.filter((_, i) => found[i] === null)];
  const archived = [...(group === ARCHIVED ? [manifest.groupId] : []), ...manifest.adIds.filter((_, i) => found[i] === ARCHIVED)];
  return { campaign, groups: visible(group) ? [group] : [], ads, binding, providerAccountId, providerCurrency, missing, archived };
}
export async function editAdGroup(tenantId: string, campaignId: string, groupId: string, input: z.infer<typeof groupCreate>) {
  const value = groupCreate.parse(input); id.parse(groupId);
  const { key, campaign, binding } = await ownedCampaign(tenantId, campaignId);
  const groups = await list(key, "/ad_groups", { campaign_id: campaignId });
  const group = groups.find(g => g.id === groupId && (g.campaign_id == null || g.campaign_id === campaignId));
  if (!group || group.status === "archived") return bad("chatgpt_ads_not_found", "Ad group not found in this campaign.");
  const bidding = { ...group.bidding_config, ...groupBidding(campaign, value) };
  if (bidding.strategy !== "fixed_bid") { delete bidding.max_bid_micros; delete bidding.custom_audience_bid_multipliers; }
  const row = await chatgptAdsPost<Row>(key, `/ad_groups/${groupId}`, { name: value.name, context_hints: value.context_hints, status: "paused", bidding_config: bidding, ...(value.landing_page_configuration ? { landing_page_configuration: value.landing_page_configuration } : {}) });
  if (row.id !== groupId) return bad("chatgpt_ads_bad_response", "Ad group save could not be confirmed.");
  return { id: row.id, status: row.status };
}

export async function campaignReport(tenantId: string, campaignId: string, days: number, breakdown: "daily" | "country") {
  const { key } = await ownedCampaign(tenantId, campaignId);
  const account = await chatgptAdsGet<{ timezone: string }>(key, "/ad_account");
  const period = purchaseWindow(days, account.timezone);
  const fields = ["impressions", "clicks", "spend", "ctr", "cpc", "cpm"];
  const rows = await list(key, `/campaigns/${campaignId}/insights`, { aggregation_level: "campaign", time_granularity: breakdown === "daily" ? "daily" : "none", time_ranges: [JSON.stringify({ type: "date_range", since: period.from, until: period.to, timezone: period.timezone })], ...(breakdown === "country" ? { segments: ["country"] } : {}), fields: ["campaign_id", ...(breakdown === "daily" ? ["readable_time", ...fields] : ["country.name", ...fields.map(f => `country.${f}`)])] });
  return { period, rows: rows.filter(r => r.campaign_id == null || r.campaign_id === campaignId).map(r => {
    const source = breakdown === "daily" ? r : r.country ?? Object.fromEntries(fields.map(f => [f, r[`country.${f}`]]));
    const label = breakdown === "daily" ? r.readable_time : r.country?.name ?? r["country.name"];
    return { label: typeof label === "string" ? label : "Unknown", ...metrics(source) };
  }) };
}
