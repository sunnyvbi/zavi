import { z } from "zod";
import { ExpectedToolError } from "@/services/tools/types";
import { endpoint, getObject, getPost, listObjects, objectSchema, pages, type RedditAccount, type RedditObject } from "./adapter";
import { createImagePost, createObject, patchObject } from "./writes";
import { prepareSchema, type CampaignPlan } from "./schema";
import { durableStep, operationStore, requestHash, type OperationStore } from "./operations";
import type { RedditLevel } from "./identifiers";
import { assertReady } from "./readiness-gates";

const manifestSchema = z.object({ id: z.string(), campaign: z.record(z.string(), z.unknown()), group: z.record(z.string(), z.unknown()), ads: z.array(z.record(z.string(), z.unknown())), plan: z.unknown().optional() });
export type Manifest = { id: string; campaign: RedditObject; group: RedditObject; ads: RedditObject[] };
export type BeforeWrite = () => Promise<void>;
const CLAIM_CLOCK_SKEW_MS = 60_000;
export const POST_ATTEMPT_WINDOW_MS = 10 * 60_000;
const tag = (name: string, key: string, step: string) => `${name} [prax:${key}:${step}]`;
const LABELS: Record<RedditLevel, string> = { campaign: "Campaign", ad_group: "Ad group", ad: "Ad" };
function usable(obj: RedditObject, level: RedditLevel): RedditObject {
  if (obj.configured_status !== "ARCHIVED" && obj.configured_status !== "DELETED") return obj;
  throw new ExpectedToolError("reddit_ads_retained_object_archived", `${LABELS[level]} ${obj.id} from this operation is ${obj.configured_status.toLowerCase()} in Reddit. Zavi will not reuse it or create a replacement under this operation key. Propose the campaign again with a new operation key.`);
}
function unique(rows: RedditObject[], name: string, level: RedditLevel): RedditObject | null {
  const matches = rows.filter((r) => r.name === name);
  if (matches.length > 1) throw new ExpectedToolError("reddit_ads_duplicate_match", "Multiple Reddit objects match this operation. Review them before continuing.");
  return matches[0] ? usable(matches[0], level) : null;
}
async function retained(account: RedditAccount, accountId: string, level: RedditLevel, store: OperationStore, step: string, run: () => Promise<RedditObject>): Promise<RedditObject> {
  const prior = await store.read(step);
  const obj = await run();
  return prior?.state === "complete" ? usable(await getObject(account, accountId, level, obj.id), level) : obj;
}
const sameTime = (live: unknown, expected: string) => typeof live === "string" && Date.parse(live) === Date.parse(expected);
export async function ownedProfile(account: RedditAccount, accountId: string, profileId: string): Promise<void> {
  const profiles = await pages(account, "LIST_PROFILES_BY_AD_ACCOUNT", { ad_account_id: accountId }, endpoint("ad_accounts", accountId, "/profiles"));
  if (!profiles.some((p) => p.id === profileId)) throw new ExpectedToolError("reddit_ads_profile_not_owned", "The creative profile is not accessible to the selected ad account.");
}
export async function createCreative(account: RedditAccount, accountId: string, profileId: string, key: string, index: number, creative: CampaignPlan["creatives"][number], store: OperationStore, beforeWrite: BeforeWrite): Promise<RedditObject> {
  await ownedProfile(account, accountId, profileId);
  const step = `post_${index}`;
  const headline = creative.headline;
  const media = creative.image_artifact_id ? { image_artifact_id: creative.image_artifact_id } : creative.image_path ? { image_path: creative.image_path } : { media_url: creative.image_url };
  const data = { type: "IMAGE", headline, allow_comments: creative.allow_comments, content: [{ ...media, destination_url: creative.destination_url }] };
  return durableStep(store, step, { ...data, profile_id: profileId }, async () => {
    const images = await import("./creative-images");
    const media_url = creative.image_artifact_id ? await images.signCreativeImage(account.tenant_id, creative.image_artifact_id) : creative.image_path ? await images.signChatCreativeImage(account.tenant_id, creative.image_path) : creative.image_url;
    await beforeWrite();
    return createImagePost(account, profileId, { ...data, content: [{ media_url, destination_url: creative.destination_url }] });
  }, async () => {
    const rows = await pages(account, "LIST_POSTS", { profile_id: profileId, page_size: 100 }, endpoint("profiles", profileId, "/posts"));
    return findStepPost(account.tenant_id, rows, { ...data, profile_id: profileId }, (await store.read(step))?.created_at);
  });
}
export async function findStepPost(tenantId: string, posts: Array<Record<string, unknown>>, request: Record<string, unknown>, claimedAtIso: string | null | undefined): Promise<RedditObject | null> {
  const claimedAt = Date.parse(String(claimedAtIso ?? ""));
  if (!Number.isFinite(claimedAt)) return null;
  const content = Array.isArray(request.content) ? (request.content as Array<Record<string, unknown>>) : null;
  if (!content || content.length !== 1) return null;
  const artifactId = typeof content[0].image_artifact_id === "string" ? content[0].image_artifact_id : null;
  const chatPath = typeof content[0].image_path === "string" ? content[0].image_path : null;
  let imagePath: string | null = null;
  if (artifactId) {
    imagePath = await (await import("./creative-images")).creativeImagePath(tenantId, artifactId);
    if (!imagePath) return null;
  }
  if (chatPath) {
    const { isOwnAdImagePath } = await import("@zavi/shared");
    if (!isOwnAdImagePath(tenantId, chatPath)) return null;
    imagePath = chatPath;
  }
  const { mediaIsObject } = await import("./creative-images");
  const { CHAT_IMAGE_BUCKET } = await import("@/services/chat-images/store-chat-image");
  const samePicture = (c: unknown) => {
    if (!imagePath) return JSON.stringify(c) === JSON.stringify(content);
    const one = Array.isArray(c) && c.length === 1 ? (c[0] as { destination_url?: unknown; media_url?: unknown }) : null;
    return !!one && one.destination_url === content[0].destination_url && mediaIsObject(one.media_url, imagePath, undefined, chatPath ? CHAT_IMAGE_BUCKET : undefined);
  };
  const madeAfterClaim = (r: Record<string, unknown>) => {
    const at = typeof r.created_at === "string" ? Date.parse(r.created_at) : NaN;
    return Number.isFinite(at) && at >= claimedAt - CLAIM_CLOCK_SKEW_MS && at <= claimedAt + POST_ATTEMPT_WINDOW_MS;
  };
  const matches = posts.filter((r) => r.profile_id === request.profile_id && r.headline === request.headline && r.type === "IMAGE" && r.allow_comments === request.allow_comments && samePicture(r.content) && madeAfterClaim(r));
  if (matches.length > 1) throw new ExpectedToolError("reddit_ads_duplicate_match", "Multiple image posts match this operation.");
  const p = matches[0];
  return p && typeof p.id === "string" ? { ...p, id: p.id } : null;
}
export async function preparedCampaign(tenantId: string, key: string, actionId: string): Promise<{ plan: CampaignPlan; manifest: Manifest; store: OperationStore }> {
  const store = operationStore(tenantId, key, actionId);
  const plan = await store.read("plan");
  const manifest = await store.read("manifest");
  if (plan?.state !== "complete" || manifest?.state !== "complete") throw new ExpectedToolError("reddit_ads_prepare_incomplete", "Campaign preparation is incomplete. Reconcile and finish the original operation before launching.");
  const parsed = manifestSchema.parse(manifest.result);
  const stored = prepareSchema.safeParse(parsed.plan ?? plan.result);
  if (!stored.success) throw new ExpectedToolError("reddit_ads_invalid_request", "This campaign was prepared before Zavi required a start time and a $100 minimum lifetime cap, so it cannot be launched as it is. Propose the campaign again with a new operation key.");
  return { store, plan: stored.data, manifest: { id: parsed.id, campaign: objectSchema.parse(parsed.campaign), group: objectSchema.parse(parsed.group), ads: parsed.ads.map((a) => objectSchema.parse(a)) } };
}
export async function prepareCampaign(tenantId: string, actionId: string, b: CampaignPlan, beforeWrite: BeforeWrite): Promise<Manifest> {
  const { account } = await assertReady(tenantId, b.ad_account_id, b.pixel_id);
  await ownedProfile(account, b.ad_account_id, b.profile_id);
  const store = operationStore(tenantId, b.operation_key, actionId);
  if (await store.claim("plan", b)) await store.save("plan", "complete", b);
  else if ((await store.read("plan"))?.request_hash !== requestHash(b)) throw new ExpectedToolError("reddit_ads_operation_conflict", "This operation key belongs to a different campaign plan.");
  if ((await store.read("plan"))?.state !== "complete") await store.save("plan", "complete", b);
  const priorGroup = await store.read("group");
  if ((!priorGroup || priorGroup.state === "failed") && Date.parse(b.start_time) <= Date.now()) throw new ExpectedToolError("reddit_ads_invalid_request", `The approved start time ${b.start_time} has already passed, so Zavi did not create the ad group. Propose the campaign again with a future start_time and a new operation key.`);
  const campaignData = { name: tag(b.name, b.operation_key, "campaign"), configured_status: "PAUSED", objective: b.objective, is_campaign_budget_optimization: false, spend_cap: Math.round(b.lifetime_cap_usd * 1000000) };
  const campaign = await retained(account, b.ad_account_id, "campaign", store, "campaign", () => durableStep(store, "campaign", campaignData, async () => { await beforeWrite(); return createObject(account, b.ad_account_id, "campaign", campaignData); }, async () => unique(await listObjects(account, b.ad_account_id, "campaign"), campaignData.name, "campaign")));
  const groupData = { ad_account_id: b.ad_account_id, campaign_id: campaign.id, name: tag(b.name, b.operation_key, "group"), configured_status: "PAUSED", goal_type: "DAILY_SPEND", goal_value: Math.round(b.daily_budget_usd * 1000000), bid_strategy: "BIDLESS", bid_type: "CPC", optimization_goal: "CLICKS", conversion_pixel_id: b.pixel_id, start_time: b.start_time, targeting: b.targeting };
  const group = await retained(account, b.ad_account_id, "ad_group", store, "group", () => durableStep(store, "group", groupData, async () => { await beforeWrite(); return createObject(account, b.ad_account_id, "ad_group", groupData); }, async () => unique((await listObjects(account, b.ad_account_id, "ad_group")).filter((g) => g.campaign_id === campaign.id), groupData.name, "ad_group")));
  const ads: RedditObject[] = [];
  for (const [index, creative] of b.creatives.entries()) {
    const post = await createCreative(account, b.ad_account_id, b.profile_id, b.operation_key, index, creative, store, beforeWrite);
    const data = { ad_group_id: group.id, name: tag(creative.name, b.operation_key, `ad_${index}`), post_id: post.id, click_url: creative.click_url ?? creative.destination_url, configured_status: "PAUSED" };
    const ad = await retained(account, b.ad_account_id, "ad", store, `ad_${index}`, () => durableStep(store, `ad_${index}`, data, async () => { await beforeWrite(); return createObject(account, b.ad_account_id, "ad", data); }, async () => unique((await listObjects(account, b.ad_account_id, "ad")).filter((a) => a.ad_group_id === group.id && a.post_id === post.id), data.name, "ad")));
    ads.push(ad);
  }
  const manifest = await verifyManifest(account, b, { id: campaign.id, campaign, group, ads }, "PAUSED");
  await store.claim("manifest", { campaign_id: campaign.id });
  await store.save("manifest", "complete", manifest);
  return manifest;
}
export function postMatchesCreative(post: Record<string, unknown> | null, profileId: string, creative: { headline: string; allow_comments: boolean; destination_url: string }): boolean {
  return !!post && post.profile_id === profileId && post.headline === creative.headline && post.type === "IMAGE" && post.allow_comments === creative.allow_comments && Array.isArray(post.content) && post.content.length === 1 && (post.content[0] as Record<string, unknown> | undefined)?.destination_url === creative.destination_url;
}
export async function verifyManifest(account: RedditAccount, plan: CampaignPlan, m: Manifest, status: "PAUSED" | "ACTIVE"): Promise<Manifest> {
  const campaign = await getObject(account, plan.ad_account_id, "campaign", m.campaign.id);
  const group = await getObject(account, plan.ad_account_id, "ad_group", m.group.id);
  if (campaign.configured_status !== status || campaign.objective !== plan.objective || campaign.spend_cap !== Math.round(plan.lifetime_cap_usd * 1000000) || campaign.is_campaign_budget_optimization !== false || group.configured_status !== status || group.campaign_id !== campaign.id || group.goal_type !== "DAILY_SPEND" || group.goal_value !== Math.round(plan.daily_budget_usd * 1000000) || group.conversion_pixel_id !== plan.pixel_id || group.optimization_goal !== "CLICKS") {
    throw new ExpectedToolError("reddit_ads_verification_failed", "Reddit campaign or ad group settings do not match the approved plan. Review before launch.");
  }
  const expected = { bid_strategy: "BIDLESS", bid_type: "CPC" };
  if (Object.entries(expected).some(([key, value]) => group[key] !== value) || !targetingMatches(group.targeting, plan.targeting)) throw new ExpectedToolError("reddit_ads_verification_failed", "Reddit bidding or targeting differs from the approved plan.");
  if (!sameTime(group.start_time, plan.start_time)) throw new ExpectedToolError("reddit_ads_verification_failed", `Reddit saved the ad group start time as ${String(group.start_time ?? "empty")}, not the approved ${plan.start_time}. Review the schedule before launch.`);
  if (m.ads.length !== plan.creatives.length) throw new ExpectedToolError("reddit_ads_verification_failed", "Prepared campaign is missing required ads.");
  const ads: RedditObject[] = [];
  for (const [i, a] of m.ads.entries()) {
    const live = await getObject(account, plan.ad_account_id, "ad", a.id);
    if (live.configured_status !== status || live.ad_group_id !== group.id || live.click_url !== (plan.creatives[i].click_url ?? plan.creatives[i].destination_url) || live.post_id !== a.post_id) throw new ExpectedToolError("reddit_ads_verification_failed", "Reddit ad settings do not match the approved plan.");
    const post = typeof live.post_id === "string" ? await getPost(account, live.post_id) : null;
    const creative = plan.creatives[i];
    if (!postMatchesCreative(post, plan.profile_id, creative)) throw new ExpectedToolError("reddit_ads_verification_failed", "Image post ownership, copy or destination could not be confirmed.");
    ads.push(live);
  }
  return { id: campaign.id, campaign, group, ads };
}
export async function launchCampaign(account: RedditAccount, plan: CampaignPlan, m: Manifest, store: OperationStore, beforeWrite: BeforeWrite): Promise<Manifest> {
  const entries = [...m.ads.map((a) => ({ level: "ad" as const, obj: a })), { level: "ad_group" as const, obj: m.group }, { level: "campaign" as const, obj: m.campaign }];
  for (const { level, obj } of entries) {
    const prior = await store.read(`enable_${obj.id}`);
    if (prior && prior.state !== "failed" && prior.state !== "complete") throw new ExpectedToolError("reddit_ads_outcome_unknown", "Reconcile the pending launch before continuing.");
    const snapshot = prior?.state === "complete" ? prior.result : obj;
    const modified = snapshot && typeof snapshot === "object" && "modified_at" in snapshot ? snapshot.modified_at : null;
    const live = await getObject(account, plan.ad_account_id, level, obj.id);
    if (!modified || live.modified_at !== modified) throw new ExpectedToolError("reddit_ads_object_drifted", "An object changed after preparation. Review the complete campaign before launching.");
  }
  for (const { level, obj } of entries) {
    const step = `enable_${obj.id}`;
    const prior = await store.read(step);
    const live = await getObject(account, plan.ad_account_id, level, obj.id);
    const expected = prior?.state === "complete" ? prior.result : obj;
    const modified = expected && typeof expected === "object" && "modified_at" in expected ? expected.modified_at : null;
    if (prior && prior.state !== "failed" && prior.state !== "complete") throw new ExpectedToolError("reddit_ads_outcome_unknown", "A launch step needs read-only reconciliation before it can continue.");
    if (!modified || live.modified_at !== modified) throw new ExpectedToolError("reddit_ads_object_drifted", "An object changed after preparation or was manually paused. Review it and propose a new status action; automatic launch will not override it.");
    await durableStep(store, step, { id: obj.id, configured_status: "ACTIVE" }, async () => {
      await beforeWrite();
      await patchObject(account, level, obj.id, { configured_status: "ACTIVE" });
      let result: RedditObject;
      try { result = await getObject(account, plan.ad_account_id, level, obj.id); } catch { throw new ExpectedToolError("reddit_ads_outcome_unknown", "Enablement was submitted but its result could not be read."); }
      if (result.configured_status !== "ACTIVE") throw new ExpectedToolError("reddit_ads_outcome_unknown", "Reddit has not confirmed enablement. Reconcile before retrying.");
      return result;
    }, async () => live.configured_status === "ACTIVE" ? live : null);
  }
  try { return await verifyManifest(account, plan, m, "ACTIVE"); } catch (e) {
    throw new ExpectedToolError("reddit_ads_outcome_unknown", `Every object was enabled, but the final read-back did not confirm the campaign (${e instanceof Error ? e.message : "read failed"}). Reconcile before retrying.`);
  }
}

export function targetingMatches(live: unknown, expected: CampaignPlan["targeting"]): boolean {
  if (!live || typeof live !== "object") return false;
  const values = live as Record<string, unknown>;
  return Object.entries(expected).every(([key, value]) => Array.isArray(value) ? Array.isArray(values[key]) && JSON.stringify([...value].sort()) === JSON.stringify([...(values[key] as unknown[])].sort()) : values[key] === value) && !["custom_audience_ids", "excluded_custom_audience_ids", "keywords", ...(expected.excluded_geolocations ? [] : ["excluded_geolocations"])].some((key) => Array.isArray(values[key]) && (values[key] as unknown[]).length > 0);
}
