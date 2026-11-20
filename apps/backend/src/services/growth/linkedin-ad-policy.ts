import { CGO_MAX_RAISE_STEP } from "./cgo-spend-authority";
import { founderSetBudgetReason } from "./founder-set-budget";
import { linkedinLocationInEu } from "@/services/connectors/linkedin-ads/targeting";
import {
  LINKEDIN_AD_STATUS_CLASS,
  LINKEDIN_AGENT_ORIGIN,
  LINKEDIN_ARCHIVE_CLASS,
  LINKEDIN_BUDGET_CLASS,
  LINKEDIN_CAMPAIGN_EDIT_CLASS,
  LINKEDIN_CREATE_AD_CLASS,
  LINKEDIN_CREATE_CAMPAIGN_CLASS,
  LINKEDIN_DUPLICATE_CLASS,
  LINKEDIN_GROUP_EDIT_CLASS,
  LINKEDIN_RESUME_CLASS,
  LINKEDIN_SWAP_AD_CLASS,
  LINKEDIN_TARGETING_CLASS,
  linkedinAdStatusBodySchema,
  linkedinArchiveBodySchema,
  linkedinBudgetBodySchema,
  linkedinCampaignEditBodySchema,
  linkedinCampaignEditRaisesSpend,
  linkedinCreateAdBodySchema,
  linkedinCreateCampaignBodySchema,
  linkedinDuplicateBodySchema,
  linkedinGroupEditBodySchema,
  linkedinGroupEditRaisesSpend,
  linkedinResumeBodySchema,
  linkedinSwapAdBodySchema,
  linkedinTargetingBodySchema,
  minor,
} from "@/services/tools/linkedin-ads/_change-bodies";
import type { UnattendedAction, UnattendedFacts, UnattendedVerdict } from "./unattended-policy";

type Action = Extract<UnattendedAction, { kind: "ad" }>;

export const LINKEDIN_POLICY_CLASSES: ReadonlySet<string> = new Set([
  LINKEDIN_RESUME_CLASS,
  LINKEDIN_BUDGET_CLASS,
  LINKEDIN_TARGETING_CLASS,
  LINKEDIN_CAMPAIGN_EDIT_CLASS,
  LINKEDIN_GROUP_EDIT_CLASS,
  LINKEDIN_ARCHIVE_CLASS,
  LINKEDIN_AD_STATUS_CLASS,
  LINKEDIN_CREATE_AD_CLASS,
  LINKEDIN_SWAP_AD_CLASS,
  LINKEDIN_CREATE_CAMPAIGN_CLASS,
  LINKEDIN_DUPLICATE_CLASS,
]);

export type LinkedinShape =
  | { kind: "status"; campaignId: string; accountId: string; currency: string | null; dailyBudget: boolean }
  | { kind: "budget"; campaignId: string; accountId: string; currency: string; daily: boolean; direction: "up" | "down" | "same"; fromCents: number; toCents: number }
  | { kind: "create"; campaignId: string | null; accountId: string; currency: string | null; asks: string[] }
  | { kind: "settings"; campaignId: string | null; accountId: string; spendUp: boolean; asks: string[] }
  | { kind: "never"; why: string; founders?: true };

export type LinkedinAdFacts = {
  available: boolean | null;
  wallet: boolean | null;
  accountInUse: boolean | null;
  liveTouchedSinceZavi?: boolean | null;
  consent?: boolean | null;
};

export const LINKEDIN_HELD_CLASSES: ReadonlySet<string> = new Set([
  LINKEDIN_RESUME_CLASS,
  LINKEDIN_BUDGET_CLASS,
  LINKEDIN_CREATE_CAMPAIGN_CLASS,
  LINKEDIN_DUPLICATE_CLASS,
]);

const spendsMoreShape = (shape: LinkedinShape) =>
  shape.kind === "create" || shape.kind === "status" || (shape.kind === "budget" && shape.direction === "up") || (shape.kind === "settings" && shape.spendUp);

function heldAtExecute(action: Pick<Action, "exec_class" | "payload">): boolean {
  if (!LINKEDIN_HELD_CLASSES.has(action.exec_class)) return false;
  if (action.exec_class !== LINKEDIN_DUPLICATE_CLASS) return true;
  const target = action.payload && typeof action.payload === "object" ? (action.payload as { target?: unknown }).target : undefined;
  return target === "campaign";
}

export function linkedinSpendUpNotHeld(action: Pick<Action, "exec_class" | "payload">): boolean {
  return spendsMoreShape(linkedinShape(action)) && !heldAtExecute(action);
}

const locationsOf = (summary: string) => summary.split("; ")[0] ?? "";

const parsed = <T>(r: { success: true; data: T } | { success: false }): T | null => (r.success ? r.data : null);

export function linkedinShape(action: Pick<Action, "exec_class" | "payload">): LinkedinShape {
  const cls = action.exec_class;
  const p = action.payload;
  if (cls === LINKEDIN_ARCHIVE_CLASS) {
    const a = parsed(linkedinArchiveBodySchema.safeParse(p));
    return { kind: "never", why: a?.mode === "archive" ? "archive_needs_founder" : "delete_never_unattended" };
  }
  if (!LINKEDIN_POLICY_CLASSES.has(cls)) return { kind: "never", why: "class_not_on_unattended_list" };
  const origin = p && typeof p === "object" ? (p as { origin?: unknown }).origin : undefined;
  if (origin !== LINKEDIN_AGENT_ORIGIN) return { kind: "never", why: "founder_requested_change", founders: true };
  switch (cls) {
    case LINKEDIN_RESUME_CLASS: {
      const b = parsed(linkedinResumeBodySchema.safeParse(p));
      if (!b) return { kind: "never", why: "body_unreadable" };
      return { kind: "status", campaignId: b.campaign_id, accountId: b.account_id, currency: b.budget?.currency ?? null, dailyBudget: b.budget?.kind === "daily" };
    }
    case LINKEDIN_BUDGET_CLASS: {
      const b = parsed(linkedinBudgetBodySchema.safeParse(p));
      if (!b || b.proposed.currency !== b.expected_current.currency) return { kind: "never", why: "body_unreadable" };
      const fromCents = minor(b.expected_current.amount);
      const toCents = minor(b.proposed.amount);
      return { kind: "budget", campaignId: b.campaign_id, accountId: b.account_id, currency: b.proposed.currency, daily: b.kind === "daily", direction: toCents > fromCents ? "up" : toCents < fromCents ? "down" : "same", fromCents, toCents };
    }
    case LINKEDIN_TARGETING_CLASS: {
      const b = parsed(linkedinTargetingBodySchema.safeParse(p));
      if (!b) return { kind: "never", why: "body_unreadable" };
      return { kind: "settings", campaignId: b.campaign_id, accountId: b.account_id, spendUp: true, asks: ["location_change_needs_founder", ...(b.places_after.length ? [] : ["no_location_target"])] };
    }
    case LINKEDIN_AD_STATUS_CLASS: {
      const b = parsed(linkedinAdStatusBodySchema.safeParse(p));
      if (!b) return { kind: "never", why: "body_unreadable" };
      return { kind: "settings", campaignId: b.campaign_id, accountId: b.account_id, spendUp: b.status === "ACTIVE", asks: ["ad_status_needs_founder"] };
    }
    case LINKEDIN_CAMPAIGN_EDIT_CLASS: {
      const b = parsed(linkedinCampaignEditBodySchema.safeParse(p));
      if (!b) return { kind: "never", why: "body_unreadable" };
      const t = b.changes.targeting;
      const asks = t && locationsOf(t.summary_before) !== locationsOf(t.summary_after) ? ["location_change_needs_founder"] : [];
      if (t && /^Locations: none\b/.test(t.summary_after)) asks.push("no_location_target");
      return { kind: "settings", campaignId: b.campaign_id, accountId: b.account_id, spendUp: linkedinCampaignEditRaisesSpend(b), asks };
    }
    case LINKEDIN_GROUP_EDIT_CLASS: {
      const b = parsed(linkedinGroupEditBodySchema.safeParse(p));
      if (!b) return { kind: "never", why: "body_unreadable" };
      const { status, ...rest } = b.changes;
      const asks = [...(status ? ["group_status_needs_founder"] : []), ...(b.changes.total_budget ? ["linkedin_total_budget_needs_founder"] : [])];
      const spendUp = Object.keys(rest).length > 0 && linkedinGroupEditRaisesSpend({ ...b, changes: rest as typeof b.changes });
      return { kind: "settings", campaignId: null, accountId: b.account_id, spendUp: spendUp || status?.after === "ACTIVE", asks };
    }
    case LINKEDIN_CREATE_AD_CLASS: {
      const b = parsed(linkedinCreateAdBodySchema.safeParse(p));
      if (!b) return { kind: "never", why: "body_unreadable" };
      return { kind: "create", campaignId: b.campaign_id, accountId: b.account_id, currency: null, asks: [] };
    }
    case LINKEDIN_SWAP_AD_CLASS: {
      const b = parsed(linkedinSwapAdBodySchema.safeParse(p));
      if (!b) return { kind: "never", why: "body_unreadable" };
      return { kind: "create", campaignId: b.campaign_id, accountId: b.account_id, currency: null, asks: [] };
    }
    case LINKEDIN_CREATE_CAMPAIGN_CLASS: {
      const b = parsed(linkedinCreateCampaignBodySchema.safeParse(p));
      if (!b || b.daily_budget.currency !== b.unit_cost.currency) return { kind: "never", why: "body_unreadable" };
      const asks: string[] = [];
      if (b.geo_urns.length === 0) asks.push("no_location_target");
      if (b.places.some(linkedinLocationInEu)) asks.push("eu_location_needs_founder");
      return { kind: "create", campaignId: null, accountId: b.account_id, currency: b.daily_budget.currency, asks };
    }
    default: {
      const b = parsed(linkedinDuplicateBodySchema.safeParse(p));
      if (!b) return { kind: "never", why: "body_unreadable" };
      return { kind: "create", campaignId: b.target === "campaign" ? b.source_id : b.campaign_id, accountId: b.account_id, currency: null, asks: [] };
    }
  }
}

export function linkedinAdDirection(action: Pick<Action, "exec_class" | "payload">): "up" | "down" | "create" | "other" {
  const s = linkedinShape(action);
  if (s.kind === "status") return "up";
  if (s.kind === "budget") return s.direction === "same" ? "other" : s.direction;
  if (s.kind === "create") return "create";
  if (s.kind === "settings") return s.spendUp ? "up" : "other";
  return "other";
}

const NOTE_ONLY_UP: ReadonlySet<string> = new Set(["tracking_unknown", "goal_number_untrusted"]);

export function evaluateLinkedinAd(action: Action, f: UnattendedFacts): UnattendedVerdict {
  const shape = linkedinShape(action);
  if (shape.kind === "never") return { verdict: "deny", reasons: [shape.why] };
  const deny: string[] = [];
  const ask: string[] = [];
  const li = f.linkedinAd;
  if (li?.available !== true) ask.push("channel_unavailable");
  if (li?.wallet === true) deny.push("linkedin_wallet_campaign");
  else if (li?.wallet !== false) ask.push("linkedin_campaign_unverified");
  if (li?.accountInUse === false) deny.push("linkedin_account_not_in_use");
  else if (li?.accountInUse !== true) ask.push("linkedin_account_unverified");
  if (li?.consent !== true) ask.push("linkedin_paid_consent_required");
  if (f.refsResolved === false && shape.kind !== "create") ask.push("object_unresolved");
  if (f.openAdvice === "conflict") ask.push("open_advice_conflict");
  else if (f.openAdvice !== "clear") ask.push("open_advice_unreadable");
  if (f.goal === null || f.goal === undefined) ask.push("goal_unreadable");
  else if (f.goal.present && f.goal.numberTrusted !== true) ask.push("goal_number_untrusted");
  const spendsMore = spendsMoreShape(shape);
  if (spendsMore && !heldAtExecute(action)) ask.push("linkedin_change_not_held");
  if (spendsMore) {
    if (f.channelAutorun === false) ask.push("channel_asks_first");
    else if (f.channelAutorun !== true) ask.push("autorun_unreadable");
    if (f.spendUpUnderBudget !== true) ask.push("no_ad_budget");
  }
  if (shape.kind === "create" || shape.kind === "settings") ask.push(...shape.asks);
  if (shape.kind === "create" && shape.currency !== null && shape.currency !== "USD") ask.push("non_usd_account");
  if (shape.kind === "status") {
    if (!shape.dailyBudget) ask.push("linkedin_resume_needs_daily_budget");
    else if (shape.currency !== "USD") ask.push("non_usd_account");
    if (f.pausedByFounder !== false) ask.push(f.pausedByFounder === true ? "founder_paused_it" : "pause_owner_unknown");
    else if (li?.liveTouchedSinceZavi !== false) ask.push("pause_owner_unknown");
  }
  if (shape.kind === "budget") {
    if (!shape.daily) ask.push("linkedin_total_budget_needs_founder");
    if (shape.direction !== "up") {
      ask.push("tracking_unknown");
      return { verdict: deny.length ? "deny" : "ask_founder", reasons: [...new Set([...deny, ...ask])] };
    }
    if (shape.currency !== "USD") ask.push("non_usd_account");
    if (!(shape.fromCents > 0 && shape.toCents <= shape.fromCents * (1 + CGO_MAX_RAISE_STEP))) ask.push("raise_over_cgo_step");
    if (f.zaviRaisedRecently === true) ask.push("raised_in_last_day");
    else if (f.zaviRaisedRecently !== false) ask.push("raise_history_unknown");
    if (f.founderSetBudget === true) ask.push(founderSetBudgetReason(f.founderSetBudgetEvent, "linkedin"));
    else if (f.founderSetBudget !== false) ask.push("budget_owner_unknown");
    if (f.trackingOk !== true) ask.push("tracking_unknown");
  }
  const reasons = [...new Set(ask)];
  if (deny.length) return { verdict: "deny", reasons: [...deny, ...reasons] };
  const underBudget = spendsMore && f.spendUpUnderBudget === true;
  const held = underBudget ? reasons.filter((r) => !NOTE_ONLY_UP.has(r)) : reasons;
  const notes = underBudget ? reasons.filter((r) => NOTE_ONLY_UP.has(r)) : [];
  return held.length ? { verdict: "ask_founder", reasons: held } : { verdict: "allow", reasons: [], ...(notes.length ? { notes } : {}) };
}

const LIVE_SETTLE_MS = 60_000;

export async function loadLinkedinAdFacts(tenantId: string, action: Action, now: Date): Promise<UnattendedFacts> {
  const shape = linkedinShape(action);
  if (shape.kind === "never") return {};
  const up = await import("./unattended-policy");
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      console.warn(`[linkedin-ad-policy] fact unreadable: ${(e as Error).message}`);
      return fallback;
    }
  };
  const advice = await safe(() => up.loadOpenAdviceForAd(tenantId, action), { refsResolved: true, openAdvice: "error" as const });
  const { cgoAdBudget } = await import("./cgo-ads");
  const binding = shape.campaignId
    ? await safe(async () => (await import("@/services/ads-wallet/bindings")).findCampaignBinding(tenantId, "linkedin", shape.campaignId!), undefined)
    : null;
  const facts: UnattendedFacts = {
    ...advice,
    goal: await safe(() => up.loadGoalFact(tenantId, action.source.run_id, now), null),
    channelAutorun: await safe(() => up.readChannelAutorun(tenantId, "linkedin_ads"), null),
    spendUpUnderBudget: await safe(async () => (await cgoAdBudget(tenantId, now)) !== null, null),
    trackingOk: null,
    linkedinAd: {
      available: await safe(linkedinAvailable(tenantId), null),
      wallet: binding === undefined ? null : binding?.funding_source === "wallet",
      accountInUse: await safe(async () => (await import("@/services/connectors/linkedin-ads/own-accounts")).linkedinAccountInUse(tenantId, shape.accountId), null),
      consent: await safe(async () => (await import("@/services/ads-wallet/consent")).sharedWalletConsent(tenantId), null),
    },
  };
  const outsideIds = binding && binding.id ? [String(binding.id)] : [];
  if (shape.kind === "status") {
    const owner = await safe(() => up.loadPausedByFounder(tenantId, "linkedin", shape.campaignId, outsideIds), null);
    facts.pausedByFounder = owner ? owner.pausedByFounder : null;
    if (owner?.pausedByFounder === false) {
      facts.linkedinAd!.liveTouchedSinceZavi = await safe(() => liveTouchedSince(tenantId, shape.accountId, shape.campaignId, owner.lastAt ?? null), null);
    }
  }
  if (shape.kind === "budget" && shape.direction === "up") {
    const ev = await safe(() => up.loadFounderSetBudget(tenantId, "linkedin", shape.campaignId, now, "up", outsideIds), undefined);
    facts.founderSetBudget = ev === undefined ? null : ev !== null;
    if (ev) facts.founderSetBudgetEvent = ev;
    facts.zaviRaisedRecently = await safe(() => up.loadZaviRaisedRecently(tenantId, "linkedin", shape.campaignId, action.source, now), null);
  }
  return facts;
}

function linkedinAvailable(tenantId: string): () => Promise<boolean> {
  return async () => {
    const { isLinkedInAdsWriteEnabled } = await import("@/services/tools/linkedin-ads/write/_flag-check");
    const { checkAgentTier } = await import("@/services/agents/entitlement");
    const { isChannelLockedStrict } = await import("@/services/channels/lock");
    const tier = await checkAgentTier(tenantId, "linkedin_ads");
    return tier.enforced && tier.allowed && !(await isChannelLockedStrict("linkedin_ads")) && (await isLinkedInAdsWriteEnabled());
  };
}

async function liveTouchedSince(tenantId: string, accountId: string, campaignId: string, lastAt: string | null): Promise<boolean> {
  const { readLinkedInRawCampaign } = await import("@/services/connectors/linkedin-ads/write");
  const live = (await readLinkedInRawCampaign(tenantId, accountId, campaignId)) as { changeAuditStamps?: { created?: { time?: number }; lastModified?: { time?: number } } } | null;
  if (!live) throw new Error("campaign not found");
  const modified = live.changeAuditStamps?.lastModified?.time;
  if (typeof modified !== "number") throw new Error("last change unreadable");
  const since = lastAt ? Date.parse(lastAt) : live.changeAuditStamps?.created?.time;
  if (typeof since !== "number" || !Number.isFinite(since)) throw new Error("reference time unreadable");
  return modified > since + LIVE_SETTLE_MS;
}
