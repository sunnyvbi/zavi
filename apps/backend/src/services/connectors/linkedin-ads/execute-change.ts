import { ExpectedToolError } from "@/services/tools/types";
import { canonicalTargeting } from "./account-reads";
import { logLinkedInRefusal } from "./http";
import { readLinkedInRawCampaign, resumeLinkedInCampaign, updateLinkedInCampaignBudget, updateLinkedInCampaignTargeting, type LiRawCampaign } from "./write";
import { commitAdSpend, holdLinkedInSpend, ledgerIdOf, settleAdSpendAfterError, type LinkedInExecRow } from "./spend-hold";
import { linkedinBudgetBodySchema, linkedinResumeBodySchema, linkedinTargetingBodySchema, minor, type LinkedInBudgetBody, type LinkedInResumeBody, type LinkedInTargetingBody } from "@/services/tools/linkedin-ads/_change-bodies";

export type ChangeResult = { ok: boolean; error?: string; code?: string; notice?: string; places_change?: { before: string[]; after: string[] } };

export const ENDED = new Set(["CANCELED", "ARCHIVED", "PENDING_DELETION", "REMOVED"]);
const label = (b: { name: string; campaign_id: string }) => (b.name === b.campaign_id ? "This campaign" : `"${b.name}"`);
export const INVALID = (what: string): ChangeResult => ({ ok: false, code: "linkedin_ads_body_invalid", error: `This ${what} card is missing details, so Zavi did not change anything. Dismiss it and ask for the change again.` });

export async function ownCampaign(tenant_id: string, b: { campaign_id: string; account_id: string; name: string }): Promise<{ ok: true; live: LiRawCampaign; bindingId: string | null } | { ok: false; result: ChangeResult }> {
  let bindingId: string | null = null;
  try {
    const { findCampaignBinding } = await import("@/services/ads-wallet/bindings");
    const bound = await findCampaignBinding(tenant_id, "linkedin", b.campaign_id);
    if (bound?.funding_source === "wallet")
      return { ok: false, result: { ok: false, code: "linkedin_ads_wallet_campaign", error: `${label(b)} runs in Zavi's shared LinkedIn ad account, where Zavi manages budgets and restarts through its own launch flow, so this card cannot change it.` } };
    bindingId = bound?.id ? String(bound.id) : null;
    const { linkedinAccountInUse } = await import("./own-accounts");
    if (!(await linkedinAccountInUse(tenant_id, b.account_id)))
      return { ok: false, result: { ok: false, code: "linkedin_ads_account_not_in_use", error: `The ad account on this card is not used in this workspace, so Zavi did not change ${label(b)}.` } };
  } catch (e) {
    return { ok: false, result: { ok: false, code: e instanceof ExpectedToolError ? e.code : "ads_binding_unavailable", error: "The campaign's account could not be verified, so Zavi did not change it." } };
  }
  let live: LiRawCampaign | null;
  try {
    live = await readLinkedInRawCampaign(tenant_id, b.account_id, b.campaign_id);
  } catch (e) {
    return { ok: false, result: { ok: false, code: e instanceof ExpectedToolError ? e.code : "linkedin_ads_read_failed", error: e instanceof ExpectedToolError ? e.message : "LinkedIn Ads could not be read, so Zavi did not change anything." } };
  }
  if (!live) return { ok: false, result: { ok: false, code: "linkedin_ads_campaign_not_found", error: `LinkedIn could not find ${label(b)} in the account on this card, so Zavi did not change anything.` } };
  return { ok: true, live, bindingId };
}

export const refused = async (e: unknown, tenant_id: string, b: { campaign_id: string; name: string }, verb: string): Promise<ChangeResult> => {
  await logLinkedInRefusal(e, { tenantId: tenant_id, objectId: b.campaign_id, stage: "change" });
  const msg = e instanceof ExpectedToolError ? e.message : `LinkedIn Ads did not confirm the ${verb}.`;
  return { ok: false, code: e instanceof ExpectedToolError ? e.code : "linkedin_ads_write_failed", error: `${verb[0].toUpperCase()}${verb.slice(1)} of ${label(b)} failed: ${msg}`.slice(0, 400) };
};

const liveBudget = (live: LiRawCampaign, kind: "daily" | "total") => (kind === "daily" ? live.dailyBudget : live.totalBudget);

export async function executeLinkedInResume(d: LinkedInExecRow): Promise<ChangeResult> {
  const p = linkedinResumeBodySchema.safeParse(d.body);
  if (!p.success) return INVALID("restart");
  const b: LinkedInResumeBody = p.data;
  const own = await ownCampaign(d.tenant_id, b);
  if (!own.ok) return own.result;
  const live = own.live;
  if (live.status === "ACTIVE") return { ok: true, notice: `${label(b)} was already running in LinkedIn Ads.` };
  if (live.status && ENDED.has(live.status)) return { ok: false, code: "linkedin_ads_campaign_ended", error: `LinkedIn shows ${label(b)} as ${live.status.toLowerCase()}, which cannot be restarted.` };
  if (live.status !== b.expected_status)
    return { ok: false, code: "linkedin_ads_status_drift", error: `${label(b)} is ${live.status ?? "in an unknown state"} now, not ${b.expected_status.toLowerCase()} as when this restart was proposed, so Zavi did not change it.` };
  if (b.budget) {
    const current = liveBudget(live, b.budget.kind);
    if (!current || current.currencyCode !== b.budget.currency || minor(current.amount) !== minor(b.budget.amount))
      return { ok: false, code: "linkedin_ads_budget_drift", error: `The ${b.budget.kind} budget of ${label(b)} is ${current ? `${current.currencyCode} ${current.amount}` : "no longer set"} now, not ${b.budget.currency} ${b.budget.amount} as on this card, so Zavi did not restart it. Ask for the restart again from the current budget.` };
  }
  let schedule: { start: number; end: number } | undefined;
  const liveEnd = typeof live.runSchedule?.end === "number" ? live.runSchedule.end : null;
  const cardEnd = b.run_end_at ? Date.parse(b.run_end_at) : null;
  if (live.status === "COMPLETED" || (liveEnd !== null && liveEnd <= Date.now())) {
    const end = b.run_end_at ? Date.parse(b.run_end_at) : NaN;
    const start = live.runSchedule?.start;
    if (!Number.isFinite(end) || end <= Date.now()) return { ok: false, code: "linkedin_ads_end_date_passed", error: `The new end date on this card has passed, so ${label(b)} cannot be restarted with it. Ask for the restart again with a later end date.` };
    if (typeof start !== "number") return { ok: false, code: "linkedin_ads_schedule_unread", error: `LinkedIn did not return the original start date of ${label(b)}, which a restart of a completed campaign must keep, so Zavi did not change it.` };
    if (!b.run_start_at || Date.parse(b.run_start_at) !== start)
      return { ok: false, code: "linkedin_ads_schedule_drift", error: `The start date of ${label(b)} changed in LinkedIn after this card was written, so Zavi did not restart it. Ask for the restart again.` };
    schedule = { start, end };
  } else if (liveEnd !== cardEnd)
    return { ok: false, code: "linkedin_ads_schedule_drift", error: `The end date of ${label(b)} changed in LinkedIn after this card was written, so Zavi did not restart it. Ask for the restart again.` };
  const daily = b.budget?.kind === "daily" ? live.dailyBudget : null;
  const held = await holdLinkedInSpend(d, { op: "resume", object_id: ledgerIdOf(b.campaign_id, own.bindingId), cents: daily ? minor(daily.amount) : 0, currency: daily?.currencyCode ?? null });
  if (!held.ok) return held.result;
  try {
    await resumeLinkedInCampaign(d.tenant_id, b.account_id, b.campaign_id, schedule);
  } catch (e) {
    await settleAdSpendAfterError(held.hold, e);
    return refused(e, d.tenant_id, b, "restart");
  }
  await commitAdSpend(held.hold, ledgerIdOf(b.campaign_id, own.bindingId));
  return { ok: true, notice: `Restarted ${label(b)} in LinkedIn Ads${schedule ? `, running until ${new Date(schedule.end).toISOString().slice(0, 10)}` : ""}.` };
}

export async function executeLinkedInBudgetChange(d: LinkedInExecRow): Promise<ChangeResult> {
  const p = linkedinBudgetBodySchema.safeParse(d.body);
  if (!p.success) return INVALID("budget");
  const b: LinkedInBudgetBody = p.data;
  if (b.proposed.currency !== b.expected_current.currency) return INVALID("budget");
  const own = await ownCampaign(d.tenant_id, b);
  if (!own.ok) return own.result;
  const live = own.live;
  if (live.status && ENDED.has(live.status)) return { ok: false, code: "linkedin_ads_campaign_ended", error: `LinkedIn shows ${label(b)} as ${live.status.toLowerCase()}, so its budget was left alone.` };
  const current = liveBudget(live, b.kind);
  if (!current) return { ok: false, code: "linkedin_ads_budget_kind_changed", error: `${label(b)} no longer has a ${b.kind} budget in LinkedIn, so Zavi did not change it.` };
  if (current.currencyCode !== b.expected_current.currency || minor(current.amount) !== minor(b.expected_current.amount))
    return { ok: false, code: "linkedin_ads_budget_drift", error: `The ${b.kind} budget of ${label(b)} is ${current.currencyCode} ${current.amount} now, not ${b.expected_current.currency} ${b.expected_current.amount} as when this change was proposed, so Zavi did not change it. Ask for the change again from the current number.` };
  if (minor(current.amount) === minor(b.proposed.amount)) return { ok: true, notice: `The ${b.kind} budget of ${label(b)} was already ${b.proposed.currency} ${b.proposed.amount}.` };
  const raise = minor(b.proposed.amount) - minor(current.amount);
  const held = raise > 0 ? await holdLinkedInSpend(d, { op: "raise", object_id: ledgerIdOf(b.campaign_id, own.bindingId), cents: b.kind === "daily" ? raise : 0, currency: b.kind === "daily" ? b.proposed.currency : null }) : null;
  if (held && !held.ok) return held.result;
  try {
    await updateLinkedInCampaignBudget(d.tenant_id, b.account_id, b.campaign_id, b.kind, b.proposed);
  } catch (e) {
    if (held) await settleAdSpendAfterError(held.hold, e);
    return refused(e, d.tenant_id, b, "budget change");
  }
  if (held) await commitAdSpend(held.hold, ledgerIdOf(b.campaign_id, own.bindingId));
  return { ok: true, notice: `Set the ${b.kind} budget of ${label(b)} to ${b.proposed.currency} ${b.proposed.amount} in LinkedIn Ads (was ${b.expected_current.amount}).` };
}

export async function executeLinkedInTargetingChange(d: { tenant_id: string; body: unknown }): Promise<ChangeResult> {
  const p = linkedinTargetingBodySchema.safeParse(d.body);
  if (!p.success) return INVALID("targeting");
  const b: LinkedInTargetingBody = p.data;
  const own = await ownCampaign(d.tenant_id, b);
  if (!own.ok) return own.result;
  const live = own.live;
  if (live.status && ENDED.has(live.status)) return { ok: false, code: "linkedin_ads_campaign_ended", error: `LinkedIn shows ${label(b)} as ${live.status.toLowerCase()}, so its targeting was left alone.` };
  if (canonicalTargeting(live.targetingCriteria) !== b.before_fingerprint)
    return { ok: false, code: "linkedin_ads_targeting_drift", error: `The audience of ${label(b)} was edited in LinkedIn after this change was proposed, so Zavi did not change it. Ask for the change again from the current audience.` };
  try {
    await updateLinkedInCampaignTargeting(d.tenant_id, b.account_id, b.campaign_id, b.after_criteria);
  } catch (e) {
    return refused(e, d.tenant_id, b, "location change");
  }
  return { ok: true, notice: `Changed the locations of ${label(b)} in LinkedIn Ads to ${b.places_after.join(", ") || "none"} (was ${b.places_before.join(", ") || "none"}).`, places_change: { before: b.places_before, after: b.places_after } };
}
