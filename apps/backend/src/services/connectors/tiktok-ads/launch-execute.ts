import { dailyHoldEndsOn } from "@/services/growth/ad-plan-shape";
import { cgoTestEndForRun, earlierEndDay } from "@/services/growth/cgo-test-end";
import { armCreatedTestStop } from "@/services/growth/test-stops";
import { adsNoFrictionEnabled } from "@/services/growth/ads-no-friction-flag";

import { ExpectedToolError } from "@/services/tools/types";
import { advancedGroupValues, advancedGroupMatches, verifyAdvancedGroup } from "./campaign-advanced";
import { assertSpendWritesOn } from "@/services/channels/lock";
import { commitAdSpend, dropAdSpendHold, noteAdSpendRef, reserveAdSpend, type AdSpendHold } from "@/services/decisions/ad-budget";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { recordZaviAdChange } from "@/services/decisions/ad-changes";
import type { CreatedObject } from "@/services/channels/created-object";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import { tiktokAdsAccount } from "./composio-read";
import { TIKTOK_CREATE_LAUNCH_CLASS } from "./held-schema";
import { verifyTiktokLocations } from "./locations";
import { normalizeTiktokAudience, tiktokAudienceMatches, verifyTiktokLanguages } from "./targeting";
import { claimLaunch, otherLaunchesExecuting, type LaunchClaim } from "./launch-claim";
import { findTaggedObjects, isDeleted, readLaunchObject, setLaunchStatus, tiktokPost, type LaunchLevel, type LaunchObject } from "./objects";
import { assertLandingUrl, readLaunchReadiness, readLaunchVideo, throwBlocker, uploadLaunchImage } from "./launch-readiness";
import { launchStore, type LaunchIds, type LaunchStore } from "./launch-store";
import {
  LAUNCH_MEASURED_LINE,
  LINK_TIKTOK_ACCOUNT_STEPS,
  floorRefusal,
  launchRefusal,
  launchState,
  scheduleStart,
  scheduleEnd,
  taggedLaunchName,
  tiktokLaunchBody,
  tiktokLaunchTag,
  videoRefusal,
  withLaunchUtm,
  type LaunchState,
  type TiktokLaunchBody,
} from "./launch-schema";

export type TiktokLaunchRow = {
  id: string;
  tenant_id: string;
  body: unknown;
  decision_class: string;
  approved_by?: string | null;
  approved_by_source?: string | null;
  exec_source?: string;
  agent_run_id?: string | null;
};

export type TiktokLaunchDetails = {
  action_id: string;
  execution_state: string;
  delivery_state: string;
  approval_required: boolean;
  external_ids?: Record<string, unknown>;
  failed_step?: string | null;
  failure_reason: string | null;
  next_recovery_step: string | null;
};

export type TiktokLaunchResult = {
  ok: boolean;
  code?: string;
  error?: string;
  notice?: string;
  outcome_unknown?: boolean;
  held_for_founder?: boolean;
  execution_details?: TiktokLaunchDetails;
  created?: CreatedObject;
};

const HELD_FOR_FOUNDER: ReadonlySet<string> = new Set([
  "tiktok_ads_approval_required",
  "tiktok_ads_admin_required",
  "tiktok_ads_founder_required",
  "tiktok_ads_autopilot_off",
  "tiktok_ads_policy_held",
  "tiktok_ads_budget_required",
]);
const PARTIAL: ReadonlySet<string> = new Set(["tiktok_ads_launch_verification_failed", "tiktok_ads_launch_duplicate", "tiktok_ads_launch_object_deleted"]);
const NEEDS_NEW_CARD: ReadonlySet<string> = new Set(["tiktok_ads_identity_unsupported"]);
const DEFINITE: ReadonlySet<string> = new Set(["tiktok_ads_write_refused", "tiktok_ads_rate_limited", "tiktok_ads_token_revoked", "tiktok_ads_payment_required", "tiktok_ads_identity_unsupported"]);

async function guard(d: TiktokLaunchRow): Promise<void> {
  await assertSpendWritesOn("tiktok_ads", "TikTok Ads", "tiktok_ads");
  if (d.approved_by_source === "cgo") {
    const { cgoAdBudget } = await import("@/services/growth/cgo-ads");
    if (!(await cgoAdBudget(d.tenant_id))) throw new ExpectedToolError("tiktok_ads_autopilot_off", "Autopilot or its ad budget is no longer active. This launch is waiting for the founder. Nothing was created.");
    const { authorizeUnattended } = await import("@/services/growth/unattended-policy");
    const verdict = await authorizeUnattended(
      d.tenant_id,
      { kind: "ad", exec_class: d.decision_class, payload: d.body, source: { table: d.exec_source === "decisions" ? "decisions" : "channel_actions", id: d.id, run_id: d.agent_run_id ?? null } },
      { where: "tiktok_ads_launch" },
    );
    if (verdict.verdict !== "allow") throw new ExpectedToolError("tiktok_ads_policy_held", `Founder review required: ${verdict.reasons.join(", ")}. Nothing was created.`);
    return;
  }
  if (d.approved_by_source === "staff" || !d.approved_by) {
    throw new ExpectedToolError("tiktok_ads_approval_required", "This TikTok launch needs a workspace owner's or admin's approval. Nothing was created.");
  }
  let role: string | null;
  try {
    role = await loadTenantRoleFor(d.approved_by, d.tenant_id);
  } catch {
    throw new ExpectedToolError("tiktok_ads_role_unavailable", "The approver's workspace role could not be checked. Nothing was created in TikTok; approve again in a minute.");
  }
  if (role !== "owner" && role !== "admin") {
    throw new ExpectedToolError("tiktok_ads_admin_required", "Only a workspace owner or admin can approve a TikTok launch. Nothing was created.");
  }
}

const cents = (n: number) => Math.round(n * 100);
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const LEVEL_WORD: Record<LaunchLevel, "campaign" | "ad group" | "ad"> = { campaign: "campaign", ad_group: "ad group", ad: "ad" };

export const launchTiming = {
  readbackWaitsMs: [1000, 2000, 4000] as number[],
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
};

class Attempt {
  ids: LaunchIds;
  campaignCreate: "none" | "refused" | "unknown" | "done" = "none";
  readback: Record<string, { operation_status: string | null; secondary_status: string | null }> = {};
  failedStep: string | null = null;
  fence: (() => Promise<void>) | null = null;
  timeZone = "UTC";
  testEndsOn: string | null = null;

  constructor(
    readonly d: TiktokLaunchRow,
    readonly b: TiktokLaunchBody,
    readonly account: OwnedComposioAccount,
    readonly store: LaunchStore,
    tag: string,
  ) {
    this.ids = { tag, advertiser_id: b.advertiser_id };
  }

  get tag(): string {
    return this.ids.tag;
  }

  async save(): Promise<void> {
    try {
      await this.store.save(this.ids);
    } catch (e) {
      console.error(`[tiktok-launch] ${this.d.id}: ids not saved (${(e as Error).message}); a retry finds them by tag ${this.tag}`);
    }
  }

  note(level: LaunchLevel, o: LaunchObject): void {
    this.readback[level] = { operation_status: o.operation_status, secondary_status: o.secondary_status };
  }

  async existing(level: LaunchLevel, savedId: string | null | undefined, campaignId?: string, adgroupId?: string): Promise<LaunchObject | null> {
    const adv = this.b.advertiser_id;
    if (savedId) {
      const o = await readLaunchObject(this.account, adv, level, savedId);
      if (o && isDeleted(o)) throw this.deleted(level, o.id);
      if (o) return o;
    }
    const found = (await findTaggedObjects(this.account, adv, level, this.tag, level === "campaign" ? undefined : campaignId)).filter(
      (o) => level === "campaign" || (o.campaign_id === campaignId && (level !== "ad" || o.adgroup_id === adgroupId)),
    );
    const live = found.filter((o) => !isDeleted(o));
    if (live.length > 1) {
      throw new ExpectedToolError("tiktok_ads_launch_duplicate", `TikTok has ${live.length} ${LEVEL_WORD[level]}s carrying this launch's tag ${this.tag}. Zavi will not pick one.`);
    }
    if (live.length === 1) return live[0];
    if (found.length) throw this.deleted(level, found[0].id);
    return null;
  }

  private deleted(level: LaunchLevel, id: string): ExpectedToolError {
    return new ExpectedToolError("tiktok_ads_launch_object_deleted", `The ${LEVEL_WORD[level]} ${id} this launch made was deleted in TikTok. Zavi does not make a replacement under the same card.`);
  }

  async readBack(level: LaunchLevel, id: string): Promise<LaunchObject> {
    let o: LaunchObject | null = null;
    for (let i = 0; ; i++) {
      try {
        o = await readLaunchObject(this.account, this.b.advertiser_id, level, id);
      } catch {
        o = null;
      }
      if (o || i >= launchTiming.readbackWaitsMs.length) break;
      await launchTiming.sleep(launchTiming.readbackWaitsMs[i]);
    }
    if (!o) throw new ExpectedToolError("tiktok_ads_outcome_unknown", `TikTok did not confirm the ${LEVEL_WORD[level]} ${id}.`);
    this.note(level, o);
    return o;
  }

  createdId(data: Record<string, unknown>, key: string, level: LaunchLevel): string {
    const v = data[key];
    const id = Array.isArray(v) ? str(v[0]) : str(v);
    if (!id) throw new ExpectedToolError("tiktok_ads_outcome_unknown", `TikTok answered the ${LEVEL_WORD[level]} create without its id; it may exist.`);
    return id;
  }

  async secure(): Promise<boolean> {
    const adv = this.b.advertiser_id;
    if (!this.ids.campaign_id) {
      if (this.campaignCreate === "none" || this.campaignCreate === "refused") return true;
      try {
        const live = (await findTaggedObjects(this.account, adv, "campaign", this.tag)).filter((o) => !isDeleted(o));
        if (live.length !== 1) return false;
        this.ids.campaign_id = live[0].id;
        await this.save();
      } catch {
        return false;
      }
    }
    const id = this.ids.campaign_id;
    const off = async () => {
      try {
        const o = await readLaunchObject(this.account, adv, "campaign", id);
        if (o) this.note("campaign", o);
        return !!o && (o.operation_status === "DISABLE" || isDeleted(o));
      } catch {
        return false;
      }
    };
    if (await off()) return true;
    try {
      await setLaunchStatus(this.account, adv, "campaign", id, "DISABLE");
    } catch (e) {
      console.warn(`[tiktok-launch] ${this.d.id}: switching campaign ${id} off failed: ${(e as Error).message}`);
    }
    return off();
  }
}

function translateRefusal(e: unknown, step: "campaign" | "ad_group" | "ad" | "image"): unknown {
  if (!(e instanceof ExpectedToolError) || e.code !== "tiktok_ads_write_refused") return e;
  const msg = String(e.meta?.tiktok_message ?? e.message);
  if (/complete payment/i.test(msg)) {
    return launchRefusal("tiktok_ads_payment_required", `TikTok refused the launch: "${msg}".`, "add a payment method in TikTok Ads Manager (Payments), then approve again.");
  }
  if (step === "ad" && /custom identit/i.test(msg)) {
    return launchRefusal("tiktok_ads_identity_unsupported", `TikTok refused the ad: "${msg}".`, `${LINK_TIKTOK_ACCOUNT_STEPS} Then ask Zavi for a new launch card.`);
  }
  return e;
}

async function build(a: Attempt): Promise<{ campaign: string; adgroup: string; ad: string }> {
  const { b, account, tag } = a;
  const adv = b.advertiser_id;

  if (!a.ids.image_id) {
    a.failedStep = "image";
    const video = await readLaunchVideo(account, adv, b.video.video_id);
    if (!video?.cover_url) throw launchRefusal("tiktok_ads_video_unreadable", "TikTok has not made the video's cover yet.", "approve again in a minute.");
    try {
      a.ids.image_id = await uploadLaunchImage(account, adv, video.cover_url, `${tag}-cover`);
    } catch (e) {
      throw translateRefusal(e, "image");
    }
    await a.save();
  }

  a.failedStep = "campaign";
  let campaign = await a.existing("campaign", a.ids.campaign_id);
  if (campaign) {
    a.campaignCreate = "done";
  } else {
    a.campaignCreate = "unknown";
    let data: Record<string, unknown>;
    try {
      data = await tiktokPost(account, "/campaign/create/", { advertiser_id: adv, campaign_name: taggedLaunchName(b.name, "campaign", tag), objective_type: b.campaign_type, budget_mode: "BUDGET_MODE_INFINITE", operation_status: "DISABLE" });
    } catch (e) {
      if (e instanceof ExpectedToolError && DEFINITE.has(e.code)) a.campaignCreate = "refused";
      throw translateRefusal(e, "campaign");
    }
    a.ids.campaign_id = a.createdId(data, "campaign_id", "campaign");
    a.campaignCreate = "done";
    await a.save();
    campaign = await a.readBack("campaign", a.ids.campaign_id);
    if (campaign.operation_status !== "DISABLE") throw mismatch("campaign", campaign.id, "was not created switched off");
  }
  a.ids.campaign_id = campaign.id;
  a.note("campaign", campaign);
  if (campaign.raw.objective_type !== b.campaign_type || campaign.raw.budget_mode !== "BUDGET_MODE_INFINITE") {
    throw mismatch("campaign", campaign.id, `reads ${String(campaign.raw.objective_type)} / ${String(campaign.raw.budget_mode)}, not ${b.campaign_type} with no budget of its own`);
  }

  a.failedStep = "ad_group";
  let group = await a.existing("ad_group", a.ids.adgroup_id, campaign.id);
  const groupReused = !!group;
  let createdStart: string | undefined;
  if (!group) {
    let data: Record<string, unknown>;
    createdStart = scheduleStart(b.start_time, new Date(), a.timeZone);
    try {
      data = await tiktokPost(account, "/adgroup/create/", {
        advertiser_id: adv,
        campaign_id: campaign.id,
        adgroup_name: taggedLaunchName(b.name, "ad group", tag),
        promotion_type: "WEBSITE",
        placement_type: "PLACEMENT_TYPE_NORMAL",
        placements: ["PLACEMENT_TIKTOK"],
        location_ids: b.locations.map((l) => l.location_id),
        ...normalizeTiktokAudience(b),
        budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
        budget: Math.round(b.daily_budget_usd * 100) / 100,
        ...(b.end_date
          ? { schedule_type: "SCHEDULE_START_END", schedule_start_time: createdStart, schedule_end_time: scheduleEnd(b.end_date, a.timeZone) }
          : { schedule_type: "SCHEDULE_FROM_NOW", schedule_start_time: createdStart }),
        optimization_goal: "CLICK",
        billing_event: "CPC",
        bid_type: "BID_TYPE_NO_BID",
        pacing: "PACING_MODE_SMOOTH",
        ...advancedGroupValues(b),
        operation_status: "DISABLE",
      });
    } catch (e) {
      throw translateRefusal(e, "ad_group");
    }
    a.ids.adgroup_id = a.createdId(data, "adgroup_id", "ad_group");
    await a.save();
    group = await a.readBack("ad_group", a.ids.adgroup_id);
    if (group.operation_status !== "DISABLE") throw mismatch("ad_group", group.id, "was not created switched off");
  }
  a.ids.adgroup_id = group.id;
  a.note("ad_group", group);
  const liveBudget = Number(group.raw.budget);
  const liveLocations = Array.isArray(group.raw.location_ids) ? group.raw.location_ids.map(String).sort() : [];
  const wantLocations = b.locations.map((l) => l.location_id).sort();
  if (group.campaign_id !== campaign.id || group.raw.budget_mode !== "BUDGET_MODE_DYNAMIC_DAILY_BUDGET" || !Number.isFinite(liveBudget) || cents(liveBudget) !== cents(b.daily_budget_usd) || JSON.stringify(liveLocations) !== JSON.stringify(wantLocations)) {
    throw mismatch("ad_group", group.id, `reads a ${String(group.raw.budget_mode)} budget of ${String(group.raw.budget)} in ${liveLocations.join(",") || "no location"}, not ${usd(b.daily_budget_usd)} a day in ${wantLocations.join(",")}`);
  }
  if (createdStart && group.raw.schedule_start_time !== createdStart) throw mismatch("ad_group", group.id, "the UTC start differs from the requested instant");
  if (a.testEndsOn) {
    const wantEnd = scheduleEnd(a.testEndsOn, a.timeZone);
    const gotEnd = String(group.raw.schedule_end_time ?? "");
    const endOk = groupReused ? gotEnd !== "" && gotEnd <= wantEnd && gotEnd > scheduleStart(new Date().toISOString(), new Date(), a.timeZone) : gotEnd === wantEnd;
    if (group.raw.schedule_type !== "SCHEDULE_START_END" || !endOk) {
      throw new ExpectedToolError("tiktok_ads_test_end_unverified", `TikTok reads the ad group ${group.id}'s end as ${String(group.raw.schedule_end_time ?? "none")}, not ${wantEnd}, so this test was not switched on.`);
    }
  }

  if (!a.testEndsOn && b.end_date && (group.raw.schedule_type !== "SCHEDULE_START_END" || group.raw.schedule_end_time !== scheduleEnd(b.end_date, a.timeZone))) {
    throw mismatch("ad_group", group.id, "the UTC end differs from the approved end date");
  }

  if (!tiktokAudienceMatches(group.raw, b)) {
    throw mismatch("ad_group", group.id, "audience age groups, gender or languages differ from the approved card");
  }
  if (!advancedGroupMatches(group.raw, advancedGroupValues(b))) throw mismatch("ad_group", group.id, "advanced targeting, schedule, interaction or bidding settings differ from the approved card");

  a.failedStep = "ad";
  let ad = await a.existing("ad", a.ids.ad_id, campaign.id, group.id);
  const reusedAd = !!ad;
  if (!ad) {
    let data: Record<string, unknown>;
    try {
      data = await tiktokPost(account, "/ad/create/", {
        advertiser_id: adv,
        adgroup_id: group.id,
        creatives: [
          {
            ad_name: taggedLaunchName(b.name, "ad", tag),
            identity_type: b.identity.identity_type,
            identity_id: b.identity.identity_id,
            ...(b.identity.identity_authorized_bc_id ? { identity_authorized_bc_id: b.identity.identity_authorized_bc_id } : {}),
            ad_format: "SINGLE_VIDEO",
            video_id: b.video.video_id,
            image_ids: [a.ids.image_id],
            ad_text: b.ad_text,
            call_to_action: b.call_to_action,
            landing_page_url: withLaunchUtm(b.landing_url, tag),
            operation_status: "DISABLE",
          },
        ],
      });
    } catch (e) {
      throw translateRefusal(e, "ad");
    }
    a.ids.ad_id = a.createdId(data, "ad_ids", "ad");
    await a.save();
    ad = await a.readBack("ad", a.ids.ad_id);
    if (ad.operation_status !== "DISABLE") throw mismatch("ad", ad.id, "was not created switched off");
  }
  a.ids.ad_id = ad.id;
  a.note("ad", ad);
  if (ad.adgroup_id !== group.id) throw mismatch("ad", ad.id, `sits under ad group ${String(ad.adgroup_id)}, not ${group.id}`);
  if (reusedAd) {
    const want = { video_id: b.video.video_id, identity_id: b.identity.identity_id, landing_page_url: withLaunchUtm(b.landing_url, tag), ad_text: b.ad_text, call_to_action: b.call_to_action };
    const off = (Object.keys(want) as Array<keyof typeof want>).filter((k) => String(ad!.raw[k] ?? "") !== want[k]);
    if (off.length) throw mismatch("ad", ad.id, `no longer matches the approved card (${off.join(", ")} changed)`);
  }
  return { campaign: campaign.id, adgroup: group.id, ad: ad.id };
}

function mismatch(level: LaunchLevel, id: string, what: string): ExpectedToolError {
  return new ExpectedToolError("tiktok_ads_launch_verification_failed", `TikTok's ${LEVEL_WORD[level]} ${id} ${what}.`);
}

async function switchOn(a: Attempt, made: { campaign: string; adgroup: string; ad: string }): Promise<LaunchState> {
  const adv = a.b.advertiser_id;
  for (const [level, id] of [["ad", made.ad], ["ad_group", made.adgroup], ["campaign", made.campaign]] as const) {
    a.failedStep = `enable_${level}`;
    await a.fence?.();
    await setLaunchStatus(a.account, adv, level, id, "ENABLE");
  }
  a.failedStep = "final_readback";
  const objs = [await a.readBack("campaign", made.campaign), await a.readBack("ad_group", made.adgroup), await a.readBack("ad", made.ad)];
  const notOn = objs.filter((o) => o.operation_status !== "ENABLE");
  if (notOn.length) {
    throw new ExpectedToolError("tiktok_ads_outcome_unknown", `TikTok reads ${notOn.map((o) => `the ${LEVEL_WORD[o.level]} as ${o.operation_status ?? "unreadable"}`).join(" and ")} after the switch-on.`);
  }
  return launchState({ campaign: objs[0].secondary_status, ad_group: objs[1].secondary_status, ad: objs[2].secondary_status });
}

function details(a: Attempt | null, d: TiktokLaunchRow, state: string, hold: AdSpendHold, failure: string | null, next: string | null): TiktokLaunchDetails {
  return {
    action_id: d.id,
    execution_state: state,
    delivery_state: state === "live" ? "delivering" : "unconfirmed",
    approval_required: false,
    external_ids: a
      ? {
          tag: a.ids.tag,
          advertiser_id: a.ids.advertiser_id,
          campaign_id: a.ids.campaign_id ?? null,
          adgroup_id: a.ids.adgroup_id ?? null,
          ad_id: a.ids.ad_id ?? null,
          video_id: a.b.video.video_id,
          image_id: a.ids.image_id ?? null,
          landing_url: withLaunchUtm(a.b.landing_url, a.ids.tag),
          readback: a.readback,
          hold: hold.status === "held" ? { status: "held", idem_key: hold.idem_key } : { status: hold.status },
        }
      : undefined,
    failed_step: a?.failedStep ?? null,
    failure_reason: failure,
    next_recovery_step: next,
  };
}

const STATE_LINE: Record<Exclude<LaunchState, "disapproved">, (b: TiktokLaunchBody) => string> = {
  live: () => "TikTok reports it delivering.",
  pending_review: () => "TikTok is reviewing the ad; it starts on its own when TikTok approves it.",
  scheduled: (b) => `It is switched on and starts on its own from ${b.start_time}.`,
  on_unconfirmed: () => "It is switched on, but TikTok has not reported it delivering yet.",
};

const onOffWord = (op: string | null) => (op === "ENABLE" ? "ACTIVE" : op === "DISABLE" ? "PAUSED" : null);

async function recordLaunch(d: TiktokLaunchRow, b: TiktokLaunchBody, made: { campaign: string; adgroup: string }, before: { campaign: string | null; ad_group: string | null }): Promise<void> {
  const from = { table: d.exec_source === "decisions" ? ("decisions" as const) : ("channel_actions" as const), id: d.id };
  const base = { platform: "tiktok" as const, campaign_id: made.campaign, before_daily_usd: null, after_daily_usd: null };
  await recordZaviAdChange(d.tenant_id, from, { ...base, object_id: made.campaign, level: "campaign", object_name: taggedLaunchName(b.name, "campaign", tiktokLaunchTag(d.id)), change_kind: "status", before_status: onOffWord(before.campaign), after_status: "ACTIVE" });
  const group = { ...base, object_id: made.adgroup, level: "ad_group" as const, object_name: taggedLaunchName(b.name, "ad group", tiktokLaunchTag(d.id)) };
  await recordZaviAdChange(d.tenant_id, from, { ...group, change_kind: "status", before_status: onOffWord(before.ad_group), after_status: "ACTIVE" });
  await recordZaviAdChange(d.tenant_id, from, { ...group, change_kind: "budget", before_status: "ACTIVE", after_status: "ACTIVE", after_daily_usd: b.daily_budget_usd });
}

async function assertNoOtherLaunch(d: TiktokLaunchRow): Promise<void> {
  let others: string[];
  try {
    others = await otherLaunchesExecuting(d.tenant_id, d.id);
  } catch {
    throw new ExpectedToolError("tiktok_ads_launch_state_unreadable", "Zavi could not check whether another TikTok launch is under way, so nothing was created. Approve again in a minute.");
  }
  if (others.length) {
    throw new ExpectedToolError("tiktok_ads_launch_in_flight", `The TikTok launch card ${others[0]} is being carried out, so this launch created nothing and holds nothing. Approve again once it finishes.`);
  }
}

async function execute(d: TiktokLaunchRow): Promise<TiktokLaunchResult> {
  let claim: LaunchClaim | null = null;
  try {
    return await executeClaimed(d, (c) => (claim = c));
  } finally {
    await (claim as LaunchClaim | null)?.release();
  }
}

async function executeClaimed(d: TiktokLaunchRow, onClaim: (c: LaunchClaim) => void): Promise<TiktokLaunchResult> {
  let hold: AdSpendHold = { status: "no_budget" };
  let a: Attempt | null = null;
  let afterHold = false;
  try {
    if (d.decision_class !== TIKTOK_CREATE_LAUNCH_CLASS) throw new ExpectedToolError("tiktok_ads_action_unknown", "Unsupported TikTok Ads action.");
    const p = tiktokLaunchBody.safeParse(d.body);
    if (!p.success) throw new ExpectedToolError("tiktok_ads_body_invalid", "This TikTok launch card's body is invalid. Nothing was created.");
    let testEnd: Awaited<ReturnType<typeof cgoTestEndForRun>>;
    try {
      testEnd = await cgoTestEndForRun(d.tenant_id, d.agent_run_id, new Date());
    } catch {
      throw new ExpectedToolError("tiktok_ads_test_end_unreadable", "Zavi could not read this test's end date, so nothing new was created on this attempt. Approve again in a minute.");
    }
    const testEndsOn = testEnd && (await adsNoFrictionEnabled()) ? earlierEndDay(p.data.end_date, testEnd.ends_on) : null;
    const b = testEndsOn ? { ...p.data, end_date: testEndsOn } : p.data;
    if (b.budget_mode !== "BUDGET_MODE_DYNAMIC_DAILY_BUDGET") throw new ExpectedToolError("tiktok_ads_launch_review_required", "This older launch was reviewed as a fixed daily budget. TikTok Traffic now requires an average daily budget with up to 25% more delivery on a day. Create a new proposal and review that allowance before launching. Nothing was written.");
    if (testEndsOn && Date.parse(`${testEndsOn}T00:00:00Z`) <= Math.max(Date.parse(b.start_time), Date.now()) + 3_600_000) {
      throw new ExpectedToolError("tiktok_ads_end_invalid", `This test ends on ${testEndsOn}, before the ad could start. Nothing was created.`);
    }
    await guard(d);
    const tag = tiktokLaunchTag(d.id);
    const account = await tiktokAdsAccount(d.tenant_id);

    const r = await readLaunchReadiness(d.tenant_id, { advertiser_id: b.advertiser_id, videos: false });
    throwBlocker(r);
    scheduleStart(b.start_time, new Date(), r.advertiser!.timezone!);
    if (b.end_date) scheduleEnd(b.end_date, r.advertiser!.timezone!);
    if (!r.possible_campaign_types.includes(b.campaign_type)) {
      throw launchRefusal("tiktok_ads_campaign_type_unsupported", `Zavi cannot launch a ${b.campaign_type} campaign on TikTok.`, `propose one of: ${r.possible_campaign_types.join(", ")}.`);
    }
    const who = r.identities.find((i) => i.identity_id === b.identity.identity_id && i.identity_type === b.identity.identity_type && (i.identity_authorized_bc_id ?? undefined) === b.identity.identity_authorized_bc_id);
    if (!who) throw launchRefusal("tiktok_ads_no_identity", "The TikTok account this ad was to run as is no longer linked to the ad account.", LINK_TIKTOK_ACCOUNT_STEPS);
    const allowed = new Set(r.allowed_locations.map((l) => l.location_id));
    await verifyTiktokLocations(account, b.advertiser_id, b.locations.map((l) => l.location_id).filter((id) => !allowed.has(id)));
    await verifyTiktokLanguages(account, b.advertiser_id, b.languages ?? []);
    await verifyAdvancedGroup(account, b.advertiser_id, advancedGroupValues(b), { bid_type: "BID_TYPE_NO_BID" });
    const floor = floorRefusal(b.daily_budget_usd);
    if (floor) throw floor;
    await assertLandingUrl(b.landing_url);
    const video = await readLaunchVideo(account, b.advertiser_id, b.video.video_id);
    if (!video) throw launchRefusal("tiktok_ads_no_usable_video", "The video is no longer in the TikTok ad account's library.", "ask Zavi for a new launch card.");
    const bad = videoRefusal(video);
    if (bad) throw bad;
    const claim = await claimLaunch(d.tenant_id, b.advertiser_id, d.id);
    onClaim(claim);
    await assertNoOtherLaunch(d);

    const store = launchStore(d.tenant_id, d.id);
    const saved = await store.load().catch((e: Error) => {
      throw new ExpectedToolError("tiktok_ads_launch_store_unavailable", `Zavi could not read this launch's record (${e.message}). Nothing was created; approve again in a minute.`);
    });
    a = new Attempt(d, b, account, store, tag);
    a.fence = claim.verify;
    a.timeZone = r.advertiser!.timezone!;
    a.testEndsOn = testEndsOn;
    if (saved) {
      if (saved.tag !== tag || saved.advertiser_id !== b.advertiser_id) throw new ExpectedToolError("tiktok_ads_body_invalid", "This launch's record names another ad account. Nothing was created.");
      Object.assign(a.ids, saved);
    }
    await store.save(a.ids).catch((e: Error) => {
      throw new ExpectedToolError("tiktok_ads_launch_store_unavailable", `Zavi could not record this launch (${e.message}). Nothing was created; approve again in a minute.`);
    });

    hold = await reserveAdSpend(d, { platform: "tiktok", op: "create", object_id: null, daily_delta_usd: b.daily_budget_usd, delivery_factor: 1.25, currency: "USD", paused: false, ...(b.end_date ? { ends_on: dailyHoldEndsOn(b.end_date) } : {}) });
    if (hold.status === "refused") throw new ExpectedToolError("tiktok_ads_budget_refused", hold.error);
    if (hold.status === "held" && hold.over_cap) await (await import("@/services/growth/ad-plan-yes")).askBudgetRaiseOnce(d.tenant_id, null);
    if (d.approved_by_source === "cgo" && hold.status !== "held") {
      throw new ExpectedToolError("tiktok_ads_budget_required", "Autopilot launches only against an active shared ad budget with the spend held. Nothing was created.");
    }
    const refused = await noteAdSpendRef(hold, { kind: "tiktok_tag", advertiser_id: b.advertiser_id, tag });
    if (refused) {
      hold = { status: "no_budget" };
      throw new ExpectedToolError("tiktok_ads_budget_refused", refused);
    }
    afterHold = true;

    const made = await build(a);
    let stopLine = null as string | null;
    if (testEnd) {
      a.failedStep = "test_stop";
      const armed = await armCreatedTestStop(d.tenant_id, d.id, testEnd, { platform: "tiktok", level: "ad_group", account_id: b.advertiser_id, object_id: made.adgroup, billing_scope: "object", daily_usd: b.daily_budget_usd, name: b.name, parent_object_id: made.campaign });
      if (!armed.ok) throw new ExpectedToolError("tiktok_ads_test_stop_unarmed", `Zavi could not set up the pause that guards this test's spend, so nothing was switched on: ${armed.why}`);
      stopLine = armed.line;
    }
    const before = { campaign: a.readback.campaign?.operation_status ?? null, ad_group: a.readback.ad_group?.operation_status ?? null };
    a.failedStep = "recheck";
    await guard(d);
    const state = await switchOn(a, made);
    if (state === "disapproved") {
      a.failedStep = "review";
      throw new ExpectedToolError("tiktok_ads_launch_disapproved", `TikTok disapproved this launch (${Object.values(a.readback).map((x) => x.secondary_status).filter(Boolean).join(", ")}).`);
    }
    await commitAdSpend(hold, made.adgroup);
    await recordLaunch(d, b, made, before);
    const held = hold.status === "held" ? " The rest of this month at this daily budget is held from your ad budget." : "";
    const notice =
      `Launched "${b.name}" on TikTok (${b.advertiser_name}): campaign ${made.campaign}, ad group ${made.adgroup}, ad ${made.ad}, at ${usd(b.daily_budget_usd)} a day. ` +
      `${STATE_LINE[state](b)}${held} ${LAUNCH_MEASURED_LINE}${stopLine ? ` ${stopLine}` : ""}`;
    return {
      ok: true,
      notice,
      execution_details: details(a, d, state, hold, null, state === "live" ? null : "Read the campaign's status again later: TikTok starts it on its own once it is approved."),
      created: { platform: "tiktok", object_type: "campaign", id: made.campaign, status: "ACTIVE", activated_at: new Date().toISOString() },
    };
  } catch (e) {
    const code = e instanceof ExpectedToolError ? e.code : "tiktok_ads_execution_failed";
    const msg = e instanceof Error ? e.message : "TikTok launch failed";
    if (!afterHold || !a) {
      await dropAdSpendHold(hold);
      return { ok: false, code, error: msg, ...(HELD_FOR_FOUNDER.has(code) ? { held_for_founder: true } : {}), execution_details: details(a, d, "refused", hold, msg, null) };
    }
    const off = await a.secure();
    if (!off) {
      return {
        ok: false,
        code: "exec_outcome_unknown",
        outcome_unknown: true,
        error: `${msg} Zavi could not confirm the TikTok campaign is off, so the ad budget hold stays. Check TikTok Ads Manager${a.ids.campaign_id ? ` (campaign ${a.ids.campaign_id})` : ` (look for ${a.tag})`} before approving anything else.`,
        execution_details: details(a, d, "outcome_unknown", hold, msg, "Check the campaign in TikTok Ads Manager; switch it off there if it should not run."),
      };
    }
    await dropAdSpendHold(hold);
    const nothing = !a.ids.campaign_id;
    const where = nothing ? " Nothing was created in TikTok, so nothing can spend." : ` Zavi switched the campaign ${a.ids.campaign_id} off and TikTok confirmed it is off; nothing can spend.`;
    if (code === "tiktok_ads_launch_disapproved") {
      return { ok: false, code, error: `${msg}${where} Nothing was deleted: edit the ad in TikTok Ads Manager, or ask Zavi for a new launch.`, execution_details: details(a, d, "disapproved_switched_off", hold, msg, "Fix the ad TikTok refused, then launch again.") };
    }
    if (PARTIAL.has(code)) {
      return { ok: false, code: "exec_partial", error: `${msg}${where} Zavi will not run this card again; check the account and finish or remove it there.`, execution_details: details(a, d, "stopped_switched_off", hold, msg, "Check the objects in TikTok Ads Manager.") };
    }
    const finalCode = code === "tiktok_ads_outcome_unknown" || !(e instanceof ExpectedToolError) ? "tiktok_ads_launch_stopped" : code;
    return {
      ok: false,
      code: finalCode,
      error: `${msg}${where}${nothing || NEEDS_NEW_CARD.has(code) ? "" : " Approve again to finish from where it stopped; nothing already made is made twice."}`,
      ...(HELD_FOR_FOUNDER.has(code) ? { held_for_founder: true } : {}),
      execution_details: details(a, d, "stopped_switched_off", hold, msg, nothing || NEEDS_NEW_CARD.has(code) ? null : "Approve again to resume."),
    };
  }
}

export async function executeTiktokLaunch(d: TiktokLaunchRow): Promise<TiktokLaunchResult> {
  return execute(d);
}
