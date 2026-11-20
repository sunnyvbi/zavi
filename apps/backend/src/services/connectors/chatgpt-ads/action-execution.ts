import { campaignActionRequestId } from "./campaign-action-request-id";
export { campaignActionRequestId } from "./campaign-action-request-id";
import { z } from "zod";
import { checkOwnImageForVendor } from "@/services/chat-images/sign-own-image";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { campaignDraftPresentationSchema } from "@/agents/lib/channel-recipe-step";
import { ExpectedToolError } from "@/services/tools/types";
import { checkAgentTier } from "@/services/agents/entitlement";
import { isChannelLocked } from "@/services/channels/lock";
import { claimCampaignAccount } from "@/services/ads-wallet/bindings";
import { resolveChatgptAccount } from "./account-binding";
import { previewChatgptAccount } from "@/services/ads-wallet/chatgpt-account-preview";
import { AD_IMAGE_PATH_RE, countryFromLocation, countryFromWebsite, isOwnAdImagePath, type CampaignReviewResponse, type CampaignReviewSuggested } from "@zavi/shared";
import { estimateCost, isTaskConfigured } from "@/services/media-router/router";
import { costToCredits } from "@/services/agents/credits";
import { getCompanyFacts } from "@/services/company/facts";
import { adCreative, campaignCreate, groupCreate, createCampaign, createAdGroup, saveAdCreative, publicUrl } from "./workspace";

const fail = (message: string): never => { throw new ExpectedToolError("chatgpt_ads_conflict", message); };
const setupUnavailable = (): never => { throw new ExpectedToolError("chatgpt_ads_setup_unavailable", "Zavi is finishing campaign setup. Your draft is saved, but creation is unavailable on this server right now."); };
export const campaignReviewInput = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  lifetime_budget_micros: z.number().int().min(1_000_000).max(1_000_000_000_000),
  max_bid_micros: z.number().int().min(1).max(1_000_000_000),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(50),
  image_urls: z.array(z.union([z.string().regex(AD_IMAGE_PATH_RE), publicUrl])).min(1).max(2),
}).strict();

export const STARTER = { currency: "USD", lifetime_budget_micros: 100_000_000, click_bid_micros: 2_000_000, country: "US" } as const;

const bundleSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  campaign: campaignCreate,
  group: groupCreate,
  ads: z.array(adCreative.omit({ ad_group_id: true, image_artifact_id: true }).required({ target_url: true })).min(1).max(2),
}).strict().superRefine((v, ctx) => {
  if (v.ads.some(ad => !ad.image_url === !ad.image_path)) ctx.addIssue({ code: "custom", message: "Each ad needs exactly one image." });
  if (v.campaign.daily_budget_micros != null || v.group.strategy !== "fixed_bid" || !v.group.max_bid_micros || v.campaign.mode) {
    ctx.addIssue({ code: "custom", message: "Reviewed drafts use a total budget and fixed bid." });
  }
  for (const ad of v.ads) {
    if (ad.creative_type && ad.creative_type !== "chat_card" || [...new URLSearchParams(ad.tracking).keys()].some(k => !/^utm_[a-z_]+$/.test(k))) {
      ctx.addIssue({ code: "custom", message: "Invalid creative or tracking fields." });
    }
  }
});

export { bundleSchema as campaignReviewBundleSchema };

async function currency(tenantId:string,actionId:string) {
  const {account}=await previewChatgptAccount(tenantId,campaignActionRequestId(actionId,"campaign"));
  if (!account.currency_code || !/^[A-Z]{3}$/.test(account.currency_code)) return fail("The ad account currency could not be verified. Try again.");
  return account.currency_code;
}

type StoredAction = {
  body: { step?: { responsibility?: string; deliverable?: { presentation?: unknown } } };
  status: string; exec_class: string | null; exec_status: string | null; exec_payload: unknown; approved_by: string | null;
  run_id: string | null;
};
export async function readAction(tenantId: string, actionId: string): Promise<StoredAction> {
  z.string().uuid().parse(actionId);
  const { data, error } = await tenantClient(asTenantId(tenantId)).from("channel_actions")
    .select("id, channel_slug, body, status, exec_class, exec_status, exec_payload, approved_by, run_id")
    .eq("id", actionId).eq("channel_slug", "chatgpt_ads").maybeSingle();
  if (error) throw new Error("Could not read campaign action.");
  if (!data) throw new ExpectedToolError("chatgpt_ads_not_found", "Action not found in this workspace.");
  return data as StoredAction;
}

async function assertCreativeStorage(tenantId: string, actionId: string) {
  const { error } = await tenantClient(asTenantId(tenantId)).from("ads_creative_uploads")
    .select("request_key").eq("request_key", campaignActionRequestId(actionId, "preflight")).maybeSingle();
  if (error) setupUnavailable();
}

export function assertReviewable(row: StoredAction) {
  if (row.status !== "pending" || row.exec_class || row.body?.step?.responsibility !== "client") return fail("This action changed. Refresh Next steps.");
}

async function companyCountry(tenantId: string): Promise<{ code: string; source: "company_profile" | "website" } | null> {
  const record = await getCompanyFacts(tenantId);
  const stated = countryFromLocation(record.facts.location?.value) ?? countryFromLocation(singleMarket(record.facts.markets?.value));
  if (stated) return { code: stated, source: "company_profile" };
  const fromSite = countryFromWebsite(record.website);
  return fromSite ? { code: fromSite, source: "website" } : null;
}
const singleMarket = (value: string | undefined) => value && !/[,;/&]|\band\b/i.test(value) ? value : undefined;

export async function suggestedDefaults(tenantId: string, draft: { bidding_type: string }, accountCurrency: string): Promise<CampaignReviewSuggested> {
  const usd = accountCurrency === STARTER.currency;
  const country = await companyCountry(tenantId).catch(() => null);
  return {
    lifetime_budget_micros: usd ? STARTER.lifetime_budget_micros : null,
    max_bid_micros: usd && draft.bidding_type === "clicks" ? STARTER.click_bid_micros : null,
    countries: [country?.code ?? STARTER.country],
    budget_source: "starter",
    countries_source: country?.source ?? "default",
  };
}

export async function aiImageOffer(row: StoredAction, prompt: string) {
  const available = !!row.run_id && await isTaskConfigured("image.photo").catch(() => false);
  if (!available) return { available: false, credits: null };
  const credits = costToCredits(estimateCost("image.photo", { prompt, aspect_ratio: "1:1" }));
  return { available: true, credits: credits > 0 ? credits : null };
}

export async function reviewCampaignAction(tenantId: string, actionId: string): Promise<CampaignReviewResponse<z.infer<typeof campaignDraftPresentationSchema>>> {
  const row = await readAction(tenantId, actionId);
  assertReviewable(row);
  const draft = campaignDraftPresentationSchema.parse(row.body?.step?.deliverable?.presentation);
  await assertCreativeStorage(tenantId, actionId);
  const accountCurrency = await currency(tenantId,actionId);
  const [suggested, ai_image] = await Promise.all([
    suggestedDefaults(tenantId, draft, accountCurrency),
    aiImageOffer(row, draft.ads[0]?.image_spec || draft.ads[0]?.title || draft.name),
  ]);
  return { draft, currency: accountCurrency, suggested, ai_image };
}

export async function prepareCampaignAction(tenantId: string, actionId: string, actorId: string, input: unknown) {
  const value = campaignReviewInput.parse(input);
  const row = await readAction(tenantId, actionId);
  const draft = campaignDraftPresentationSchema.parse(row.body?.step?.deliverable?.presentation);
  await assertCreativeStorage(tenantId, actionId);
  assertReviewable(row);
  if (value.image_urls.length !== draft.ads.length) return fail("Choose an image for each ad.");
  if (value.image_urls.some(v => !/^https:\/\//i.test(v) && !isOwnAdImagePath(tenantId, v))) return fail("That image is not in this workspace. Upload it again.");
  for (const image of new Set(value.image_urls)) {
    if (!/^https:\/\//i.test(image)) await checkOwnImageForVendor(tenantId, image);
  }
  if (await currency(tenantId,actionId) !== value.currency) return fail("The account currency changed. Review the budget again.");
  const payload = bundleSchema.parse({
    currency: value.currency,
    campaign: { name: draft.name, bidding_type: draft.bidding_type, conversion_event_setting_ids: draft.conversion_event_setting_ids,
      lifetime_budget_micros: value.lifetime_budget_micros, targeting: { locations: { countries: value.countries } } },
    group: { ...draft.group, strategy: "fixed_bid", max_bid_micros: value.max_bid_micros },
    ads: draft.ads.map(({ image_spec: _spec, image_url: _draftUrl, ...ad }, i) => {
      const image = value.image_urls[i];
      return /^https:\/\//i.test(image) ? { ...ad, image_url: image } : { ...ad, image_path: image };
    }),
  });
  const format = (micros: number) => `${(micros / 1e6).toFixed(2)} ${value.currency}`;
  const rows = [
    { item: "Campaign", before: "Not created", after: `${draft.name} · paused` },
    { item: "Total budget", before: "Not chosen", after: format(value.lifetime_budget_micros) },
    { item: draft.bidding_type === "impressions" ? "Maximum CPM bid" : "Maximum bid", before: "Not chosen", after: format(value.max_bid_micros * (draft.bidding_type === "impressions" ? 1000 : 1)) },
    { item: "Countries", before: "Not chosen", after: value.countries.join(", ") },
    { item: "Ad group and ads", before: "Not created", after: `${draft.group.name} · ${draft.ads.length} ads · all paused` },
    { item: "Ad image", before: "Not chosen", after: new Set(value.image_urls).size === 1 && draft.ads.length > 1 ? "One image shared by both ads" : draft.ads.length > 1 ? "A different image for each ad" : "Chosen" },
  ];
  const pinned=await resolveChatgptAccount(tenantId,await claimCampaignAccount(tenantId,"chatgpt",campaignActionRequestId(actionId,"campaign")));
  if(pinned.account.currency_code!==value.currency) return fail("The account currency changed. Review again.");
  const { data, error } = await tenantRpc(asTenantId(tenantId), "prepare_channel_campaign_action", {
    p_action_id: actionId, p_actor_user_id: actorId, p_expected_body: row.body,
    p_payload: payload, p_exact_change: { rows },
  });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") setupUnavailable();
    throw new Error("Could not prepare campaign action.");
  }
  if (!data?.ok) return fail("This action changed. Refresh Next steps before approving.");
  return { id: actionId, executable: true, exact_change: { rows } };
}

export async function executeCampaignAction(actionId: string, tenantId: string, actorId: string | null) {
  const row = await readAction(tenantId, actionId);
  if (!actorId || row.approved_by !== actorId || row.exec_class !== "chatgpt_ads.create_campaign_bundle" || row.exec_status !== "dispatching") return fail("This campaign needs administrator approval.");
  const { data: member, error } = await tenantClient(asTenantId(tenantId)).from("tenant_users").select("role").eq("user_id", actorId).maybeSingle();
  if (error || !member || !["owner", "admin"].includes((member as { role: string }).role)) return fail("An owner or administrator must approve this campaign.");
  if (!(await checkAgentTier(tenantId, "chatgpt_ads")).allowed || await isChannelLocked("chatgpt_ads")) return fail("ChatGPT Ads is not available for this workspace.");
  const value = bundleSchema.parse(row.exec_payload);
  for (const ad of value.ads) {
    if (ad.image_path) await checkOwnImageForVendor(tenantId, ad.image_path);
  }
  await assertCreativeStorage(tenantId, actionId);
  if (await currency(tenantId,actionId) !== value.currency) return fail("The account currency changed. Review this campaign again.");
  let campaign: { id: string };
  try {
    campaign = await createCampaign(tenantId, value.campaign, campaignActionRequestId(actionId, "campaign"));
  } catch (e) {
    if (isCleanRefusal(e)) throw e;
    return {
      ok: false as const,
      code: "exec_outcome_unknown",
      error: "The request to create the campaign did not come back clearly, so it may or may not exist. Zavi did not try again. Open the campaign list to check before doing anything else.",
    };
  }
  const made = { group: false, ads: 0 };
  try {
    const group = await createAdGroup(tenantId, campaign.id, value.group, campaignActionRequestId(actionId, "group"));
    made.group = true;
    for (const [i, ad] of value.ads.entries()) {
      await saveAdCreative(tenantId, campaign.id, { ...ad, ad_group_id: group.id }, undefined, campaignActionRequestId(actionId, `ad:${i}`), group.id);
      made.ads += 1;
    }
  } catch {
    const created = !made.group ? "the campaign" : made.ads === 0 ? "the campaign and ad group" : `the campaign, ad group and ${made.ads} of ${value.ads.length} ads`;
    return {
      ok: false as const,
      code: "exec_partial",
      error: `Created ${created} (paused), then the rest failed. Zavi did not try again, so nothing is created twice. Open the campaign list to finish or remove it there.`,
    };
  }
  return { ok: true, notice: `Created ${value.ads.length === 1 ? "your ad" : `${value.ads.length} ads`}, paused. Launch the campaign from your campaign list when you are ready.` };
}

function isCleanRefusal(e: unknown): boolean {
  if (!(e instanceof ExpectedToolError) || e.code === "chatgpt_ads_bad_response") return false;
  const status = Number(e.meta?.status);
  return !(Number.isFinite(status) && status >= 500);
}
