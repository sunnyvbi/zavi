import { ExpectedToolError } from "@/services/tools/types";
import { canonicalTargeting } from "./account-reads";
import { withLinkedInAdsToken } from "./client";
import { ENDED, INVALID, ownCampaign, refused, type ChangeResult } from "./execute-change";
import { commitAdSpend, holdLinkedInSpend, settleAdSpendAfterError, type LinkedInExecRow } from "./spend-hold";
import type { AdSpendHold } from "@/services/decisions/ad-budget";
import {
  archiveLinkedInEntityWithToken,
  createLinkedInCampaignGroupWithToken,
  createLinkedInCampaignInGroupWithToken,
  createLinkedInCreativeFromPostWithToken,
  createLinkedInInlineCreativeWithToken,
  linkedinCampaignCopyFields,
  linkedinCampaignTargeting,
  listLinkedInRawCampaignsInGroupWithToken,
  listLinkedInRawCreativesWithToken,
  patchLinkedInCampaignGroupWithToken,
  patchLinkedInCampaignWithToken,
  readLinkedInRawCampaignGroupWithToken,
  readLinkedInRawCampaignWithToken,
  readLinkedInRawCreativeWithToken,
  setLinkedInCreativeStatusWithToken,
  type LiRawCampaign,
  type LiRawCampaignGroup,
  type LiRawCreative,
} from "./write";
import {
  linkedinAdStatusBodySchema,
  linkedinArchiveBodySchema,
  linkedinCampaignEditBodySchema,
  linkedinCreateAdBodySchema,
  linkedinCreateCampaignBodySchema,
  linkedinDuplicateBodySchema,
  linkedinGroupEditBodySchema,
  linkedinSwapAdBodySchema,
  minor,
  type LinkedInAdSource,
} from "@/services/tools/linkedin-ads/_change-bodies";

type Exec = LinkedInExecRow;
const quoted = (name: string) => `"${name}"`;
const sameMoney = (a: { amount: string; currencyCode: string } | undefined, b: { amount: string; currency: string } | null) => (!a && !b) || (!!a && !!b && a.currencyCode === b.currency && minor(a.amount) === minor(b.amount));
const sameEnd = (live: number | undefined, card: string | null) => (typeof live === "number" ? card !== null && Date.parse(card) === live : card === null);
const sameStamp = (live: number | undefined, card: string | null) => card === null || typeof live !== "number" || Date.parse(card) === live;
const drift = (code: string, error: string): ChangeResult => ({ ok: false, code, error });
const accountFailed = (e: unknown): ChangeResult => ({ ok: false, code: e instanceof ExpectedToolError ? e.code : "linkedin_ads_read_failed", error: e instanceof ExpectedToolError ? e.message : "LinkedIn Ads could not be read, so Zavi did not change anything." });

async function accountInUse(tenant_id: string, account_id: string, what: string): Promise<ChangeResult | null> {
  try {
    const { linkedinAccountInUse } = await import("./own-accounts");
    if (!(await linkedinAccountInUse(tenant_id, account_id))) return { ok: false, code: "linkedin_ads_account_not_in_use", error: `The ad account on this card is not used in this workspace, so Zavi did not ${what}.` };
    return null;
  } catch (e) {
    return { ok: false, code: e instanceof ExpectedToolError ? e.code : "ads_binding_unavailable", error: `The ad account could not be verified, so Zavi did not ${what}.` };
  }
}

export async function executeLinkedInCampaignEdit(d: Exec): Promise<ChangeResult> {
  const p = linkedinCampaignEditBodySchema.safeParse(d.body);
  if (!p.success) return INVALID("edit");
  const b = p.data;
  const own = await ownCampaign(d.tenant_id, b);
  if (!own.ok) return own.result;
  const live = own.live as LiRawCampaign & { unitCost?: { amount: string; currencyCode: string }; audienceExpansionEnabled?: boolean; offsiteDeliveryEnabled?: boolean };
  const who = quoted(b.name);
  if (live.status && ENDED.has(live.status)) return drift("linkedin_ads_campaign_ended", `LinkedIn shows ${who} as ${live.status.toLowerCase()}, so it was left alone.`);
  const c = b.changes;
  const set: Record<string, unknown> = {};
  if (c.name) {
    if ((live.name ?? "") !== c.name.before) return drift("linkedin_ads_name_drift", `${who} was renamed in LinkedIn after this card was written, so Zavi did not change it.`);
    if (live.name !== c.name.after) set.name = c.name.after;
  }
  if (c.run_end_at) {
    if (!sameEnd(live.runSchedule?.end, c.run_end_at.before)) return drift("linkedin_ads_schedule_drift", `The end date of ${who} changed in LinkedIn after this card was written, so Zavi did not change it.`);
    const start = live.runSchedule?.start;
    if (typeof start !== "number") return drift("linkedin_ads_schedule_unread", `LinkedIn did not return the start date of ${who}, which an end-date change must keep, so Zavi did not change it.`);
    if (c.run_end_at.after !== null && Date.parse(c.run_end_at.after) <= Date.now()) return drift("linkedin_ads_end_date_passed", `The new end date on this card has passed, so Zavi did not change ${who}.`);
    if (!sameEnd(live.runSchedule?.end, c.run_end_at.after)) set.runSchedule = c.run_end_at.after === null ? { start } : { start, end: Date.parse(c.run_end_at.after) };
  }
  if (c.unit_cost) {
    if (!sameMoney(live.unitCost, c.unit_cost.before)) return drift("linkedin_ads_bid_drift", `The bid of ${who} is ${live.unitCost ? `${live.unitCost.currencyCode} ${live.unitCost.amount}` : "no longer set"} now, not ${c.unit_cost.before.currency} ${c.unit_cost.before.amount} as on this card, so Zavi did not change it.`);
    if (!sameMoney(live.unitCost, c.unit_cost.after)) set.unitCost = { amount: c.unit_cost.after.amount, currencyCode: c.unit_cost.after.currency };
  }
  if (c.audience_expansion) {
    if ((live.audienceExpansionEnabled ?? false) !== c.audience_expansion.before) return drift("linkedin_ads_setting_drift", `Audience expansion on ${who} was changed in LinkedIn after this card was written, so Zavi did not change it.`);
    if ((live.audienceExpansionEnabled ?? false) !== c.audience_expansion.after) set.audienceExpansionEnabled = c.audience_expansion.after;
  }
  if (c.offsite_delivery) {
    if ((live.offsiteDeliveryEnabled ?? false) !== c.offsite_delivery.before) return drift("linkedin_ads_setting_drift", `The LinkedIn Audience Network setting on ${who} was changed in LinkedIn after this card was written, so Zavi did not change it.`);
    if ((live.offsiteDeliveryEnabled ?? false) !== c.offsite_delivery.after) set.offsiteDeliveryEnabled = c.offsite_delivery.after;
  }
  if (c.targeting) {
    if (canonicalTargeting(live.targetingCriteria) !== c.targeting.before_fingerprint) return drift("linkedin_ads_targeting_drift", `The audience of ${who} was edited in LinkedIn after this card was written, so Zavi did not change it.`);
    if (canonicalTargeting(c.targeting.after_criteria) !== c.targeting.before_fingerprint) set.targetingCriteria = c.targeting.after_criteria;
  }
  if (!Object.keys(set).length) return { ok: true, notice: `${who} already had these settings in LinkedIn Ads.` };
  try {
    await withLinkedInAdsToken(d.tenant_id, (token) => patchLinkedInCampaignWithToken(token, b.account_id, b.campaign_id, set));
  } catch (e) {
    return refused(e, d.tenant_id, b, "edit");
  }
  return { ok: true, notice: `Edited ${who} in LinkedIn Ads (${Object.keys(set).map((k) => ({ name: "name", runSchedule: "end date", unitCost: "bid", audienceExpansionEnabled: "audience expansion", offsiteDeliveryEnabled: "Audience Network", targetingCriteria: "audience" })[k] ?? k).join(", ")}).` };
}

export async function executeLinkedInGroupEdit(d: Exec): Promise<ChangeResult> {
  const p = linkedinGroupEditBodySchema.safeParse(d.body);
  if (!p.success) return INVALID("campaign group edit");
  const b = p.data;
  const who = `campaign group "${b.name}"`;
  const inUse = await accountInUse(d.tenant_id, b.account_id, `change the ${who}`);
  if (inUse) return inUse;
  let live: LiRawCampaignGroup | null;
  try {
    live = await withLinkedInAdsToken(d.tenant_id, (token) => readLinkedInRawCampaignGroupWithToken(token, b.account_id, b.group_id));
  } catch (e) {
    return accountFailed(e);
  }
  if (!live) return drift("linkedin_ads_group_not_found", `LinkedIn could not find the ${who} in the account on this card, so Zavi did not change anything.`);
  if (live.status && ENDED.has(live.status)) return drift("linkedin_ads_group_ended", `LinkedIn shows the ${who} as ${live.status.toLowerCase()}, so it was left alone.`);
  if (live.backfilled) return drift("linkedin_ads_default_group", `The ${who} is the account's default group, which LinkedIn does not let anyone edit, so Zavi did not change it.`);
  const c = b.changes;
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  if (c.name) {
    if ((live.name ?? "") !== c.name.before) return drift("linkedin_ads_name_drift", `The ${who} was renamed in LinkedIn after this card was written, so Zavi did not change it.`);
    if (live.name !== c.name.after) set.name = c.name.after;
  }
  if (c.status) {
    if (live.status !== c.status.before) return drift("linkedin_ads_status_drift", `The ${who} is ${live.status?.toLowerCase() ?? "in an unknown state"} now, not ${c.status.before.toLowerCase()} as when this card was written, so Zavi did not change it.`);
    if (live.status !== c.status.after) set.status = c.status.after;
  }
  if (c.run_end_at) {
    if (!sameEnd(live.runSchedule?.end, c.run_end_at.before)) return drift("linkedin_ads_schedule_drift", `The end date of the ${who} changed in LinkedIn after this card was written, so Zavi did not change it.`);
    const start = live.runSchedule?.start;
    if (typeof start !== "number") return drift("linkedin_ads_schedule_unread", `LinkedIn did not return the start date of the ${who}, so Zavi did not change it.`);
    if (c.run_end_at.after !== null && Date.parse(c.run_end_at.after) <= Date.now()) return drift("linkedin_ads_end_date_passed", `The new end date on this card has passed, so Zavi did not change the ${who}.`);
    if (!sameEnd(live.runSchedule?.end, c.run_end_at.after)) set.runSchedule = c.run_end_at.after === null ? { start } : { start, end: Date.parse(c.run_end_at.after) };
  }
  if (c.total_budget) {
    if (!sameMoney(live.totalBudget, c.total_budget.before)) return drift("linkedin_ads_budget_drift", `The total budget of the ${who} is ${live.totalBudget ? `${live.totalBudget.currencyCode} ${live.totalBudget.amount}` : "not set"} now, not ${c.total_budget.before ? `${c.total_budget.before.currency} ${c.total_budget.before.amount}` : "unset"} as on this card, so Zavi did not change it.`);
    if (!sameMoney(live.totalBudget, c.total_budget.after)) {
      if (c.total_budget.after) set.totalBudget = { amount: c.total_budget.after.amount, currencyCode: c.total_budget.after.currency };
      else unset.push("totalBudget");
    }
  }
  if (!Object.keys(set).length && !unset.length) return { ok: true, notice: `The ${who} already had these settings in LinkedIn Ads.` };
  try {
    await withLinkedInAdsToken(d.tenant_id, (token) => patchLinkedInCampaignGroupWithToken(token, b.account_id, b.group_id, set, unset));
  } catch (e) {
    return refused(e, d.tenant_id, { campaign_id: b.group_id, name: b.name }, "campaign group edit");
  }
  return { ok: true, notice: `Edited the ${who} in LinkedIn Ads.` };
}

export async function executeLinkedInArchive(d: Exec): Promise<ChangeResult> {
  const p = linkedinArchiveBodySchema.safeParse(d.body);
  if (!p.success) return INVALID("archive");
  const b = p.data;
  const word = { campaign_group: "campaign group", campaign: "campaign", creative: "ad" }[b.target];
  const who = `${word} "${b.name}"`;
  const verb = b.mode === "delete" ? "delete" : "archive";
  if (b.target === "campaign") {
    const own = await ownCampaign(d.tenant_id, { campaign_id: b.id, account_id: b.account_id, name: b.name });
    if (!own.ok) return own.result;
    if (own.live.status === "ARCHIVED" && b.mode === "archive") return { ok: true, notice: `The ${who} was already archived.` };
    if (own.live.status === "PENDING_DELETION" || own.live.status === "REMOVED") return { ok: true, notice: `The ${who} was already deleted.` };
    if (own.live.status !== b.expected_status) return drift("linkedin_ads_status_drift", `The ${who} is ${own.live.status?.toLowerCase() ?? "in an unknown state"} now, not ${b.expected_status.toLowerCase()} as when this card was written, so Zavi did not ${verb} it.`);
    if (own.live.status === "ACTIVE") return drift("linkedin_ads_campaign_active", `The ${who} is running. Pause it first; Zavi never ${verb}s a running campaign.`);
  } else {
    const inUse = await accountInUse(d.tenant_id, b.account_id, `${verb} the ${who}`);
    if (inUse) return inUse;
    let status: string | null;
    try {
      status = await withLinkedInAdsToken(d.tenant_id, async (token) => {
        if (b.target === "campaign_group") {
          const g = await readLinkedInRawCampaignGroupWithToken(token, b.account_id, b.id);
          if (!g) return null;
          if (g.backfilled) throw new ExpectedToolError("linkedin_ads_default_group", `The ${who} is the account's default group, which LinkedIn does not let anyone archive or delete.`);
          if (g.status === "ACTIVE") throw new ExpectedToolError("linkedin_ads_group_active", `The ${who} is running. Pause it first; Zavi never ${verb}s a running campaign group.`);
          return g.status ?? null;
        }
        const c = await readLinkedInRawCreativeWithToken(token, b.account_id, b.id);
        if (!c) return null;
        if (b.campaign_id && c.campaign !== `urn:li:sponsoredCampaign:${b.campaign_id}`) return null;
        if (c.intendedStatus === "ACTIVE") throw new ExpectedToolError("linkedin_ads_ad_active", `The ${who} is on. Turn it off first; Zavi never ${verb}s an ad that is on.`);
        return c.intendedStatus ?? null;
      });
    } catch (e) {
      return e instanceof ExpectedToolError ? { ok: false, code: e.code, error: e.message } : accountFailed(e);
    }
    if (status === null) return drift("linkedin_ads_campaign_not_found", `LinkedIn could not find the ${who} in the account on this card, so Zavi did not change anything.`);
    if (status === "ARCHIVED" && b.mode === "archive") return { ok: true, notice: `The ${who} was already archived.` };
    if (status === "PENDING_DELETION" || status === "REMOVED") return { ok: true, notice: `The ${who} was already deleted.` };
    if (status !== b.expected_status) return drift("linkedin_ads_status_drift", `The ${who} is ${status?.toLowerCase() ?? "in an unknown state"} now, not ${b.expected_status.toLowerCase()} as when this card was written, so Zavi did not ${verb} it.`);
  }
  try {
    await withLinkedInAdsToken(d.tenant_id, (token) => archiveLinkedInEntityWithToken(token, b.account_id, b.target, b.id, b.mode));
  } catch (e) {
    return refused(e, d.tenant_id, { campaign_id: b.id, name: b.name }, verb);
  }
  return { ok: true, notice: `${b.mode === "delete" ? "Deleted" : "Archived"} the ${who} in LinkedIn Ads.` };
}

const liveAds = (ads: LiRawCreative[]) => ads.filter((a) => a.intendedStatus === "ACTIVE");

export async function executeLinkedInAdStatus(d: Exec): Promise<ChangeResult> {
  const p = linkedinAdStatusBodySchema.safeParse(d.body);
  if (!p.success) return INVALID("ad status");
  const b = p.data;
  const own = await ownCampaign(d.tenant_id, { campaign_id: b.campaign_id, account_id: b.account_id, name: b.campaign_name });
  if (!own.ok) return own.result;
  const who = `ad "${b.ad_name}"`;
  let ads: Array<LiRawCreative & { creative_id: string }>;
  try {
    ads = await withLinkedInAdsToken(d.tenant_id, (token) => listLinkedInRawCreativesWithToken(token, b.account_id, b.campaign_id));
  } catch (e) {
    return accountFailed(e);
  }
  const ad = ads.find((a) => a.creative_id === b.creative_id);
  if (!ad) return drift("linkedin_ads_ad_not_found", `LinkedIn could not find the ${who} in the campaign "${b.campaign_name}", so Zavi did not change anything.`);
  if (ad.intendedStatus === b.status) return { ok: true, notice: `The ${who} was already ${b.status === "ACTIVE" ? "on" : "off"}.` };
  if (ad.intendedStatus !== b.expected_status) return drift("linkedin_ads_status_drift", `The ${who} is ${ad.intendedStatus?.toLowerCase() ?? "in an unknown state"} now, not ${b.expected_status.toLowerCase()} as when this card was written, so Zavi did not change it.`);
  if (b.status === "PAUSED" && own.live.status === "ACTIVE" && liveAds(ads).length <= 1)
    return drift("linkedin_ads_last_live_ad", `The ${who} is the only ad that is on in the running campaign "${b.campaign_name}". Turning it off would leave the campaign with nothing to show, so Zavi did not change it. Add another ad first, or pause the campaign.`);
  try {
    await withLinkedInAdsToken(d.tenant_id, (token) => setLinkedInCreativeStatusWithToken(token, b.account_id, b.creative_id, b.status));
  } catch (e) {
    return refused(e, d.tenant_id, { campaign_id: b.creative_id, name: b.ad_name }, b.status === "ACTIVE" ? "switch on" : "switch off");
  }
  return { ok: true, notice: `Turned the ${who} ${b.status === "ACTIVE" ? "on" : "off"} in LinkedIn Ads.` };
}

const sourceRef = (s: LinkedInAdSource) => (s.kind === "post" ? s.post_urn : null);

async function createAd(token: string, account_id: string, campaign_id: string, associated_entity: string, source: LinkedInAdSource, intendedStatus: "ACTIVE" | "PAUSED"): Promise<string> {
  return source.kind === "post"
    ? createLinkedInCreativeFromPostWithToken(token, account_id, campaign_id, source.post_urn, intendedStatus)
    : createLinkedInInlineCreativeWithToken(token, account_id, campaign_id, associated_entity, source, intendedStatus);
}

export async function executeLinkedInCreateAd(d: Exec): Promise<ChangeResult> {
  const p = linkedinCreateAdBodySchema.safeParse(d.body);
  if (!p.success) return INVALID("new ad");
  const b = p.data;
  const own = await ownCampaign(d.tenant_id, { campaign_id: b.campaign_id, account_id: b.account_id, name: b.campaign_name });
  if (!own.ok) return own.result;
  const who = quoted(b.campaign_name);
  if (own.live.status && ENDED.has(own.live.status)) return drift("linkedin_ads_campaign_ended", `LinkedIn shows ${who} as ${own.live.status.toLowerCase()}, so no ad was added.`);
  if ((own.live as { associatedEntity?: string }).associatedEntity !== b.associated_entity) return drift("linkedin_ads_page_drift", `The company page behind ${who} changed in LinkedIn after this card was written, so no ad was added.`);
  let ads: Array<LiRawCreative & { creative_id: string }>;
  try {
    ads = await withLinkedInAdsToken(d.tenant_id, (token) => listLinkedInRawCreativesWithToken(token, b.account_id, b.campaign_id));
  } catch (e) {
    return accountFailed(e);
  }
  const ref = sourceRef(b.source);
  const dup = ref ? ads.find((a) => a.content?.reference === ref && a.intendedStatus !== "PENDING_DELETION" && a.intendedStatus !== "ARCHIVED") : undefined;
  if (dup) return { ok: true, notice: `${who} already has this post as an ad (ad ${dup.creative_id}), so Zavi did not add it again.` };
  const counted = ads.filter((a) => a.intendedStatus !== "PENDING_DELETION" && a.intendedStatus !== "ARCHIVED").length;
  if (counted !== b.expected_ad_count) return drift("linkedin_ads_ad_count_drift", `${who} has ${counted} ${counted === 1 ? "ad" : "ads"} now, not ${b.expected_ad_count} as when this card was written, so Zavi did not add one. Ask for it again.`);
  if (ads.length >= 100) return drift("linkedin_ads_ad_limit", `${who} already has 100 ads, LinkedIn's limit per campaign, so Zavi could not add one.`);
  let id: string;
  try {
    id = await withLinkedInAdsToken(d.tenant_id, (token) => createAd(token, b.account_id, b.campaign_id, b.associated_entity, b.source, b.go_live ? "ACTIVE" : "PAUSED"));
  } catch (e) {
    return refused(e, d.tenant_id, { campaign_id: b.campaign_id, name: b.campaign_name }, "new ad");
  }
  return { ok: true, notice: `Added ad ${id} to ${who} in LinkedIn Ads, ${b.go_live ? "switched on; it serves once LinkedIn's review passes" : "paused"}.` };
}

export async function executeLinkedInSwapAd(d: Exec): Promise<ChangeResult> {
  const p = linkedinSwapAdBodySchema.safeParse(d.body);
  if (!p.success) return INVALID("ad swap");
  const b = p.data;
  const own = await ownCampaign(d.tenant_id, { campaign_id: b.campaign_id, account_id: b.account_id, name: b.campaign_name });
  if (!own.ok) return own.result;
  const who = quoted(b.campaign_name);
  if (own.live.status && ENDED.has(own.live.status)) return drift("linkedin_ads_campaign_ended", `LinkedIn shows ${who} as ${own.live.status.toLowerCase()}, so nothing was swapped.`);
  if ((own.live as { associatedEntity?: string }).associatedEntity !== b.associated_entity) return drift("linkedin_ads_page_drift", `The company page behind ${who} changed in LinkedIn after this card was written, so nothing was swapped.`);
  let ads: Array<LiRawCreative & { creative_id: string }>;
  try {
    ads = await withLinkedInAdsToken(d.tenant_id, (token) => listLinkedInRawCreativesWithToken(token, b.account_id, b.campaign_id));
  } catch (e) {
    return accountFailed(e);
  }
  const old = ads.find((a) => a.creative_id === b.old_creative_id);
  if (!old) return drift("linkedin_ads_ad_not_found", `LinkedIn could not find the ad "${b.old_ad_name}" in ${who}, so nothing was swapped.`);
  if (old.intendedStatus !== "ACTIVE") return drift("linkedin_ads_status_drift", `The ad "${b.old_ad_name}" is ${old.intendedStatus?.toLowerCase() ?? "in an unknown state"} now, not on as when this card was written, so nothing was swapped.`);
  const ref = sourceRef(b.source);
  const existing = ref ? ads.find((a) => a.content?.reference === ref && a.creative_id !== b.old_creative_id && a.intendedStatus !== "PENDING_DELETION" && a.intendedStatus !== "ARCHIVED") : undefined;
  if (ads.length >= 100 && !existing) return drift("linkedin_ads_ad_limit", `${who} already has 100 ads, LinkedIn's limit per campaign, so Zavi could not add the replacement.`);
  let created: string;
  try {
    created = await withLinkedInAdsToken(d.tenant_id, async (token) => {
      if (existing) {
        if (existing.intendedStatus !== "ACTIVE") await setLinkedInCreativeStatusWithToken(token, b.account_id, existing.creative_id, "ACTIVE");
        return existing.creative_id;
      }
      return createAd(token, b.account_id, b.campaign_id, b.associated_entity, b.source, "ACTIVE");
    });
  } catch (e) {
    return refused(e, d.tenant_id, { campaign_id: b.campaign_id, name: b.campaign_name }, "replacement ad");
  }
  try {
    await withLinkedInAdsToken(d.tenant_id, (token) => setLinkedInCreativeStatusWithToken(token, b.account_id, b.old_creative_id, "PAUSED"));
  } catch (e) {
    const r = await refused(e, d.tenant_id, { campaign_id: b.old_creative_id, name: b.old_ad_name }, "switch off");
    return { ...r, code: "exec_partial", error: `The new ad ${created} is on in ${who}, but the old ad "${b.old_ad_name}" could not be turned off: ${r.error} Turn it off in Campaign Manager or ask Zavi again.` };
  }
  return { ok: true, notice: `Replaced the ad "${b.old_ad_name}" in ${who}: new ad ${created} is on, the old one is off.` };
}

export async function executeLinkedInCreateCampaign(d: Exec): Promise<ChangeResult> {
  const p = linkedinCreateCampaignBodySchema.safeParse(d.body);
  if (!p.success) return INVALID("new campaign");
  const b = p.data;
  const who = `campaign "${b.name}"`;
  const inUse = await accountInUse(d.tenant_id, b.account_id, `create the ${who}`);
  if (inUse) return inUse;
  if (b.daily_budget.currency !== b.unit_cost.currency || !(Number(b.unit_cost.amount) > 0)) return INVALID("new campaign");
  let hold: AdSpendHold = { status: "no_budget" };
  try {
    const out = await withLinkedInAdsToken(d.tenant_id, async (token): Promise<ChangeResult> => {
      const group = await readLinkedInRawCampaignGroupWithToken(token, b.account_id, b.group_id);
      if (!group) return drift("linkedin_ads_group_not_found", `LinkedIn could not find the campaign group "${b.group_name}" in the account on this card, so nothing was created.`);
      if (group.status !== b.expected_group_status) return drift("linkedin_ads_status_drift", `The campaign group "${b.group_name}" is ${group.status?.toLowerCase() ?? "in an unknown state"} now, not ${b.expected_group_status.toLowerCase()} as when this card was written, so nothing was created.`);
      if (group.status && ENDED.has(group.status)) return drift("linkedin_ads_group_ended", `The campaign group "${b.group_name}" is ${group.status.toLowerCase()}, so nothing was created.`);
      const siblings = await listLinkedInRawCampaignsInGroupWithToken(token, b.account_id, b.group_id);
      const same = siblings.find((c) => c.name === b.name && c.status !== "ARCHIVED" && c.status !== "PENDING_DELETION");
      let campaign_id = same ? String(same.id) : null;
      if (same && same.status !== "PAUSED" && same.status !== "DRAFT") return drift("linkedin_ads_name_taken", `The campaign group "${b.group_name}" already has a ${same.status?.toLowerCase() ?? ""} ${who}, so Zavi did not create a second one.`);
      if (d.approved_by_source === "cgo") {
        const held = await holdLinkedInSpend(d, { op: "create", object_id: campaign_id, cents: minor(b.daily_budget.amount), currency: b.daily_budget.currency });
        if (!held.ok) return held.result;
        hold = held.hold;
      }
      if (!campaign_id) {
        const targeting = linkedinCampaignTargeting({ name: b.name, daily_budget: b.daily_budget, unit_cost: b.unit_cost, geo_urns: b.geo_urns, excluded_geo_urns: b.excluded_geo_urns, country: b.country, language: b.language, associated_entity: b.associated_entity, audience: b.audience as never });
        const locale = b.language === "en" ? { country: "US", language: "en" } : { country: b.country, language: b.language };
        campaign_id = await createLinkedInCampaignInGroupWithToken(token, b.account_id, b.group_id, {
          name: b.name,
          type: "SPONSORED_UPDATES",
          ...(b.objective_type ? { objectiveType: b.objective_type } : {}),
          associatedEntity: b.associated_entity,
          politicalIntent: "NOT_DECLARED",
          costType: "CPC",
          creativeSelection: "OPTIMIZED",
          dailyBudget: { amount: b.daily_budget.amount, currencyCode: b.daily_budget.currency },
          unitCost: { amount: b.unit_cost.amount, currencyCode: b.unit_cost.currency },
          locale,
          runSchedule: { start: Date.now() },
          audienceExpansionEnabled: false,
          offsiteDeliveryEnabled: false,
          targetingCriteria: targeting,
        });
      }
      await commitAdSpend(hold, campaign_id);
      if (!b.post_urn) return { ok: true, notice: `Created the ${who} paused in "${b.group_name}" (campaign ${campaign_id}), with no ad yet.` };
      const ads = await listLinkedInRawCreativesWithToken(token, b.account_id, campaign_id);
      const has = ads.some((a) => a.content?.reference === b.post_urn);
      if (!has) {
        try {
          await createLinkedInCreativeFromPostWithToken(token, b.account_id, campaign_id, b.post_urn, "PAUSED");
        } catch (e) {
          const r = await refused(e, d.tenant_id, { campaign_id, name: b.name }, "ad");
          return { ...r, error: `The ${who} was created paused in "${b.group_name}" (campaign ${campaign_id}), but LinkedIn refused its ad: ${r.error} Approve again to add the ad, or add one in Campaign Manager.` };
        }
      }
      return { ok: true, notice: `Created the ${who} paused in "${b.group_name}" (campaign ${campaign_id}) with a paused ad for ${b.post_urn}.` };
    });
    return out;
  } catch (e) {
    await settleAdSpendAfterError(hold, e);
    return refused(e, d.tenant_id, { campaign_id: b.group_id, name: b.name }, "new campaign");
  }
}

async function walletCampaignIn(tenant_id: string, campaigns: LiRawCampaign[]): Promise<string | null> {
  const { findCampaignBinding } = await import("@/services/ads-wallet/bindings");
  for (const c of campaigns) {
    if (c.status === "ARCHIVED" || c.status === "PENDING_DELETION" || c.status === "CANCELED") continue;
    const bound = await findCampaignBinding(tenant_id, "linkedin", String(c.id));
    if (bound?.funding_source === "wallet") return c.name ?? String(c.id);
  }
  return null;
}

async function partialCopy(e: unknown, tenant_id: string, b: { source_id: string; source_name: string }, done: string): Promise<ChangeResult> {
  await refused(e, tenant_id, { campaign_id: b.source_id, name: b.source_name }, "copy");
  const why = e instanceof ExpectedToolError ? e.message : "LinkedIn Ads did not confirm it.";
  return { ok: false, code: "exec_partial", error: `${done}: ${why} Zavi will not copy it again; finish the copy in Campaign Manager, or archive it and ask again.`.slice(0, 600) };
}

export async function executeLinkedInDuplicate(d: Exec): Promise<ChangeResult> {
  const p = linkedinDuplicateBodySchema.safeParse(d.body);
  if (!p.success) return INVALID("copy");
  const b = p.data;
  const word = { campaign_group: "campaign group", campaign: "campaign", creative: "ad" }[b.target];
  const who = `${word} "${b.source_name}"`;
  const inUse = await accountInUse(d.tenant_id, b.account_id, `copy the ${who}`);
  if (inUse) return inUse;
  if (b.target === "campaign") {
    const own = await ownCampaign(d.tenant_id, { campaign_id: b.source_id, account_id: b.account_id, name: b.source_name });
    if (!own.ok) return own.result;
  }
  try {
    return await withLinkedInAdsToken(d.tenant_id, async (token): Promise<ChangeResult> => {
      if (b.target === "creative") {
        if (!b.campaign_id) return INVALID("copy");
        const ads = await listLinkedInRawCreativesWithToken(token, b.account_id, b.campaign_id);
        const src = ads.find((a) => a.creative_id === b.source_id);
        if (!src) return drift("linkedin_ads_ad_not_found", `LinkedIn could not find the ${who} in its campaign, so nothing was copied.`);
        if (!sameStamp(src.changeAuditStamps?.lastModified?.time, b.source_last_modified_at)) return drift("linkedin_ads_source_drift", `The ${who} was edited in LinkedIn after this card was written, so nothing was copied.`);
        if (!src.content?.reference) return drift("linkedin_ads_copy_unsupported", `The ${who} has no post Zavi can reuse, so it cannot be copied through Zavi.`);
        if (ads.some((a) => a.name === b.new_name)) return { ok: true, notice: `An ad named "${b.new_name}" already exists in that campaign, so Zavi did not copy it again.` };
        const id = await createLinkedInCreativeFromPostWithToken(token, b.account_id, b.campaign_id, src.content.reference, "PAUSED", b.new_name);
        return { ok: true, notice: `Copied the ${who} as "${b.new_name}" (ad ${id}), paused.` };
      }
      if (b.target === "campaign") {
        const src = await readLinkedInRawCampaignWithToken(token, b.account_id, b.source_id);
        if (!src) return drift("linkedin_ads_campaign_not_found", `LinkedIn could not find the ${who}, so nothing was copied.`);
        if (!sameStamp(src.changeAuditStamps?.lastModified?.time, b.source_last_modified_at)) return drift("linkedin_ads_source_drift", `The ${who} was edited in LinkedIn after this card was written, so nothing was copied.`);
        const group_id = b.group_id ?? (/^urn:li:sponsoredCampaignGroup:(\d{1,20})$/.exec(String((src as { campaignGroup?: string }).campaignGroup ?? ""))?.[1] ?? null);
        if (!group_id) return drift("linkedin_ads_group_not_found", `Zavi could not tell which campaign group the ${who} is in, so nothing was copied.`);
        const siblings = await listLinkedInRawCampaignsInGroupWithToken(token, b.account_id, group_id);
        const taken = siblings.find((c) => c.name === b.new_name && c.status !== "ARCHIVED" && c.status !== "PENDING_DELETION");
        if (taken) return { ok: true, notice: `A campaign named "${b.new_name}" already exists in that group (campaign ${String(taken.id)}), so Zavi did not copy it again.` };
        let hold: AdSpendHold = { status: "no_budget" };
        if (d.approved_by_source === "cgo") {
          const daily = src.dailyBudget;
          const held = await holdLinkedInSpend(d, { op: "create", object_id: null, cents: daily ? minor(daily.amount) : 0, currency: daily?.currencyCode ?? null });
          if (!held.ok) return held.result;
          hold = held.hold;
        }
        let id: string;
        try {
          id = await createLinkedInCampaignInGroupWithToken(token, b.account_id, group_id, linkedinCampaignCopyFields(src as Record<string, unknown>, b.new_name));
        } catch (e) {
          await settleAdSpendAfterError(hold, e);
          throw e;
        }
        await commitAdSpend(hold, id);
        let copied = 0;
        if (b.copy_ads) {
          try {
            const ads = await listLinkedInRawCreativesWithToken(token, b.account_id, b.source_id);
            for (const a of ads) {
              if (!a.content?.reference || a.intendedStatus === "ARCHIVED" || a.intendedStatus === "PENDING_DELETION") continue;
              await createLinkedInCreativeFromPostWithToken(token, b.account_id, id, a.content.reference, "PAUSED");
              copied += 1;
            }
          } catch (e) {
            return partialCopy(e, d.tenant_id, b, `The copy "${b.new_name}" was created paused (campaign ${id}) with ${copied} ${copied === 1 ? "ad" : "ads"}, but copying the rest of its ads failed`);
          }
        }
        return { ok: true, notice: `Copied the ${who} as "${b.new_name}" (campaign ${id}), paused${b.copy_ads ? `, with ${copied} paused ${copied === 1 ? "ad" : "ads"}` : ", without ads"}.` };
      }
      const src = await readLinkedInRawCampaignGroupWithToken(token, b.account_id, b.source_id);
      if (!src) return drift("linkedin_ads_group_not_found", `LinkedIn could not find the ${who}, so nothing was copied.`);
      if (!sameStamp(src.changeAuditStamps?.lastModified?.time, b.source_last_modified_at)) return drift("linkedin_ads_source_drift", `The ${who} was edited in LinkedIn after this card was written, so nothing was copied.`);
      const campaigns = await listLinkedInRawCampaignsInGroupWithToken(token, b.account_id, b.source_id);
      if (campaigns.length > 20) return drift("linkedin_ads_copy_too_big", `The ${who} holds ${campaigns.length} campaigns; Zavi copies groups of up to 20. Copy it in Campaign Manager.`);
      const wallet = await walletCampaignIn(d.tenant_id, campaigns);
      if (wallet) return { ok: false, code: "linkedin_ads_wallet_campaign", error: `The ${who} holds "${wallet}", which runs in Zavi's shared LinkedIn ad account and is paid from your Zavi wallet, so the group cannot be copied from here. Nothing was copied.` };
      const id = await createLinkedInCampaignGroupWithToken(token, b.account_id, { name: b.new_name, ...(src.totalBudget ? { totalBudget: src.totalBudget } : {}) });
      let made = 0;
      try {
        for (const c of campaigns) {
          if (c.status === "ARCHIVED" || c.status === "PENDING_DELETION" || c.status === "CANCELED") continue;
          const cid = await createLinkedInCampaignInGroupWithToken(token, b.account_id, id, linkedinCampaignCopyFields(c as Record<string, unknown>, c.name ?? String(c.id)));
          made += 1;
          if (!b.copy_ads) continue;
          const ads = await listLinkedInRawCreativesWithToken(token, b.account_id, String(c.id));
          for (const a of ads) {
            if (!a.content?.reference || a.intendedStatus === "ARCHIVED" || a.intendedStatus === "PENDING_DELETION") continue;
            await createLinkedInCreativeFromPostWithToken(token, b.account_id, cid, a.content.reference, "PAUSED");
          }
        }
      } catch (e) {
        return partialCopy(e, d.tenant_id, b, `The copy "${b.new_name}" was created paused (group ${id}) with ${made} ${made === 1 ? "campaign" : "campaigns"}, but copying the rest failed`);
      }
      return { ok: true, notice: `Copied the ${who} as "${b.new_name}" (group ${id}), paused, with ${made} paused ${made === 1 ? "campaign" : "campaigns"}${b.copy_ads ? " and their ads" : " and no ads"}.` };
    });
  } catch (e) {
    return refused(e, d.tenant_id, { campaign_id: b.source_id, name: b.source_name }, "copy");
  }
}
