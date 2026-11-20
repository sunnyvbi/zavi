import {LINKEDIN_LAUNCH} from "@/services/ads-wallet/linkedin-growth";
import { LINKEDIN_BUDGET_CLASS, LINKEDIN_RESUME_CLASS, LINKEDIN_SET_STATUS_CLASS, linkedinBudgetBodySchema, minor } from "@/services/tools/linkedin-ads/_change-bodies";
import {loadLinkedinUnattended,evaluateLinkedinUnattended,loadLinkedinPauseUnattended,evaluateLinkedinPauseUnattended,type LinkedinPauseFacts} from "./linkedin-unattended";
import { CHATGPT_GROWTH_CLASSES, CHATGPT_WALLET_SHORT_WORDS, parseGrowthAction } from "@/services/connectors/chatgpt-ads/growth-actions";
import { evaluateChatgptUnattended, loadChatgptUnattended, type ChatgptUnattendedFacts } from "./chatgpt-unattended";
import { evaluateXAd, loadXAdFacts } from "./x-ad-policy";
import { evaluateTiktokAd, tiktokShape } from "./tiktok-ad-policy";
import { LINKEDIN_POLICY_CLASSES, evaluateLinkedinAd, linkedinAdDirection, loadLinkedinAdFacts, type LinkedinAdFacts } from "./linkedin-ad-policy";
import { TIKTOK_CREATE_LAUNCH_CLASS, TIKTOK_HELD_CLASSES } from "@/services/connectors/tiktok-ads/held-schema";
import { evaluateRedditAd, loadRedditAdFacts, redditDirection, type RedditPolicyFacts } from "./reddit-ad-policy";
import { REDDIT_ACTION_SCHEMAS } from "@/services/connectors/reddit-ads/schema";
import { ASSISTANT_AD_CHANGE, isAssistantRun } from "@/services/mcp/assistant-policy";

import { z } from "zod";
import { blockingFounderEvent, bodyDirection, founderEditedAmount, founderOriginated, founderSetBudgetReason, founderSetBudgetWords, type FounderBudgetEvent } from "./founder-set-budget";
import { budgetTestReasons, budgetTestWords, type BudgetTestFact } from "./budget-test-shape";
import { CGO_MAX_RAISE_STEP } from "./cgo-spend-authority";
import { META_CONVERSION_GOALS, META_CONVERSION_OBJECTIVES } from "@/services/tools/meta-ads/_objective";
import {
  setStatusBodySchema,
  updateAdSetBudgetBodySchema,
  updateCampaignBudgetBodySchema as metaUpdateCampaignBudgetBodySchema,
  updateCampaignBodySchema as metaUpdateCampaignBodySchema,
  updateAdSetBodySchema as metaUpdateAdSetBodySchema,
  updateAdBodySchema as metaUpdateAdBodySchema,
  updateCreativeBodySchema as metaUpdateCreativeBodySchema,
} from "@/services/tools/meta-ads/write/_decision-bodies";
import {
  createCampaignBodySchema,
  googleSetStatusBodySchema,
  updateCampaignBudgetBodySchema,
} from "@/services/tools/google-ads/write/_decision-bodies";
import { adChangeHeadline, cleanAdName } from "@zavi/shared";
import { clipAtWord } from "./question-text";
import { homePhrase, readCardState } from "@/services/approvals/card-location";

export type Verdict = "allow" | "ask_founder" | "deny";
export type UnattendedVerdict = { verdict: Verdict; reasons: string[]; evidence?: string; notes?: string[] };

export type UnattendedAction =
  | {
      kind: "ad";
      exec_class: string;
      payload: unknown;
      source: { table: "decisions" | "channel_actions"; id: string; run_id: string | null };
      title?: string | null;
    }
  | {
      kind: "channel_pause";
      channel_slug: string;
      trigger: "review" | "question_expiry";
      defaultStated?: boolean;
    }
  | { kind: "goal_change"; trigger: "review" | "question_expiry" }
  | {
      kind: "dispatch_specialist";
      target: string;
      intent: string;
      origin_action_id?: string | null;
    };

export type AdObjectFacts = {
  id: string;
  conversionObjective: boolean | null;
  objective: string | null;
  learning: boolean | null;
  daysSinceEdit: number | null;
  lockDays: number;
  spend7dUsd: number | null;
  conversions7d: number | null;
  targetCpaUsd: number | null;
  conversionEvent?: string | null;
  conversionPixelId?: string | null;
  conversionEventFiring?: boolean | null;
  brand?: boolean | null;
  channelType?: string | null;
  resultsMatchGoal?: boolean | null;
};

export type UnattendedFacts = {
  testEnd?: "no_end" | "unverified" | "unreadable";
  testStop?: string;
  x?: { ready: boolean };
  chatgpt?: ChatgptUnattendedFacts;
  linkedin?: {reasons:string[]};
  linkedinPause?: LinkedinPauseFacts;
  linkedinAd?: LinkedinAdFacts;
  reddit?: RedditPolicyFacts;
  refsResolved?: boolean;
  openAdvice?: "clear" | "conflict" | "error" | null;
  objects?: AdObjectFacts[] | null;
  trackingOk?: boolean | null;
  goal?: { present: false } | { present: true; numberTrusted: boolean | null } | null;
  pausedByFounder?: boolean | null;
  spendUpUnderBudget?: boolean | null;
  firstOwnEnable?: boolean;
  founderSetBudget?: boolean | null;
  founderSetBudgetEvent?: FounderBudgetEvent | null;
  budgetTest?: BudgetTestFact | null;
  makeRoomCut?: boolean | null;
  zaviRaisedRecently?: boolean | null;
  channelNeverApproved?: boolean | null;
  founderActedSince?: boolean | null;
  paidChannel?: boolean;
  channelEvidence?: "per_item" | "insufficient" | "could not read" | null;
  whyCitesFounder?: boolean;
  targetAllowed?: boolean | null;
  channelAutorun?: boolean | null;
  goalChange?: { eases: boolean | null; movesBar: boolean | null; numberTrusted: boolean | null } | null;
};

export function isExecutableAdClass(decision_class: string): boolean {
  if (["x_ads.set_status", "x_ads.update_campaign", "x_ads.create_campaign", "x_ads.manage_objects"].includes(decision_class)) return true;
  if (TIKTOK_HELD_CLASSES.has(decision_class) || decision_class === TIKTOK_CREATE_LAUNCH_CLASS) return true;
  return decision_class===LINKEDIN_LAUNCH || decision_class === LINKEDIN_SET_STATUS_CLASS || LINKEDIN_POLICY_CLASSES.has(decision_class) || CHATGPT_GROWTH_CLASSES.has(decision_class) || /^(meta_ads|google_ads)\.[a-z_]+$/.test(decision_class) || decision_class === "reddit_ads.set_status" || Object.hasOwn(REDDIT_ACTION_SCHEMAS, decision_class);
}

type AdShape =
  | { cls: "budget"; platform: "meta" | "google"; objectId: string; direction: "up" | "down" | "same"; fromUsd: number; toUsd: number; level: "adset" | "campaign" }
  | { cls: "status"; platform: "meta" | "google"; objectId: string; campaignId: string | null; direction: "up" | "down"; level: string }
  | { cls: "create"; platform: "meta" | "google"; missingLocation: boolean; asks?: string[] }
  | { cls: "settings"; platform: "meta"; objectId: string; spendUp: boolean; asks: string[] }
  | { cls: "never"; why: string };

const UNATTENDED_AD_CLASSES: Readonly<Record<string, "budget" | "status" | "create" | "settings">> = {
  "meta_ads.update_ad_set_budget": "budget",
  "google_ads.update_campaign_budget": "budget",
  "meta_ads.update_ad_set_budget_review": "budget",
  "google_ads.update_campaign_budget_review": "budget",
  "meta_ads.update_campaign_budget": "budget",
  "meta_ads.update_campaign_budget_review": "budget",
  "meta_ads.set_status": "status",
  "meta_ads.set_status_review": "status",
  "google_ads.set_status": "status",
  "google_ads.set_status_review": "status",
  "meta_ads.create_ad_set": "create",
  "google_ads.create_campaign": "create",
  "google_ads.create_ad_group": "create",
  "google_ads.create_ad": "create",
  "google_ads.add_keywords": "create",
  "meta_ads.duplicate_ad_set": "create",
  "meta_ads.duplicate_campaign": "create",
  "meta_ads.create_ad": "create",
  "meta_ads.create_custom_audience": "create",
  "meta_ads.create_campaign": "create",
  "meta_ads.launch_campaign": "create",
  "meta_ads.update_campaign": "settings",
  "meta_ads.update_ad_set": "settings",
  "meta_ads.update_ad": "settings",
  "meta_ads.duplicate_ad": "create",
  "meta_ads.create_creative": "create",
  "meta_ads.upload_asset": "create",
  "meta_ads.update_creative": "settings",
  "meta_ads.create_lookalike_audience": "create",
  "meta_ads.create_custom_conversion": "create",
};

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> | null {
  const r = schema.safeParse(body);
  return r.success ? r.data : null;
}

function hasMetaPlaces(targeting: Record<string, unknown>): boolean {
  const geo = targeting.geo_locations;
  if (!geo || typeof geo !== "object") return false;
  const real = (x: unknown) =>
    (typeof x === "string" && x.trim() !== "") ||
    (!!x && typeof x === "object" && ["key", "latitude", "address_string"].some((f) => (x as Record<string, unknown>)[f] != null));
  return Object.entries(geo as Record<string, unknown>).some(([k, v]) => k !== "location_types" && Array.isArray(v) && v.some(real));
}

export function adShape(exec_class: string, payload: unknown): AdShape {
  const kind = UNATTENDED_AD_CLASSES[exec_class];
  if (!kind) {
    if (exec_class === "google_ads.remove_resource" || /(remove|delete)/.test(exec_class)) return { cls: "never", why: "delete_never_unattended" };
    if (/_review$/.test(exec_class)) return { cls: "never", why: "review_class_never_unattended" };
    return { cls: "never", why: "class_not_on_unattended_list" };
  }
  const platform = exec_class.startsWith("meta_ads.") ? "meta" : "google";
  if (kind === "create") {
    if (exec_class === "meta_ads.create_ad_set" || exec_class === "meta_ads.launch_campaign") {
      const p = payload as { targeting?: unknown; ad_set?: { targeting?: unknown }; campaign?: { special_ad_categories?: unknown } } | null;
      const targeting = exec_class === "meta_ads.launch_campaign" ? p?.ad_set?.targeting : p?.targeting;
      const cats = exec_class === "meta_ads.launch_campaign" ? p?.campaign?.special_ad_categories : undefined;
      const asks = Array.isArray(cats) && cats.length > 0 ? ["special_ad_category_needs_founder"] : [];
      return { cls: "create", platform, missingLocation: !targeting || typeof targeting !== "object" || !hasMetaPlaces(targeting as Record<string, unknown>), asks };
    }
    if (exec_class !== "google_ads.create_campaign") return { cls: "create", platform, missingLocation: false };
    const c = parse(createCampaignBodySchema, payload);
    return { cls: "create", platform, missingLocation: !c || c.location_ids.length === 0 };
  }
  if (kind === "settings") return settingsShape(exec_class, payload);
  if (kind === "budget") {
    const metaCampaign = exec_class.startsWith("meta_ads.update_campaign_budget");
    const b =
      platform === "google"
        ? parse(updateCampaignBudgetBodySchema, payload)
        : metaCampaign
          ? parse(metaUpdateCampaignBudgetBodySchema, payload)
          : parse(updateAdSetBudgetBodySchema, payload);
    if (!b) return { cls: "never", why: "body_unreadable" };
    if (b.origin === "user_initiated_chat" || b.origin === "user_initiated_ledger") return { cls: "never", why: "founder_staged_change" };
    const objectId = platform === "meta" && !metaCampaign ? (b as { ad_set_id: string }).ad_set_id : (b as { campaign_id: string }).campaign_id;
    const direction = b.daily_budget_usd > b.expected_current_daily_budget_usd ? "up" : b.daily_budget_usd < b.expected_current_daily_budget_usd ? "down" : "same";
    const level = platform === "meta" && !metaCampaign ? "adset" : "campaign";
    return { cls: "budget", platform, objectId, direction, fromUsd: b.expected_current_daily_budget_usd, toUsd: b.daily_budget_usd, level };
  }
  if (platform === "meta") {
    const s = parse(setStatusBodySchema, payload);
    if (!s) return { cls: "never", why: "body_unreadable" };
    return { cls: "status", platform, objectId: s.object_id, campaignId: s.level === "campaign" ? s.object_id : null, direction: s.status === "ACTIVE" ? "up" : "down", level: s.level };
  }
  const s = parse(googleSetStatusBodySchema, payload);
  if (!s) return { cls: "never", why: "body_unreadable" };
  const objectId = s.ad_id ?? s.ad_group_id ?? s.campaign_id;
  return { cls: "status", platform, objectId, campaignId: s.campaign_id, direction: s.status === "ENABLED" ? "up" : "down", level: s.level };
}

function settingsShape(exec_class: string, payload: unknown): AdShape {
  const founders = (p: { origin?: string } | null) => p?.origin === "user_initiated_chat";
  if (exec_class === "meta_ads.update_campaign") {
    const u = parse(metaUpdateCampaignBodySchema, payload);
    if (!u) return { cls: "never", why: "body_unreadable" };
    if (founders(u)) return { cls: "never", why: "founder_staged_change" };
    const was = u.expected_current_spend_cap_usd ?? null;
    const capUp = u.spend_cap_usd !== undefined && (u.spend_cap_usd === null ? was !== null : was !== null && u.spend_cap_usd > was);
    const bidChange = u.bid_strategy !== undefined;
    const asks = u.special_ad_categories !== undefined ? ["special_ad_category_needs_founder"] : [];
    return { cls: "settings", platform: "meta", objectId: u.campaign_id, spendUp: capUp || bidChange, asks };
  }
  if (exec_class === "meta_ads.update_ad_set") {
    const u = parse(metaUpdateAdSetBodySchema, payload);
    if (!u) return { cls: "never", why: "body_unreadable" };
    if (founders(u)) return { cls: "never", why: "founder_staged_change" };
    const was = u.expected_current_end_time ? Date.parse(u.expected_current_end_time) : null;
    const endLater = u.end_time !== undefined && was !== null && Date.parse(u.end_time) > was;
    const bidUp =
      u.bid_amount_usd !== undefined &&
      (u.expected_current_bid_amount_usd == null || u.bid_amount_usd > u.expected_current_bid_amount_usd);
    const widens = u.bid_strategy !== undefined || u.targeting_patch !== undefined;
    return { cls: "settings", platform: "meta", objectId: u.ad_set_id, spendUp: endLater || bidUp || widens, asks: [] };
  }
  if (exec_class === "meta_ads.update_creative") {
    const c = parse(metaUpdateCreativeBodySchema, payload);
    if (!c) return { cls: "never", why: "body_unreadable" };
    if (founders(c)) return { cls: "never", why: "founder_staged_change" };
    return { cls: "settings", platform: "meta", objectId: c.creative_id, spendUp: false, asks: [] };
  }
  const u = parse(metaUpdateAdBodySchema, payload);
  if (!u) return { cls: "never", why: "body_unreadable" };
  if (founders(u)) return { cls: "never", why: "founder_staged_change" };
  return { cls: "settings", platform: "meta", objectId: u.ad_id, spendUp: false, asks: u.status !== undefined ? ["ad_status_needs_founder"] : [] };
}

export function adDirection(exec_class: string, payload: unknown): "up" | "down" | "create" | "other" {
  if(exec_class===LINKEDIN_LAUNCH)return "up";
  if (exec_class === LINKEDIN_SET_STATUS_CLASS) return "down";
  if (exec_class === LINKEDIN_RESUME_CLASS) return "up";
  if (exec_class === LINKEDIN_BUDGET_CLASS) { const p = linkedinBudgetBodySchema.safeParse(payload); return p.success ? (minor(p.data.proposed.amount) > minor(p.data.expected_current.amount) ? "up" : "down") : "other"; }
  if (LINKEDIN_POLICY_CLASSES.has(exec_class)) return linkedinAdDirection({ exec_class, payload });
  if (CHATGPT_GROWTH_CLASSES.has(exec_class)) {
    try { const p = parseGrowthAction(exec_class, payload); return p.kind === "create" ? "create" : p.kind === "status" ? p.value.status === "ACTIVE" ? "up" : "down" : p.value.daily_budget_usd > p.value.expected_current_daily_budget_usd ? "up" : "down"; } catch { return "other"; }
  }
  if (exec_class.startsWith("reddit_ads.")) return redditDirection(exec_class, payload);
  if (exec_class.startsWith("tiktok_ads.")) { const t = tiktokShape({ exec_class, payload }); return t.kind === "never" ? "other" : t.direction; }
  const s = adShape(exec_class, payload);
  if (s.cls === "budget") return s.direction === "same" ? "other" : s.direction;
  if (s.cls === "status") return s.direction;
  if (s.cls === "create") return "create";
  if (s.cls === "settings") return s.spendUp ? "up" : "other";
  return "other";
}

export const NO_CONVERSION_FLOOR_USD = 50;

function verdictOf(deny: string[], ask: string[]): UnattendedVerdict {
  if (deny.length > 0) return { verdict: "deny", reasons: [...deny, ...ask] };
  if (ask.length > 0) return { verdict: "ask_founder", reasons: ask };
  return { verdict: "allow", reasons: [] };
}

const SPEND_UP_NOTE_ONLY: ReadonlySet<string> = new Set(["learning_lock", "tracking_unknown", "tracking_broken", "goal_number_untrusted"]);

function spendUpVerdict(deny: string[], ask: string[], underBudget: boolean): UnattendedVerdict {
  if (!underBudget) return verdictOf(deny, ask);
  const notes = ask.filter((r) => SPEND_UP_NOTE_ONLY.has(r));
  const v = verdictOf(deny, ask.filter((r) => !SPEND_UP_NOTE_ONLY.has(r)));
  return notes.length ? { ...v, notes } : v;
}

function openAdviceRule(f: UnattendedFacts, ask: string[]): void {
  if (f.refsResolved === false) ask.push("object_unresolved");
  if (f.openAdvice === "conflict") ask.push("open_advice_conflict");
  else if (f.openAdvice !== "clear") ask.push("open_advice_unreadable");
}

function goalRule(f: UnattendedFacts, ask: string[]): void {
  if (f.goal === null || f.goal === undefined) ask.push("goal_unreadable");
  else if (f.goal.present && f.goal.numberTrusted !== true) ask.push("goal_number_untrusted");
}

export function locked(o: AdObjectFacts): boolean | null {
  if (o.learning === true) return true;
  if (o.lockDays <= 0) return o.learning === null ? false : o.learning;
  if (o.daysSinceEdit === null) return null;
  return o.daysSinceEdit < o.lockDays;
}

function adSpendsMore(shape: ReturnType<typeof adShape>): boolean {
  return (
    shape.cls === "create" ||
    (shape.cls === "settings" && shape.spendUp) ||
    (shape.cls === "status" && shape.direction === "up") ||
    (shape.cls === "budget" && shape.direction === "up")
  );
}

export function channelSwitchRule(f: UnattendedFacts, ask: string[]): void {
  if (f.channelAutorun === false) ask.push("channel_asks_first");
  else if (f.channelAutorun !== true) ask.push("autorun_unreadable");
}

export function testEndReason(t: UnattendedFacts["testEnd"]): string | null {
  return t === "no_end" ? TEST_END_UNSUPPORTED : t === "unverified" ? TEST_END_UNVERIFIED : t === "unreadable" ? TEST_END_UNREADABLE : null;
}
export const TEST_END_UNSUPPORTED = "test_end_unsupported";
export const TEST_END_UNVERIFIED = "test_end_unverified";
export const TEST_END_UNREADABLE = "test_end_unreadable";

export function evaluateUnattended(action: UnattendedAction, f: UnattendedFacts): UnattendedVerdict {
  const v = evaluateUnattendedRules(action, f);
  const rs = action.kind === "ad" ? [testEndReason(f.testEnd), f.testStop ?? null].filter((x): x is string => !!x) : [];
  if (!rs.length) return v;
  if (v.verdict === "deny") return { ...v, reasons: [...v.reasons, ...rs] };
  return { verdict: "ask_founder", reasons: [...(v.verdict === "ask_founder" ? v.reasons : []), ...rs], ...(v.notes ? { notes: v.notes } : {}) };
}

function evaluateUnattendedRules(action: UnattendedAction, f: UnattendedFacts): UnattendedVerdict {
  if(action.kind==="ad"&&action.exec_class===LINKEDIN_LAUNCH)return evaluateLinkedinUnattended(f.linkedin);
  if (action.kind === "ad" && action.exec_class === LINKEDIN_SET_STATUS_CLASS) return evaluateLinkedinPauseUnattended(f.linkedinPause);
  if (action.kind === "ad" && LINKEDIN_POLICY_CLASSES.has(action.exec_class)) return evaluateLinkedinAd(action, f);
  if (action.kind === "ad" && CHATGPT_GROWTH_CLASSES.has(action.exec_class)) return evaluateChatgptUnattended(f.chatgpt);
  const deny: string[] = [];
  const ask: string[] = [];

  switch (action.kind) {
    case "ad": {
      if (action.exec_class.startsWith("x_ads.")) return evaluateXAd(action, f);
      if (action.exec_class.startsWith("reddit_ads.")) return evaluateRedditAd(action, f);
      if (action.exec_class.startsWith("tiktok_ads.")) return evaluateTiktokAd(action, f);
      const shape = adShape(action.exec_class, action.payload);
      if (shape.cls === "never") return verdictOf([shape.why], []);
      if (shape.cls === "status" && shape.direction === "down") {
        if (f.openAdvice === "conflict") ask.push("open_advice_conflict");
        return verdictOf([], ["pause_needs_founder", ...ask]);
      }
      openAdviceRule(f, ask);
      goalRule(f, ask);
      if (adSpendsMore(shape)) channelSwitchRule(f, ask);
      const upUnderBudget = f.spendUpUnderBudget === true;
      if (shape.cls === "create") {
        if (shape.missingLocation) ask.push("no_location_target");
        ask.push(...(shape.asks ?? []));
        return spendUpVerdict(deny, ask, upUnderBudget);
      }
      if (shape.cls === "settings") {
        ask.push(...shape.asks);
        return shape.spendUp ? spendUpVerdict(deny, ask, upUnderBudget) : verdictOf(deny, ask);
      }

      const objects = f.objects;
      if (!objects || objects.length === 0) {
        ask.push("ad_facts_unreadable");
        return verdictOf(deny, ask);
      }
      const ownLaunch = shape.cls === "status" && shape.direction === "up" && f.firstOwnEnable === true;
      const roomCut = shape.cls === "budget" && shape.direction === "down" && f.makeRoomCut === true;
      if (shape.cls === "budget" && shape.direction === "down" && f.makeRoomCut !== undefined && f.makeRoomCut !== true) {
        return verdictOf([f.makeRoomCut === false ? "make_room_test_changed" : "make_room_unverified"], []);
      }
      for (const o of ownLaunch || roomCut ? [] : objects) {
        const l = locked(o);
        if (l === null) ask.push("learning_state_unknown");
        else if (l) ask.push("learning_lock");
      }
      if (shape.cls === "status") {
        if (f.pausedByFounder !== false) ask.push(f.pausedByFounder === true ? "founder_paused_it" : "pause_owner_unknown");
        return spendUpVerdict(deny, [...new Set(ask)], upUnderBudget);
      }
      if (shape.direction === "up") {
        const fromCents = Math.round(shape.fromUsd * 100);
        const toCents = Math.round(shape.toUsd * 100);
        if (!(fromCents > 0 && toCents <= fromCents * (1 + CGO_MAX_RAISE_STEP))) ask.push("raise_over_cgo_step");
        if (f.zaviRaisedRecently === true) ask.push("raised_in_last_day");
        else if (f.zaviRaisedRecently === null) ask.push("raise_history_unknown");
      }
      if (f.founderSetBudget === true) ask.push(founderSetBudgetReason(f.founderSetBudgetEvent, shape.platform));
      else if (f.founderSetBudget === null) ask.push("budget_owner_unknown");
      ask.push(...budgetTestReasons(f.budgetTest));
      if (f.trackingOk !== true) ask.push(f.trackingOk === false ? "tracking_broken" : "tracking_unknown");
      if (shape.direction === "down") {
        for (const o of objects) {
          if (o.brand === true) ask.push("brand_campaign");
          else if (o.brand === null) ask.push("brand_unknown");
          if (o.resultsMatchGoal === false) ask.push("results_not_goal");
          else if (o.resultsMatchGoal === null) ask.push("results_unverified");
          if (o.conversions7d === null || o.spend7dUsd === null) {
            ask.push("performance_unreadable");
            continue;
          }
          if (o.conversions7d > 0) continue;
          if (o.conversionEventFiring !== true) ask.push(o.conversionEventFiring === false ? "conversion_event_not_firing" : "conversion_event_unverified");
          if (o.conversionObjective !== true) ask.push(o.conversionObjective === false ? "objective_metric_mismatch" : "objective_unknown");
          const floor = o.targetCpaUsd && o.targetCpaUsd > 0 ? 2 * o.targetCpaUsd : NO_CONVERSION_FLOOR_USD;
          if (o.spend7dUsd < floor) ask.push("spend_below_floor");
        }
      }
      return spendUpVerdict(deny, [...new Set(ask)], upUnderBudget && shape.direction === "up");
    }

    case "channel_pause": {
      if (action.trigger === "question_expiry") {
        if (f.paidChannel !== false) return verdictOf(["never_pause_paid_on_silence"], []);
        if (action.defaultStated !== true) return verdictOf(["never_pause_on_unannounced_silence"], []);
        if (f.founderActedSince !== false) return verdictOf([f.founderActedSince === true ? "founder_not_silent" : "silence_unverified"], []);
        return verdictOf([], []);
      }
      if (f.paidChannel !== false) ask.push("paid_channel_pause_needs_founder");
      if (f.channelNeverApproved !== false) ask.push(f.channelNeverApproved === true ? "channel_never_tried" : "channel_history_unknown");
      if (f.whyCitesFounder === true) deny.push("founder_silence_not_grounds");
      if (f.paidChannel === false && f.channelEvidence !== "per_item") {
        ask.push(f.channelEvidence === "insufficient" ? "insufficient_evidence" : f.channelEvidence === "could not read" ? "evidence_unreadable" : "evidence_missing");
      }
      return verdictOf(deny, ask);
    }

    case "goal_change": {
      const g = f.goalChange;
      if (!g) return verdictOf([], ["goal_facts_unreadable"]);
      if (g.eases !== false) ask.push(g.eases === true ? "eases_goal" : "eases_unknown");
      if (g.movesBar !== false) ask.push(g.movesBar === true ? "moves_founder_target" : "moves_bar_unknown");
      return verdictOf(deny, ask);
    }

    case "dispatch_specialist": {
      if (f.targetAllowed === null) return verdictOf([], ["target_unverified"]);
      if (f.targetAllowed !== true) return verdictOf(["target_not_allowed"], []);
      if (f.channelAutorun === false) ask.push("channel_asks_first");
      else if (f.channelAutorun === null) ask.push("autorun_unreadable");
      if (f.openAdvice !== undefined) openAdviceRule({ ...f, refsResolved: true }, ask);
      return verdictOf(deny, ask);
    }
  }
}

const DAY = 86_400_000;
export const TYPED_NUMBER_EXPIRES_DAYS = 14;

const GOOGLE_CONVERSION_BIDDING = new Set(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_CPA", "TARGET_ROAS"]);

function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY)) : null;
}

async function loadBudgetTestFact(tenant_id: string, platform: "meta" | "google" | "chatgpt" | "tiktok", objectId: string, runId: string | null, now: Date): Promise<BudgetTestFact> {
  return (await import("./budget-tests")).loadBudgetTestFact(tenant_id, platform, objectId, runId, now);
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[unattended-policy] fact unreadable: ${(e as Error).message}`);
    return fallback;
  }
}

export type MetaAdSetRow = {
  id?: string;
  optimization_goal?: string;
  learning_stage_info?: { status?: string } | null;
  updated_time?: string;
  bid_strategy?: string;
  bid_amount?: number | string;
  promoted_object?: { custom_event_type?: string; pixel_id?: string | number } | null;
};

export function metaObjectFacts(a: MetaAdSetRow, objective: string | null, perf: { spend: number; conv: number } | null, now: Date): AdObjectFacts {
  const goal = a.optimization_goal ?? null;
  const conversionObjective = goal ? META_CONVERSION_GOALS.has(goal) : objective ? META_CONVERSION_OBJECTIVES.has(objective) : null;
  const capped = a.bid_strategy === "COST_CAP" || a.bid_strategy === "LOWEST_COST_WITH_BID_CAP";
  const bid = Number(a.bid_amount ?? 0);
  return {
    id: String(a.id ?? ""),
    conversionObjective,
    objective: goal ?? objective,
    learning: a.learning_stage_info?.status ? a.learning_stage_info.status !== "SUCCESS" : false,
    daysSinceEdit: daysSince(a.updated_time, now),
    lockDays: 7,
    spend7dUsd: perf ? perf.spend : null,
    conversions7d: perf ? perf.conv : null,
    targetCpaUsd: capped && bid > 0 ? bid / 100 : null,
    conversionEvent: a.promoted_object?.custom_event_type ?? null,
    conversionPixelId: a.promoted_object?.pixel_id != null ? String(a.promoted_object.pixel_id) : null,
  };
}

export const META_ADSET_FIELDS = "id,optimization_goal,learning_stage_info,updated_time,bid_strategy,bid_amount,promoted_object";

export function sumMetaPerf(rows: ReadonlyArray<{ ad_set_id?: string | null; spend_usd: number; conversions: number; leads: number }>): Map<string, { spend: number; conv: number }> {
  const perf = new Map<string, { spend: number; conv: number }>();
  for (const r of rows) {
    const k = r.ad_set_id ?? "";
    const p = perf.get(k) ?? { spend: 0, conv: 0 };
    p.spend += r.spend_usd;
    p.conv += r.conversions + r.leads;
    perf.set(k, p);
  }
  return perf;
}

export async function loadMetaObjects(tenant_id: string, objectId: string, level: "adset" | "campaign", now: Date): Promise<AdObjectFacts[] | null> {
  const { fbGet } = await import("@/services/tools/meta-ads/_client");
  const { fetchMetaDailySeries } = await import("@/services/tools/meta-ads/daily_series");
  let sets: MetaAdSetRow[];
  let objective: string | null;
  if (level === "adset") {
    const a = (await fbGet(tenant_id, objectId, { fields: `${META_ADSET_FIELDS},campaign{objective}` })) as MetaAdSetRow & { campaign?: { objective?: string } };
    sets = [a];
    objective = a.campaign?.objective ?? null;
  } else {
    const c = (await fbGet(tenant_id, objectId, { fields: "objective,updated_time" })) as { objective?: string };
    objective = c.objective ?? null;
    const r = (await fbGet(tenant_id, `${objectId}/adsets`, { fields: META_ADSET_FIELDS, limit: 100 })) as { data?: MetaAdSetRow[]; paging?: { next?: string } };
    if (r.paging?.next) throw new Error("more than 100 ad sets; not judged unattended");
    sets = r.data ?? [];
  }
  if (sets.length === 0) return null;
  const { rows, truncated } = await fetchMetaDailySeries(tenant_id, {
    level: "adset",
    date_preset: "last_7d",
    filter: level === "adset" ? { ad_set_id: objectId } : { campaign_id: objectId },
  });
  const perf = sumMetaPerf(truncated ? [] : rows);
  return sets.map((a) => metaObjectFacts(a, objective, truncated ? null : perf.get(String(a.id)) ?? { spend: 0, conv: 0 }, now));
}

export async function loadGoogleObjects(tenant_id: string, campaignId: string, now: Date): Promise<AdObjectFacts[] | null> {
  if (!/^\d+$/.test(campaignId)) return null;
  const { gadsSearch } = await import("@/services/tools/google-ads/_client");
  const rows = (await gadsSearch(
    tenant_id,
    `SELECT campaign.id, campaign.resource_name, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros, metrics.cost_micros, metrics.conversions FROM campaign WHERE campaign.id = ${campaignId} AND segments.date DURING LAST_7_DAYS`,
  )) as Array<{
    campaign?: { resourceName?: string; advertisingChannelType?: string; biddingStrategyType?: string; targetCpa?: { targetCpaMicros?: string }; maximizeConversions?: { targetCpaMicros?: string } };
    metrics?: { costMicros?: string; conversions?: number | string };
  }>;
  let spend = 0;
  let conv = 0;
  for (const r of rows) {
    spend += Number(r.metrics?.costMicros ?? 0) / 1e6;
    conv += Number(r.metrics?.conversions ?? 0);
  }
  const head = rows[0]?.campaign ?? (
    (await gadsSearch(tenant_id, `SELECT campaign.resource_name, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`)) as Array<{ campaign?: NonNullable<(typeof rows)[number]["campaign"]> }>
  )[0]?.campaign;
  if (!head?.resourceName) return null;
  const type = head.advertisingChannelType ?? null;
  const bidding = head.biddingStrategyType ?? null;
  const pmax = type === "PERFORMANCE_MAX";
  let daysSinceEdit: number | null = null;
  if (pmax) {
    const start = new Date(now.getTime() - 15 * DAY).toISOString().slice(0, 10);
    const end = new Date(now.getTime() + DAY).toISOString().slice(0, 10);
    const ev = (await gadsSearch(
      tenant_id,
      `SELECT change_event.change_date_time FROM change_event WHERE change_event.campaign = '${head.resourceName}' AND change_event.change_date_time >= '${start} 00:00:00' AND change_event.change_date_time <= '${end} 00:00:00' ORDER BY change_event.change_date_time DESC LIMIT 1`,
    )) as Array<{ changeEvent?: { changeDateTime?: string } }>;
    const at = ev[0]?.changeEvent?.changeDateTime;
    daysSinceEdit = at ? daysSince(`${at.replace(" ", "T")}Z`, now) : 15;
  }
  const cpaMicros = Number(head.targetCpa?.targetCpaMicros ?? head.maximizeConversions?.targetCpaMicros ?? 0);
  return [googleObjectFacts({ campaignId, type, bidding, daysSinceEdit, spendUsd: spend, conversions: conv, targetCpaUsd: cpaMicros > 0 ? cpaMicros / 1e6 : null })];
}

export function googleObjectFacts(c: {
  campaignId: string;
  type: string | null;
  bidding: string | null;
  daysSinceEdit: number | null;
  spendUsd: number;
  conversions: number;
  targetCpaUsd: number | null;
}): AdObjectFacts {
  const pmax = c.type === "PERFORMANCE_MAX";
  return {
    id: c.campaignId,
    conversionObjective: c.bidding ? GOOGLE_CONVERSION_BIDDING.has(c.bidding) : null,
    objective: [c.type, c.bidding].filter(Boolean).join("/") || null,
    channelType: c.type,
    learning: null,
    daysSinceEdit: pmax ? c.daysSinceEdit : null,
    lockDays: pmax ? 14 : 0,
    spend7dUsd: Math.round(c.spendUsd * 100) / 100,
    conversions7d: c.conversions,
    targetCpaUsd: c.targetCpaUsd,
  };
}

export function normEvent(e: string): string {
  return e.toLowerCase().replace(/[^a-z]/g, "").replace(/^initiated/, "initiate");
}

export type Tracking = { ok: boolean | null; firedEvents: Map<string, Set<string>> | null };

export async function loadTracking(tenant_id: string, platform: "meta" | "google"): Promise<Tracking> {
  const ctx = { tenant_id, log: () => {} };
  if (platform === "meta") {
    const { metaPixelHealthTool } = await import("@/services/tools/meta-ads/pixel_health");
    const r = (await metaPixelHealthTool.execute(ctx, { lookback_days: 7 })) as {
      overall_status?: string;
      pixels?: Array<{ pixel_id?: string; event_coverage?: Record<string, number> }>;
    };
    if (!r?.overall_status) return { ok: null, firedEvents: null };
    const fired = Array.isArray(r.pixels)
      ? new Map(
          r.pixels
            .filter((p) => p.pixel_id != null)
            .map((p) => [
              String(p.pixel_id),
              new Set(Object.entries(p.event_coverage ?? {}).filter(([, n]) => Number(n) > 0).map(([e]) => normEvent(e))),
            ]),
        )
      : null;
    return { ok: r.overall_status === "healthy" || r.overall_status === "web_only", firedEvents: fired };
  }
  const { conversionTrackingHealthTool } = await import("@/services/tools/google-ads/conversion_tracking_health");
  const r = (await conversionTrackingHealthTool.execute(ctx, { date_range: "LAST_7_DAYS" })) as { overall_status?: string };
  if (!r?.overall_status || r.overall_status === "unknown") return { ok: null, firedEvents: null };
  return { ok: r.overall_status === "healthy", firedEvents: null };
}

export function withConversionFiring(objects: AdObjectFacts[], platform: "meta" | "google", t: Tracking): AdObjectFacts[] {
  return objects.map((o) => {
    if (platform === "google") return { ...o, conversionEventFiring: t.ok };
    if (!o.conversionEvent || !o.conversionPixelId || !t.firedEvents) return { ...o, conversionEventFiring: null };
    const own = t.firedEvents.get(o.conversionPixelId);
    if (!own) return { ...o, conversionEventFiring: null };
    return { ...o, conversionEventFiring: own.has(normEvent(o.conversionEvent)) };
  });
}

async function isAssistantSourceRun(tenant_id: string, run_id: string | null): Promise<boolean> {
  if (!run_id) return false;
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("agent_runs").select("trigger").eq("id", run_id).eq("tenant_id", tenant_id).maybeSingle();
  if (error) throw new Error(`run ${run_id} unreadable: ${error.message}`);
  return isAssistantRun((data as { trigger?: string | null } | null)?.trigger);
}

export async function loadGoalFact(tenant_id: string, run_id: string | null, now: Date): Promise<UnattendedFacts["goal"]> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const db = tenantClient(asTenantId(tenant_id));
  if (!run_id) return { present: false };
  const { data: run, error } = await db.from("agent_runs").select("payload").eq("id", run_id).eq("tenant_id", tenant_id).maybeSingle();
  if (error || !run) return null;
  const goal_id = (run as { payload?: { goal_id?: unknown } | null }).payload?.goal_id;
  if (typeof goal_id !== "string" || !goal_id) return { present: false };
  const { data: g, error: gErr } = await db
    .from("autopilot_goals")
    .select("current_value, current_value_at, measurement_mode, count_rule")
    .eq("id", goal_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (gErr || !g) return null;
  const { numberTrusted, utcDay } = await import("./goal-owner");
  return goalFactOf(g as GoalNumberRow, now, (r) => numberTrusted(r, utcDay(now)));
}

export type GoalNumberRow = { current_value: number | null; current_value_at: string | null; measurement_mode: string | null; count_rule?: unknown };

export function goalFactOf(row: GoalNumberRow, _now: Date, trustedToday: (r: GoalNumberRow) => boolean): UnattendedFacts["goal"] {
  return { present: true, numberTrusted: trustedToday(row) };
}

export async function loadPausedByFounder(
  tenant_id: string,
  platform: "meta" | "google" | "chatgpt" | "tiktok" | "linkedin",
  objectId: string,
  outsideIds: readonly string[] = [],
): Promise<{ pausedByFounder: boolean | null; firstOwnEnable: boolean; lastAt?: string }> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const db = tenantClient(asTenantId(tenant_id));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(objectId)) throw new Error("object id is not a plain id");
  if (outsideIds.some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id))) throw new Error("object id is not a plain id");
  const prefix = `${platform === "chatgpt" ? "chatgpt" : platform}_ads.set_status`;
  const classes = platform === "linkedin" ? [LINKEDIN_SET_STATUS_CLASS, LINKEDIN_RESUME_CLASS] : [prefix, `${prefix}_review`];
  const idKeys = platform === "meta" ? ["object_id"] : platform === "linkedin" ? ["campaign_id"] : ["ad_id", "ad_group_id", "campaign_id"];
  const namedBy = (col: string) => idKeys.map((k) => `${col}->>${k}.eq.${objectId}`).join(",");
  type Ev = { at: string; paused: boolean; bySource: string | null };
  const events: Ev[] = [];
  const statusOf = (p: Record<string, unknown> | null) => String(p?.status ?? "");
  const namesObject = (p: Record<string, unknown> | null) => {
    if (!p) return false;
    const own = idKeys.map((k) => p[k]).find((v) => typeof v === "string" && v);
    return own === objectId;
  };
  const { data: ca, error: caErr } = await db
    .from("channel_actions")
    .select("exec_payload, executed_at, approved_by_source")
    .eq("tenant_id", tenant_id)
    .in("exec_class", classes)
    .eq("exec_status", "executed")
    .or(namedBy("exec_payload"))
    .order("executed_at", { ascending: false })
    .limit(200);
  if (caErr) throw new Error(caErr.message);
  for (const r of (ca ?? []) as Array<{ exec_payload: Record<string, unknown> | null; executed_at: string | null; approved_by_source: string | null }>) {
    if (namesObject(r.exec_payload) && r.executed_at) {
      events.push({ at: r.executed_at, paused: /PAUSED/.test(statusOf(r.exec_payload)), bySource: r.approved_by_source });
    }
  }
  const { data: ds, error: dErr } = await db
    .from("decisions")
    .select("body, dispatched_at, approved_by_source")
    .eq("tenant_id", tenant_id)
    .in("decision_class", classes)
    .eq("status", "acted")
    .or(namedBy("body"))
    .order("dispatched_at", { ascending: false })
    .limit(200);
  if (dErr) throw new Error(dErr.message);
  for (const r of (ds ?? []) as Array<{ body: Record<string, unknown> | null; dispatched_at: string | null; approved_by_source: string | null }>) {
    if (namesObject(r.body) && r.dispatched_at) {
      events.push({ at: r.dispatched_at, paused: /PAUSED/.test(statusOf(r.body)), bySource: r.approved_by_source });
    }
  }
  const { data: out, error: oErr } = await db
    .from("ad_object_changes")
    .select("after_status, occurred_at")
    .eq("tenant_id", tenant_id)
    .eq("platform", platform)
    .eq("source", "outside")
    .eq("change_kind", "status")
    .or([objectId, ...outsideIds].map((id) => `object_id.eq.${id},campaign_id.eq.${id}`).join(","))
    .order("occurred_at", { ascending: false })
    .limit(20);
  if (oErr) throw new Error(oErr.message);
  const { onOff } = await import("@/services/decisions/ad-changes");
  for (const r of (out ?? []) as Array<{ after_status: string | null; occurred_at: string }>) {
    const state = onOff(platform, r.after_status);
    if (state) events.push({ at: r.occurred_at, paused: state === "off", bySource: "outside" });
  }
  events.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const last = events[0];
  if (last) {
    if (!last.paused) return { pausedByFounder: null, firstOwnEnable: false };
    return { pausedByFounder: last.bySource === "cgo" ? false : true, firstOwnEnable: false, lastAt: last.at };
  }
  const createdQuery = db
    .from("ad_budget_reservations")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("platform", platform)
    .eq("op", "create")
    .eq("status", "committed");
  const { data: created, error: rErr } = await (outsideIds.length ? createdQuery.in("object_id", [objectId, ...outsideIds]) : createdQuery.eq("object_id", objectId)).limit(1);
  if (rErr) throw new Error(rErr.message);
  const own = (created ?? []).length > 0;
  return { pausedByFounder: own ? false : null, firstOwnEnable: own };
}

const META_CREATE_SETTLE_MS = 60_000;

async function metaUntouchedSinceCreate(tenant_id: string, objectId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(objectId)) throw new Error("object id is not a plain id");
  const { fbGet } = await import("@/services/tools/meta-ads/_client");
  const o = (await fbGet(tenant_id, objectId, { fields: "created_time,updated_time" })) as { created_time?: string; updated_time?: string };
  const created = Date.parse(o.created_time ?? "");
  const updated = Date.parse(o.updated_time ?? "");
  if (!Number.isFinite(created) || !Number.isFinite(updated)) return false;
  return updated - created <= META_CREATE_SETTLE_MS;
}

export const RAISE_SPACING_HOURS = 24;

const RAISE_CLASSES: Record<"meta" | "google" | "chatgpt" | "tiktok" | "linkedin", readonly string[]> = {
  meta: [
    "meta_ads.update_ad_set_budget",
    "meta_ads.update_ad_set_budget_review",
    "meta_ads.update_campaign_budget",
    "meta_ads.update_campaign_budget_review",
  ],
  google: ["google_ads.update_campaign_budget", "google_ads.update_campaign_budget_review"],
  chatgpt: ["chatgpt_ads.update_campaign_budget"],
  tiktok: ["tiktok_ads.update_budget"],
  linkedin: [LINKEDIN_BUDGET_CLASS],
};

export function bodyRaisesObject(body: unknown, platform: "meta" | "google" | "chatgpt" | "tiktok" | "linkedin", objectId: string): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (platform === "linkedin") {
    const l = linkedinBudgetBodySchema.safeParse(body);
    return l.success && l.data.campaign_id === objectId && minor(l.data.proposed.amount) > minor(l.data.expected_current.amount);
  }
  const target = platform === "meta" ? (b.ad_set_id ?? b.campaign_id) : platform === "tiktok" ? b.object_id : b.campaign_id;
  if (target !== objectId) return false;
  const to = Number(b.daily_budget_usd);
  const from = Number(b.expected_current_daily_budget_usd);
  return Number.isFinite(to) && Number.isFinite(from) && to > from;
}

export async function loadZaviRaisedRecently(
  tenant_id: string,
  platform: "meta" | "google" | "chatgpt" | "tiktok" | "linkedin",
  objectId: string,
  self: { table: "decisions" | "channel_actions"; id: string },
  now: Date,
): Promise<boolean> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { orderDefinitelyFailed } = await import("./ad-spend-controller");
  const db = tenantClient(asTenantId(tenant_id));
  const since = new Date(now.getTime() - RAISE_SPACING_HOURS * 3_600_000).toISOString();
  const LIMIT = 500;
  const { data: acts, error: aErr } = await db
    .from("channel_actions")
    .select("id, exec_payload, edited_body, exec_status, exec_result")
    .eq("tenant_id", tenant_id)
    .in("exec_class", RAISE_CLASSES[platform])
    .in("exec_status", ["executed", "dispatching", "failed", "queued"])
    .or(`executed_at.gte.${since},exec_claimed_at.gte.${since},exec_status.eq.queued`)
    .limit(LIMIT);
  if (aErr) throw new Error(aErr.message);
  if ((acts ?? []).length >= LIMIT) throw new Error("raise history page full");
  for (const r of (acts ?? []) as Array<{ id: string; exec_payload: unknown; edited_body: unknown; exec_status: string | null; exec_result: Record<string, unknown> | null }>) {
    if (self.table === "channel_actions" && r.id === self.id) continue;
    if (orderDefinitelyFailed(r)) continue;
    if (bodyRaisesObject(r.exec_payload, platform, objectId) || bodyRaisesObject(r.edited_body, platform, objectId)) return true;
  }
  const { data: decs, error: dErr } = await db
    .from("decisions")
    .select("id, body")
    .eq("tenant_id", tenant_id)
    .in("decision_class", RAISE_CLASSES[platform])
    .in("status", ["approved", "dispatching", "acted", "dispatch_failed"])
    .or(`dispatched_at.gte.${since},approved_at.gte.${since},status.eq.approved`)
    .limit(LIMIT);
  if (dErr) throw new Error(dErr.message);
  if ((decs ?? []).length >= LIMIT) throw new Error("raise history page full");
  for (const r of (decs ?? []) as Array<{ id: string; body: unknown }>) {
    if (self.table === "decisions" && r.id === self.id) continue;
    if (bodyRaisesObject(r.body, platform, objectId)) return true;
  }
  return false;
}

export const FOUNDER_BUDGET_DAYS = 30;

export function humanApproved(r: { approved_by?: string | null; approved_by_source?: string | null }): boolean {
  return typeof r.approved_by === "string" && r.approved_by !== "" && (r.approved_by_source == null || r.approved_by_source === "founder" || r.approved_by_source === "email");
}

function budgetTargetOf(body: unknown, platform: "meta" | "google" | "chatgpt" | "tiktok" | "linkedin"): unknown {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  return platform === "meta" ? (b.ad_set_id ?? b.campaign_id) : platform === "tiktok" ? b.object_id : b.campaign_id;
}

export async function loadFounderSetBudget(
  tenant_id: string,
  platform: "meta" | "google" | "chatgpt" | "tiktok" | "linkedin",
  objectId: string,
  now: Date,
  direction?: "up" | "down" | "same" | null,
  outsideIds: readonly string[] = [],
): Promise<FounderBudgetEvent | null> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const db = tenantClient(asTenantId(tenant_id));
  const since = new Date(now.getTime() - FOUNDER_BUDGET_DAYS * 86_400_000).toISOString();
  const events = await founderBudgetEventsInZavi(db, tenant_id, platform, objectId, since);
  const outsideBudget = db
    .from("ad_object_changes")
    .select("id, occurred_at")
    .eq("tenant_id", tenant_id)
    .eq("platform", platform)
    .eq("source", "outside")
    .eq("change_kind", "budget");
  const { data, error } = await (outsideIds.length ? outsideBudget.in("object_id", [objectId, ...outsideIds]) : outsideBudget.eq("object_id", objectId))
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as Array<{ occurred_at?: string | null }>) {
    events.push({ source: "outside", at: r.occurred_at && Number.isFinite(Date.parse(r.occurred_at)) ? r.occurred_at : now.toISOString() });
  }
  return blockingFounderEvent(events, direction);
}

async function founderBudgetEventsInZavi(
  db: ReturnType<typeof import("@/services/tenant-client").tenantClient>,
  tenant_id: string,
  platform: "meta" | "google" | "chatgpt" | "tiktok" | "linkedin",
  objectId: string,
  since: string,
): Promise<FounderBudgetEvent[]> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(objectId)) throw new Error("object id is not a plain id");
  const { orderDefinitelyFailed } = await import("./ad-spend-controller");
  const classes = RAISE_CLASSES[platform];
  const LIMIT = 200;
  const namedBy = (col: string) => ["campaign_id", "ad_set_id", "object_id"].map((k) => `${col}->>${k}.eq.${objectId}`).join(",");
  const { data: acts, error: aErr } = await db
    .from("channel_actions")
    .select("exec_payload, edited_body, exec_status, exec_result, executed_at, exec_claimed_at, proposed_at, approved_by, approved_by_source")
    .eq("tenant_id", tenant_id)
    .in("exec_class", classes)
    .in("exec_status", ["executed", "dispatching", "failed", "queued"])
    .not("approved_by", "is", null)
    .or(`${namedBy("exec_payload")},${namedBy("edited_body")}`)
    .limit(LIMIT);
  if (aErr) throw new Error(aErr.message);
  if ((acts ?? []).length >= LIMIT) throw new Error("founder budget history page full");
  const recent = (t: string | null | undefined) => !!t && Date.parse(t) >= Date.parse(since);
  type Act = { exec_payload: unknown; edited_body: unknown; exec_status: string | null; exec_result: Record<string, unknown> | null; executed_at: string | null; exec_claimed_at: string | null; proposed_at: string | null; approved_by: string | null; approved_by_source: string | null };
  const found: Array<FounderBudgetEvent & { by: string }> = [];
  const eventOf = (by: string, at: string, body: unknown, ...marks: unknown[]): FounderBudgetEvent & { by: string } => {
    const o = founderOriginated(...marks);
    return { by, at, direction: bodyDirection(body), ...(o.yes ? { source: "ordered" as const, via: o.via } : { source: "approved" as const }) };
  };
  for (const r of (acts ?? []) as Act[]) {
    if (!humanApproved(r) || orderDefinitelyFailed(r)) continue;
    const at = r.exec_status === "queued" ? r.proposed_at : (r.executed_at ?? r.exec_claimed_at);
    if (!recent(at)) continue;
    if (budgetTargetOf(r.exec_payload, platform) !== objectId && budgetTargetOf(r.edited_body, platform) !== objectId) continue;
    const body = r.edited_body ?? r.exec_payload;
    const e = eventOf(r.approved_by as string, at as string, body, r.exec_payload, r.edited_body);
    found.push(e.source === "approved" && founderEditedAmount(r.exec_payload, r.edited_body) ? { ...e, source: "edited" } : e);
  }
  const { data: decs, error: dErr } = await db
    .from("decisions")
    .select("body, approved_by, approved_by_source, approved_at")
    .eq("tenant_id", tenant_id)
    .in("decision_class", classes)
    .in("status", ["approved", "dispatching", "acted", "dispatch_failed"])
    .not("approved_by", "is", null)
    .gte("approved_at", since)
    .or(namedBy("body"))
    .limit(LIMIT);
  if (dErr) throw new Error(dErr.message);
  if ((decs ?? []).length >= LIMIT) throw new Error("founder budget history page full");
  for (const r of (decs ?? []) as Array<{ body: unknown; approved_by: string | null; approved_by_source: string | null; approved_at: string | null }>) {
    if (!humanApproved(r) || budgetTargetOf(r.body, platform) !== objectId) continue;
    found.push(eventOf(r.approved_by as string, r.approved_at ?? since, r.body, r.body));
  }
  if (found.length === 0) return [];
  const { data: roles, error: rErr } = await db
    .from("tenant_users")
    .select("user_id, role")
    .eq("tenant_id", tenant_id)
    .in("user_id", [...new Set(found.map((e) => e.by))]);
  if (rErr) throw new Error(rErr.message);
  const founders = new Set(((roles ?? []) as Array<{ user_id: string; role: string | null }>).filter((u) => u.role === "owner" || u.role === "admin").map((u) => u.user_id));
  return found.filter((e) => founders.has(e.by)).map(({ by: _by, ...e }) => e);
}

export async function loadOpenAdviceForAd(
  tenant_id: string,
  action: Extract<UnattendedAction, { kind: "ad" }>,
): Promise<{ refsResolved: boolean; openAdvice: "clear" | "conflict" | "error" }> {
  const { findContradictingOpenAdvice, channelsForAdClass, refsFromPayload, adObjectFor, MIN_NAME_CHARS, normName } = await import("./open-advice");
  const refs = refsFromPayload(action.payload);
  const name = refs.names[0] ?? null;
  const refsResolved = refs.ids.length > 0 || (!!name && normName(name).length >= MIN_NAME_CHARS);
  if (!refsResolved) return { refsResolved, openAdvice: "clear" };
  const check = await findContradictingOpenAdvice({
    tenant_id,
    channels: channelsForAdClass(action.exec_class),
    object: await adObjectFor(tenant_id, action.exec_class, action.payload),
    exclude: { action_id: action.source.table === "channel_actions" ? action.source.id : null, run_id: action.source.run_id },
    exec: { exec_class: action.exec_class, exec_payload: action.payload },
  });
  return { refsResolved, openAdvice: check.status };
}

export async function loadUnattendedFacts(
  tenant_id: string,
  action: UnattendedAction,
  opts: Parameters<typeof loadUnattendedRuleFacts>[2] = {},
): Promise<UnattendedFacts> {
  const facts = await loadUnattendedRuleFacts(tenant_id, action, opts);
  if (action.kind !== "ad") return facts;
  const testEnd = await loadTestEndFact(tenant_id, action, opts.now ?? new Date());
  const testStop = await loadTestStopFact(tenant_id, action);
  return { ...facts, ...(testEnd ? { testEnd } : {}), ...(testStop ? { testStop } : {}) };
}

export async function loadTestEndFact(tenant_id: string, action: Extract<UnattendedAction, { kind: "ad" }>, now: Date): Promise<UnattendedFacts["testEnd"]> {
  try {
    const { cgoTestEndForRun, testCreateEndSupport } = await import("./cgo-test-end");
    const test = await cgoTestEndForRun(tenant_id, action.source.run_id, now);
    if (!test) return undefined;
    const { adsNoFrictionEnabled } = await import("./ads-no-friction-flag");
    if (testCreateEndSupport(action.exec_class, action.payload, test, await adsNoFrictionEnabled()) === "no_end") return "no_end";
    if (/^meta_ads\.update_ad_set(_review)?$/.test(action.exec_class)) {
      const { endWithinTest } = await import("./cgo-test-end");
      const end = (action.payload as { end_time?: unknown } | null)?.end_time;
      return typeof end === "string" && !endWithinTest(end, test.ends_on) ? "unverified" : undefined;
    }
    const shape = UNATTENDED_AD_CLASSES[action.exec_class] ? adShape(action.exec_class, action.payload) : null;
    if (!shape || shape.cls !== "status" || shape.direction !== "up") return undefined;
    const target =
      shape.platform === "google"
        ? shape.campaignId ? { level: "campaign" as const, id: shape.campaignId } : null
        : shape.level === "campaign" ? { level: "campaign" as const, id: shape.objectId } : shape.level === "adset" ? { level: "adset" as const, id: shape.objectId } : null;
    if (!target) return undefined;
    const { liveEndWithinTest, metaAdSetCampaignId } = await import("./cgo-test-end-live");
    let made = await zaviCreated(tenant_id, shape.platform, target.id);
    if (!made && shape.platform === "meta" && target.level === "adset") {
      const campaign = await metaAdSetCampaignId(tenant_id, target.id);
      made = !!campaign && (await zaviCreated(tenant_id, "meta", campaign));
    }
    if (!made) return undefined;
    return (await liveEndWithinTest(tenant_id, shape.platform, target.level, target.id, test.ends_on)) ? undefined : "unverified";
  } catch (e) {
    console.warn(`[unattended] test end for ${action.exec_class} unreadable: ${(e as Error).message.slice(0, 200)}`);
    return "unreadable";
  }
}

export async function loadTestStopFact(tenant_id: string, action: Extract<UnattendedAction, { kind: "ad" }>): Promise<string | undefined> {
  try {
    const { testStopGateReason } = await import("./test-stops");
    return (await testStopGateReason(tenant_id, action.exec_class, action.payload)) ?? undefined;
  } catch (e) {
    console.warn(`[unattended] test stop for ${action.exec_class} unreadable: ${(e as Error).message.slice(0, 200)}`);
    return TEST_STOP_UNREADABLE;
  }
}
export const TEST_STOP_UNREADABLE = "test_stop_unreadable";

async function zaviCreated(tenant_id: string, platform: "meta" | "google", objectId: string): Promise<boolean> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("ad_budget_reservations")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("platform", platform)
    .eq("op", "create")
    .eq("status", "committed")
    .eq("object_id", objectId)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

async function loadUnattendedRuleFacts(
  tenant_id: string,
  action: UnattendedAction,
  opts: {
    now?: Date;
    channelNeverApproved?: boolean | null;
    goalChange?: UnattendedFacts["goalChange"];
    evidence?: import("./cgo-evidence").CgoEvidence | null;
    why?: string;
  } = {},
): Promise<UnattendedFacts> {
  const now = opts.now ?? new Date();
  switch (action.kind) {
    case "ad": {
      if (action.exec_class.startsWith("x_ads.")) {
        const advice = await safe(() => loadOpenAdviceForAd(tenant_id, action), { refsResolved: false, openAdvice: "error" as const });
        const { cgoAdBudget } = await import("./cgo-ads");
        return { ...advice, goal: await safe(() => loadGoalFact(tenant_id, action.source.run_id, now), null), spendUpUnderBudget: (await cgoAdBudget(tenant_id)) !== null, channelAutorun: await safe(() => readChannelAutorun(tenant_id, "x_ads"), null), x: await safe(() => loadXAdFacts(tenant_id, action), { ready: false }) };
      }
      if(action.exec_class===LINKEDIN_LAUNCH)return {linkedin:await loadLinkedinUnattended(tenant_id,action,now)};
      if (action.exec_class === LINKEDIN_SET_STATUS_CLASS) return { linkedinPause: await loadLinkedinPauseUnattended(tenant_id) };
      if (LINKEDIN_POLICY_CLASSES.has(action.exec_class)) return loadLinkedinAdFacts(tenant_id, action, now);
      if (CHATGPT_GROWTH_CLASSES.has(action.exec_class)) return { chatgpt: await loadChatgptUnattended(tenant_id, action, now) };
      if (action.exec_class.startsWith("tiktok_ads.")) {
        const shape = tiktokShape(action);
        if (shape.kind === "never") return {};
        const advice = await safe(() => loadOpenAdviceForAd(tenant_id, action), { refsResolved: true, openAdvice: "error" as const });
        if (shape.direction === "down") return advice;
        const { cgoAdBudget } = await import("./cgo-ads");
        if (shape.kind === "create") {
          return {
            ...advice,
            goal: await safe(() => loadGoalFact(tenant_id, action.source.run_id, now), null),
            spendUpUnderBudget: await safe(async () => (await cgoAdBudget(tenant_id, now)) !== null, null),
            channelAutorun: await safe(() => readChannelAutorun(tenant_id, "tiktok_ads"), null),
            trackingOk: null,
          };
        }
        const facts: UnattendedFacts = {
          ...advice,
          goal: await safe(() => loadGoalFact(tenant_id, action.source.run_id, now), null),
          spendUpUnderBudget: await safe(async () => (await cgoAdBudget(tenant_id, now)) !== null, null),
          channelAutorun: await safe(() => readChannelAutorun(tenant_id, "tiktok_ads"), null),
          trackingOk: null,
          objects: await safe(async () => {
            const b = (action.payload ?? {}) as { advertiser_id: string; level: "campaign" | "ad_group" };
            return (await import("./cgo-channel-readers")).loadTiktokObjects(tenant_id, { advertiser_id: b.advertiser_id, level: b.level, object_id: shape.objectId }, now);
          }, null),
        };
        if (shape.kind === "status") {
          const owner = await safe(() => loadPausedByFounder(tenant_id, "tiktok", shape.objectId), null);
          facts.pausedByFounder = owner ? owner.pausedByFounder : null;
        } else {
          const ev = await safe(() => loadFounderSetBudget(tenant_id, "tiktok", shape.objectId, now, shape.direction), undefined);
          facts.founderSetBudget = ev === undefined ? null : ev !== null;
          if (ev) facts.founderSetBudgetEvent = ev;
          facts.budgetTest = await safe(() => loadBudgetTestFact(tenant_id, "tiktok", shape.objectId, action.source.run_id, now), null);
          facts.zaviRaisedRecently = await safe(() => loadZaviRaisedRecently(tenant_id, "tiktok", shape.objectId, action.source, now), null);
        }
        return facts;
      }
      if (action.exec_class.startsWith("reddit_ads.")) {
        const advice = await safe(() => loadOpenAdviceForAd(tenant_id, action), { refsResolved: true, openAdvice: "error" as const });
        const { cgoAdBudget } = await import("./cgo-ads");
        return { ...advice, goal: await safe(() => loadGoalFact(tenant_id, action.source.run_id, now), null), spendUpUnderBudget: (await cgoAdBudget(tenant_id)) !== null, channelAutorun: await safe(() => readChannelAutorun(tenant_id, "reddit_ads"), null), reddit: await safe(() => loadRedditAdFacts(tenant_id, action), { ready: false, managed: false, unchanged: false }) };
      }
      const shape = adShape(action.exec_class, action.payload);
      if (shape.cls === "never") return {};
      const advice = await safe(() => loadOpenAdviceForAd(tenant_id, action), { refsResolved: true, openAdvice: "error" as const });
      const loadObjects = () =>
        safe(async () => {
          if (shape.cls === "create" || shape.cls === "settings") return null;
          if (shape.platform === "meta") {
            const level = shape.cls === "status" ? (shape.level === "campaign" ? "campaign" : "adset") : shape.level;
            return loadMetaObjects(tenant_id, shape.objectId, level, now);
          }
          const campaignId = shape.cls === "status" ? shape.campaignId ?? shape.objectId : shape.objectId;
          return loadGoogleObjects(tenant_id, campaignId, now);
        }, null);
      if (shape.cls === "status" && shape.direction === "down") {
        const t = await safe(() => loadTracking(tenant_id, shape.platform), { ok: null, firedEvents: null } as Tracking);
        const objects = await loadObjects();
        return { ...advice, trackingOk: t.ok, objects: objects ? withConversionFiring(objects, shape.platform, t) : null };
      }
      const goal = await safe(() => loadGoalFact(tenant_id, action.source.run_id, now), null);
      const facts: UnattendedFacts = { ...advice, goal };
      if (adSpendsMore(shape)) {
        facts.channelAutorun = await safe(() => readChannelAutorun(tenant_id, shape.platform === "meta" ? "meta_ads" : "google_ads"), null);
        facts.spendUpUnderBudget = await safe(async () => {
          const { cgoAdBudget } = await import("./cgo-ads");
          return (await cgoAdBudget(tenant_id, now)) !== null;
        }, null);
      }
      if (shape.cls === "create" || shape.cls === "settings") return facts;
      facts.objects = await loadObjects();
      if (shape.cls === "budget") {
        const t = await safe(() => loadTracking(tenant_id, shape.platform), { ok: null, firedEvents: null } as Tracking);
        facts.trackingOk = t.ok;
        if (facts.objects) facts.objects = withConversionFiring(facts.objects, shape.platform, t);
        if (facts.objects && shape.direction === "down") {
          const { loadGoalMatchContext, withGoalMatch } = await import("./ad-goal-match");
          const ctx = await loadGoalMatchContext(tenant_id, shape.platform);
          facts.objects = withGoalMatch(facts.objects, shape.platform, ctx);
        }
      }
      if (shape.cls === "status") {
        const owner = await safe(() => loadPausedByFounder(tenant_id, shape.platform, shape.objectId), null);
        facts.pausedByFounder = owner ? owner.pausedByFounder : null;
        if (owner?.firstOwnEnable && shape.direction === "up" && shape.platform === "meta") {
          if (await safe(() => metaUntouchedSinceCreate(tenant_id, shape.objectId), false)) facts.firstOwnEnable = true;
        }
      }
      if (shape.cls === "budget") {
        const ev = await safe(() => loadFounderSetBudget(tenant_id, shape.platform, shape.objectId, now, shape.direction), undefined);
        facts.founderSetBudget = ev === undefined ? null : ev !== null;
        if (ev) facts.founderSetBudgetEvent = ev;
        facts.budgetTest = await safe(() => loadBudgetTestFact(tenant_id, shape.platform, shape.objectId, action.source.run_id, now), null);
      }
      if (shape.cls === "budget" && shape.direction === "down") {
        const marked = !!action.payload && typeof action.payload === "object" && "make_room_test_id" in (action.payload as Record<string, unknown>);
        if (marked) facts.makeRoomCut = await safe(async () => (await import("./pending-test-room-cuts")).makeRoomCutLive(tenant_id, action.payload, now, action.source.id), null);
      }
      if (shape.cls === "budget" && shape.direction === "up") {
        facts.zaviRaisedRecently = await safe(() => loadZaviRaisedRecently(tenant_id, shape.platform, shape.objectId, action.source, now), null);
      }
      return facts;
    }
    case "channel_pause": {
      const { CGO_AD_CHANNELS } = await import("./cgo-ads");
      const paidChannel = CGO_AD_CHANNELS.has(action.channel_slug);
      if (action.trigger === "question_expiry") return { channelNeverApproved: opts.channelNeverApproved ?? null, paidChannel };
      const { organicEvidenceOf } = await import("./cgo-evidence");
      return channelPauseFacts({ paidChannel, neverApproved: opts.channelNeverApproved ?? null, evidence: organicEvidenceOf(opts.evidence, action.channel_slug), why: opts.why ?? "" });
    }
    case "goal_change":
      return { goalChange: opts.goalChange ?? null };
    case "dispatch_specialist": {
      const { CGO_AD_CHANNELS, cgoAdBudget } = await import("./cgo-ads");
      const { CGO_AUTO_RUN_TARGETS, CGO_ORGANIC_TARGETS } = await import("./goal-owner");
      const { getBoolSettingStrictResolved } = await import("@/services/settings");
      const autopilotNow = () => safe(() => getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id), null);
      if (CGO_AUTO_RUN_TARGETS.has(action.target)) return { targetAllowed: await autopilotNow() };
      const channelAutorun = () => safe(() => readChannelAutorun(tenant_id, action.target), null);
      if (CGO_ORGANIC_TARGETS.has(action.target)) {
        return {
          targetAllowed: await autopilotNow(),
          channelAutorun: await channelAutorun(),
        };
      }
      if (!CGO_AD_CHANNELS.has(action.target)) return { targetAllowed: false };
      const budget = await cgoAdBudget(tenant_id, now);
      if (!budget) return { targetAllowed: false };
      const autorun = await channelAutorun();
      const openAdvice = await safe(async () => {
        const { readOpenCards, refsOfRow, textNamesCard } = await import("./open-advice");
        const rows = await readOpenCards(tenant_id, [action.target]);
        const hit = rows
          .filter((r) => r.id !== action.origin_action_id)
          .some((r) => textNamesCard(action.intent, refsOfRow(r)));
        return hit ? ("conflict" as const) : ("clear" as const);
      }, "error" as const);
      return { targetAllowed: true, channelAutorun: autorun, openAdvice };
    }
  }
}

export async function readChannelAutorun(tenant_id: string, channel_slug: string): Promise<boolean> {
  const { readEffectiveAutorun } = await import("./channel-autorun");
  return readEffectiveAutorun(tenant_id, channel_slug, "unattended-policy");
}

export async function authorizeUnattended(
  tenant_id: string,
  action: UnattendedAction,
  opts: Parameters<typeof loadUnattendedFacts>[2] & { where?: string } = {},
): Promise<UnattendedVerdict> {
  let v: UnattendedVerdict;
  try {
    if (action.kind === "ad" && (await isAssistantSourceRun(tenant_id, action.source.run_id))) {
      v = { verdict: "deny", reasons: [ASSISTANT_AD_CHANGE] };
    } else {
      const facts = await loadUnattendedFacts(tenant_id, action, opts);
      v = evaluateUnattended(action, facts);
      const { checkBusinessControl } = await import("./business-control-runtime");
      const control = await checkBusinessControl(tenant_id, action, facts, opts.now ?? new Date());
      if (control.hold && v.verdict !== "deny") v = { verdict: "ask_founder", reasons: [...v.reasons, control.hold] };
      else if (control.delegatedStop && v.verdict !== "deny") {
        const reasons = v.reasons.filter(r => r !== "pause_needs_founder");
        v = { verdict: reasons.length ? "ask_founder" : "allow", reasons };
      }
      if (v.reasons.includes("pause_needs_founder")) {
        const { pauseEvidenceLine } = await import("./cgo-evidence");
        const line = pauseEvidenceLine(facts.objects, facts.trackingOk ?? null);
        if (line) v.evidence = line;
      } else if (v.verdict === "ask_founder" && action.kind === "ad" && facts.objects?.length && bodyDirection(action.payload) === "up") {
        const { pauseEvidenceLine } = await import("./cgo-evidence");
        const line = pauseEvidenceLine(facts.objects, facts.trackingOk ?? null, opts.now ?? new Date());
        if (line) v.evidence = line;
      }
    }
  } catch (e) {
    console.warn(`[unattended-policy] ${action.kind} for ${tenant_id} left for the founder: ${(e as Error).message}`);
    v = { verdict: "ask_founder", reasons: ["gate_error"] };
  }
  if (v.verdict !== "allow" || v.notes?.length) {
    try {
      const { logEvent } = await import("@/services/logging/logEvent");
      const noted = v.verdict === "allow";
      await logEvent({
        level: "info",
        source: "unattended-policy",
        code: noted ? "cgo.unattended_allow_noted" : `cgo.unattended_${v.verdict}`,
        message: `unattended ${action.kind} ${v.verdict} at ${opts.where ?? "door"}`,
        tenant_id,
        meta: { hold_reasons: (noted ? v.notes ?? [] : v.reasons).slice(0, 5).join(",") },
      });
    } catch {
    }
  }
  return v;
}

export async function evaluateUnattendedAdvisory(
  tenant_id: string,
  action: UnattendedAction,
  now: Date = new Date(),
): Promise<UnattendedVerdict> {
  const facts = await loadUnattendedFacts(tenant_id, action, { now });
  let v = evaluateUnattended(action, facts);
  const { checkBusinessControl } = await import("./business-control-runtime");
  const control = await checkBusinessControl(tenant_id, action, facts, now);
  if (control.hold && v.verdict !== "deny") v = { verdict: "ask_founder", reasons: [...v.reasons, control.hold] };
  return v;
}

const HELD_WHY: Record<string, string> = {
  over_projection_with_change: "it would put this month past your ad budget cap",
  chatgpt_paid_consent_required: "ChatGPT paid campaign management needs your explicit permission",
  chatgpt_wallet_insufficient: CHATGPT_WALLET_SHORT_WORDS,
  chatgpt_wallet_unknown: "ChatGPT wallet coverage could not be verified",
  campaign_changed: "the campaign changed after this proposal; review the current version",
  founder_pause_or_unknown: "this campaign may have been paused by you; resuming needs your approval",
  campaign_ended_or_archived: "the campaign ended or was archived",
  daily_budget_required: "this automatic operation requires a bounded daily-budget campaign",
  budget_cut_needs_founder: "reducing this budget needs your approval",
  pause_needs_founder: "Pausing is your call",
  business_object_unverified: "I could not verify the campaign budget",
  business_budget_unverified: "I could not verify the current and proposed budgets",
  business_step_exceeded: "the change exceeds your saved budget-step limit",
  business_prepare_paused_experiment: "prepare the campaign paused and register its experiment budget before activation",
  business_results_unavailable: "measured purchases or purchase revenue are unavailable",
  business_controls_no_linkedin: "experiments and controlled campaigns do not support LinkedIn yet, so your saved controls leave this LinkedIn change to you",
  business_evidence_or_experiment_required: "this needs qualifying business results or a registered experiment budget",
  business_loss_not_proven: "the evidence does not meet your saved loss rule",
  business_stop_not_authorized: "this pause does not meet your saved stop permission and evidence limits",
  business_stop_evidence_unverified: "I could not verify the evidence required for an automatic loss stop",
  experiment_rule_not_reached: "this experiment stays within its registered stop rules",
  experiment_stop_required: "the experiment has reached a stop condition",
  experiment_exposure_exceeded: "the remaining experiment budget cannot cover reporting delay",
  experiment_reporting_stale: "the experiment's spend reporting is stale",
  open_advice_conflict: "another open card is about the same thing",
  open_advice_unreadable: "I could not check the channel's other cards",
  object_unresolved: "I could not tell which campaign it changes",
  goal_number_untrusted: "the goal number behind it is not one I can trust",
  goal_unreadable: "I could not read the goal behind it",
  learning_lock: "it was changed recently and is still settling",
  learning_state_unknown: "I could not tell whether it is still settling",
  founder_paused_it: "you paused it yourself",
  budget_owner_unknown: "I could not check whether you changed its budget yourself",
  pause_owner_unknown: "I cannot tell who paused it",
  tracking_broken: "conversion tracking is not working",
  tracking_unknown: "I could not check conversion tracking",
  objective_metric_mismatch: "it is not set up to get conversions, so zero conversions says nothing",
  brand_campaign: "it is your brand search: people already looking for you, so I don't cut it on my own",
  results_not_goal: "the conversions it counts are not the ones your goal is about",
  brand_unknown: "I could not check whether it is your brand search",
  results_unverified: "I could not check whether its conversions are the ones your goal is about",
  objective_unknown: "I could not read what it optimises for",
  spend_below_floor: "it has not spent enough yet to judge",
  performance_unreadable: "I could not read its last 7 days",
  conversion_event_not_firing: "the conversion it is judged on is not being recorded",
  conversion_event_unverified: "I could not confirm its conversion event is being recorded",
  ad_facts_unreadable: "I could not read it from the ad account",
  gate_error: "my checks failed",
  delete_never_unattended: "deleting is always your call",
  review_class_never_unattended: "this kind of change is always your call",
  class_not_on_unattended_list: "this kind of change is always your call",
  body_unreadable: "I could not read the change",
  no_ad_budget: "Autopilot has no ad budget to approve it under",
  paid_channel_pause_needs_founder: "Pausing a paid channel is your call",
  channel_never_tried: "none of its cards were approved, so it was never really tried",
  insufficient_evidence: "there are no per-item numbers to judge it on",
  evidence_unreadable: "I could not read its numbers",
  evidence_missing: "I had no numbers for it",
  founder_silence_not_grounds: "you being busy is not a reason to stop a channel",
  no_location_target: "it has no location set, so it would show everywhere",
  special_ad_category_needs_founder: "it changes the campaign's special ad category, which is your declaration to Meta",
  ad_status_needs_founder: "switching an ad on or off is your call",
  raise_over_cgo_step: "it more than doubles the daily budget in one step",
  raised_in_last_day: "I already raised this budget in the last 24 hours",
  raise_history_unknown: "I could not check whether I raised this budget in the last 24 hours",
  channel_asks_first: "you set this channel to ask you first",
  autorun_unreadable: "I could not check whether this channel may run on its own",
  active_growth_budget_and_autopilot_required: "Autopilot and an ad budget both need to be on for this",
  channel_unavailable: "this channel is not available to run right now",
  chatgpt_facts_unavailable: "I could not read your ChatGPT Ads account",
  linkedin_facts_unavailable: "I could not read your LinkedIn Ads account",
  linkedin_paid_consent_required: "LinkedIn paid campaign management needs your explicit permission",
  linkedin_autopause_off: "you have not switched on auto-pause for LinkedIn Ads, so pausing is your call",
  linkedin_autopause_unreadable: "I could not check whether auto-pause is on for LinkedIn Ads",
  location_change_needs_founder: "changing where a campaign shows is your call",
  eu_location_needs_founder: "it would show in the EU, where the ad rules are yours to accept",
  group_status_needs_founder: "switching a whole campaign group on or off is your call",
  archive_needs_founder: "archiving is your call",
  linkedin_wallet_campaign: "it runs on Zavi-funded LinkedIn billing, which has its own launch path",
  linkedin_campaign_unverified: "I could not check how this LinkedIn campaign is paid for",
  linkedin_account_not_in_use: "Zavi is not set to manage this LinkedIn ad account",
  linkedin_account_unverified: "I could not check that Zavi manages this LinkedIn ad account",
  linkedin_resume_needs_daily_budget: "it has no daily budget, so I cannot hold its spend against your ad budget",
  non_usd_account: "the ad account is not in US dollars, so I cannot hold its spend against your ad budget",
  linkedin_total_budget_needs_founder: "changing a total budget is your call",
  founder_requested_change: "you asked for this change yourself, so it waits for your approval",
  [ASSISTANT_AD_CHANGE]: "it was proposed from an AI assistant, so it waits for your approval in Zavi",
  founder_staged_change: "you set up this change yourself, so it waits for your approval",
  open_advice_unresolved: "another open card may be about the same thing, or I could not tell which campaign it changes",
  open_advice_unreadable_or_conflicting: "another open card may be about the same thing, or I could not check",
  raise_step_too_large: "it more than doubles the daily budget in one step",
  raised_recently: "I already raised this budget recently",
  reddit_budget_change_needs_founder: "a Reddit budget change is your call",
  reddit_edit_needs_founder: "changing a live Reddit ad or ad group is your call",
  reddit_resume_needs_founder: "turning a Reddit campaign, ad group or ad back on is your call",
  reddit_readiness_unverified: "I could not confirm your Reddit Ads account is ready",
  x_existing_objects_need_founder: "changing an existing X campaign is your call",
  x_currency_unsupported: "this X campaign is not in US dollars",
  x_finite_budget_and_schedule_required: "it needs a total budget and an end date",
  x_launch_outside_reserved_month: "it would run past this month's ad budget",
  x_conversion_health_unverified: "I could not confirm X is recording conversions",
  x_permissions_or_funding_unverified: "I could not confirm your X Ads permissions and funding",
  [TEST_END_UNSUPPORTED]: "it is a paid test and I cannot give this ad an end date, so I will not start it on my own; approve it if you want it to run, and pause it when the test ends",
  [TEST_END_UNVERIFIED]: "it is a paid test and I could not confirm it has an end date that stops it when the test ends",
  [TEST_END_UNREADABLE]: "I could not read this test's end date",
  test_stop_stopped: "I already stopped this ad for its test, so starting it again is your call (it becomes a new test)",
  test_stop_raise: "it is a paid test priced at its current daily budget, so raising it mid-test is your call",
  test_stop_switch_on: "it is a paid test and I could not confirm its end date still stops it when the test ends",
  [TEST_STOP_UNREADABLE]: "I could not read this ad's test stop",
};

export function heldReasonWords(reasons: readonly string[]): string[] {
  return [...new Set(reasons.map((r) => founderSetBudgetWords(r) ?? budgetTestWords(r) ?? HELD_WHY[r]).filter(Boolean))].slice(0, 2);
}

export function heldChangeAsk(
  what: string,
  reasons: readonly string[],
  evidence?: string | null,
  cardExists = true,
  where?: import("@zavi/shared").DecisionHome,
  capWarning?: string | null,
): string {
  const lines = heldReasonWords(reasons);
  const because = lines.length ? ` ${lines.join("; ")}.` : "";
  const head = `I did not ${what} on my own:${because}`;
  const cap = capWarning?.trim() ? ` ${capWarning.trim().replace(/[.\s]+$/, "")}.` : "";
  const walletShort = reasons.includes("chatgpt_wallet_insufficient");
  const tail = cardExists
    ? walletShort
      ? " Add balance first; approving before that will not launch it."
      : where
        ? ` The card is waiting for you ${homePhrase(where)}.`
        : " The card is waiting for you."
    : walletShort
      ? " Add prepaid ChatGPT balance, or tell me a smaller experiment."
      : " Should I apply it?";
  const ev = evidence?.trim() ? ` ${evidence.trim()}` : "";
  if (head.length + cap.length + ev.length + tail.length <= 400) return `${head}${cap}${ev}${tail}`;
  if (cap && head.length + cap.length + tail.length <= 400) return `${head}${cap}${tail}`;
  return `${head}${tail}`.slice(0, 400);
}

export async function heldRaiseCapWarning(tenant_id: string, payload: unknown): Promise<string | null> {
  try {
    if (bodyDirection(payload) !== "up") return null;
    const b = payload as { daily_budget_usd: number; expected_current_daily_budget_usd: number };
    const daily = Math.round((Number(b.daily_budget_usd) - Number(b.expected_current_daily_budget_usd)) * 100) / 100;
    if (!(daily > 0)) return null;
    const { overProjectionGate } = await import("@/services/decisions/ad-budget");
    const p = (await overProjectionGate.read(tenant_id))?.projection;
    if (!p) return null;
    const { capWarningWords } = await import("@/services/channels/cap-warning");
    return capWarningWords(p, daily);
  } catch (e) {
    console.warn(`[unattended-policy] cap warning unreadable for ${tenant_id}: ${(e as Error).message}`);
    return null;
  }
}

export function whyCitesFounder(why: string): boolean {
  return (
    /\bfounder('s)?\b[^.]{0,60}\b(approv\w*|click\w*|open\w*|respond\w*|repl\w*|quiet|silen\w*|ignor\w*|away|inactive|absen\w*|engag\w*)/i.test(why) ||
    /\byou\s+(never|haven'?t|have not|didn'?t|did not|don'?t|do not)\s+(approv|click|open|respond|repl)\w*/i.test(why)
  );
}

export function channelPauseFacts(args: {
  paidChannel: boolean;
  neverApproved: boolean | null;
  evidence: UnattendedFacts["channelEvidence"];
  why: string;
}): UnattendedFacts {
  return { paidChannel: args.paidChannel, channelNeverApproved: args.neverApproved, channelEvidence: args.evidence, whyCitesFounder: whyCitesFounder(args.why) };
}

export type CardHold = { reasons: string[]; words: string[]; evidence: string | null; at: string };

export function cleanHoldEvidence(evidence: string | null | undefined): string | null {
  const clean = (evidence ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300);
  return clean.length ? clean : null;
}

export async function recordCardHold(
  tenant_id: string,
  source: Extract<UnattendedAction, { kind: "ad" }>["source"],
  v: Pick<UnattendedVerdict, "reasons" | "evidence">,
  now: Date = new Date(),
): Promise<boolean> {
  if (source.table !== "channel_actions" && source.table !== "decisions") return false;
  if (heldReasonWords(v.reasons).length === 0) return false;
  try {
    const hold: CardHold = {
      reasons: [...new Set(v.reasons)].slice(0, 10),
      words: heldReasonWords(v.reasons),
      evidence: cleanHoldEvidence(v.evidence),
      at: now.toISOString(),
    };
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const base = tenantClient(asTenantId(tenant_id)).from(source.table).update({ cgo_hold: hold }).eq("id", source.id).eq("tenant_id", tenant_id);
    const { data, error } = await (source.table === "channel_actions"
      ? base.eq("status", "pending").is("exec_status", null)
      : base.eq("status", "proposed")
    ).select("id");
    if (error) {
      console.warn(`[unattended-policy] recording the hold on ${source.id} failed: ${error.message}`);
      return false;
    }
    const recorded = ((data ?? []) as unknown[]).length === 1;
    if (recorded) {
      const { logEvent } = await import("@/services/logging/logEvent");
      void logEvent({
        level: "info",
        source: "unattended-policy",
        code: "cgo.card_hold_recorded",
        tenant_id,
        meta: { table: source.table, hold_reasons: hold.reasons.slice(0, 5).join(",") },
      });
    }
    return recorded;
  } catch (e) {
    console.warn(`[unattended-policy] recording the hold on ${source.id} failed: ${(e as Error).message}`);
    return false;
  }
}

export async function askFounderAboutHeld(
  tenant_id: string,
  action: Extract<UnattendedAction, { kind: "ad" }>,
  v: UnattendedVerdict,
  cardExists = true,
): Promise<boolean> {
  try {
    const oa = await import("./open-advice");
    const refs = oa.refsFromPayload(action.payload);
    const object = await oa.adObjectFor(tenant_id, action.exec_class, action.payload);
    const name = object.name;
    const channel = oa.channelsForAdClass(action.exec_class)[0] ?? action.exec_class.split(".")[0];
    const onCard = cardExists && (await recordCardHold(tenant_id, action.source, v));
    if (v.reasons.includes("open_advice_conflict")) {
      const clear = await oa.assertNoContradictingOpenAdvice({
        tenant_id,
        channels: oa.channelsForAdClass(action.exec_class),
        object,
        exclude: { action_id: action.source.table === "channel_actions" ? action.source.id : null, run_id: action.source.run_id },
        exec: { exec_class: action.exec_class, exec_payload: action.payload },
      });
      if (!clear) return true;
    }
    if (onCard) return true;
    const key = refs.ids[0] ?? oa.normName(name ?? "").slice(0, 60) ?? action.source.id;
    const home =
      cardExists && action.source.table === "decisions"
        ? (await readCardState(tenant_id, action.source.id, "decisions"))?.home
        : undefined;
    const topic = cardExists ? `held:card:${action.source.id}` : `held:${channel}:${key || action.source.id}`;
    let on_yes: import("./held-order-yes").HeldAdOrderOnYes | null = null;
    let capWarning: string | null = null;
    if (!cardExists) {
      const hy = await import("./held-order-yes");
      const candidate = hy.heldOrderOnYes(action.exec_class, action.payload);
      const live = candidate ? await hy.readLiveDailyBudget(tenant_id, candidate.exec_class, candidate.object_id) : null;
      if (candidate && live && "usd" in live) on_yes = candidate;
      capWarning = await heldRaiseCapWarning(tenant_id, action.payload);
      if (capWarning && on_yes) on_yes = { ...on_yes, cap_warned: true };
    }
    return oa.askFounderOutsideReview({
      tenant_id,
      topic,
      ...(on_yes ? { on_yes } : {}),
      ask: heldChangeAsk(
        heldChangePhrase(action.exec_class, action.payload, action.title, name),
        v.reasons,
        v.evidence,
        cardExists,
        home,
        capWarning,
      ),
    });
  } catch (e) {
    console.warn(`[unattended-policy] asking the founder failed for ${tenant_id}: ${(e as Error).message}`);
    return false;
  }
}

export function heldChangePhrase(exec_class: string, payload: unknown, title: string | null | undefined, name: string | null | undefined): string {
  const b = (payload && typeof payload === "object" ? payload : {}) as { daily_budget_usd?: unknown; expected_current_daily_budget_usd?: unknown };
  const usd = (n: number) => `$${n.toFixed(2).replace(/\.00$/, "")}`;
  const amount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const shown = name?.trim() ? cleanAdName(name) : null;
  const who = shown ? `“${clipAtWord(shown, 80)}”` : "this campaign";
  const to = amount(b.daily_budget_usd);
  if (to !== null) {
    const from = amount(b.expected_current_daily_budget_usd);
    if (from === null || Math.abs(from - to) < 0.005) return `change the daily budget of ${who} to ${usd(to)} a day`;
    return `${to > from ? "raise" : "cut"} ${who} from ${usd(from)} to ${usd(to)} a day`;
  }
  const headline = shown ? adChangeHeadline(exec_class, { ...(payload as object), verified_name: shown }) : null;
  if (headline) return headline.charAt(0).toLowerCase() + headline.slice(1);
  const t = (title ?? "").trim();
  if (t) return `apply “${clipAtWord(t, 120)}”`;
  return shown ? `change ${who}` : "make this change";
}

export function dispatchActionFromBody(body: Record<string, unknown> | null | undefined): Extract<UnattendedAction, { kind: "dispatch_specialist" }> {
  const b = body ?? {};
  return {
    kind: "dispatch_specialist",
    target: typeof b.target_agent_slug === "string" ? b.target_agent_slug.trim() : "",
    intent: typeof b.intent === "string" ? b.intent : "",
    origin_action_id: typeof b.origin_action_id === "string" ? b.origin_action_id : null,
  };
}
