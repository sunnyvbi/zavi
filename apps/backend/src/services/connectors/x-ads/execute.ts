import { dailyHoldEndsOn } from "@/services/growth/ad-plan-shape";
import { assertXComposeAccess, assertXWriteAccess } from "./resources";
import { reserveXSpend, settleXSpend } from "./spend";
import { cgoTestEndForRun, earlierEndIso } from "@/services/growth/cgo-test-end";
import { envelopeDays } from "@/services/growth/test-envelope";
import { releaseAdSpendForObject, rebaseAdSpendForObject, noteAdSpendObject, lifetimeDailyUsd, type AdSpendHold } from "@/services/decisions/ad-budget";
import type { z } from "zod";
import { ExpectedToolError } from "@/services/tools/types";
import { isChannelLockedStrict } from "@/services/channels/lock";
import { NON_TENANT_APPROVAL_SOURCES } from "@/services/decisions/ads-approval-authority";
import { channelPlanLock } from "@/services/growth/preview-plan";
import { planUpgradeMessage } from "@/services/agents/entitlement";
import { PLAN_UPGRADE_REQUIRED } from "@/services/billing/tiers";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import {
  addXTargeting,
  createXCampaign,
  createXLineItem,
  createXPromotedOnlyPost,
  getXLineItemEnd,
  getXCampaign,
  listXFundingInstruments,
  promoteXTweets,
  updateXCampaign,
  xAdsTenantToken,
  xPromotableUserId,
  type UserToken,
  type XCampaignRow,
  type XTargetingCriterion,
} from "./client";
import { xActionRaisesSpend } from "./schema";
export { xActionRaisesSpend };
import { assertBudgetOrder, createBody, isoNow, statusBody, updateBody, X_MAX_DAILY_BUDGET, X_MAX_TOTAL_BUDGET, type XCreateBody } from "./schema";

const GENDER_VALUE: Record<"MALE" | "FEMALE", string> = { MALE: "1", FEMALE: "2" };

export function xTargetingOf(b: Pick<XCreateBody, "locations" | "excluded_locations" | "audience">): XTargetingCriterion[] {
  const a = b.audience;
  return [
    ...b.locations.map((l) => ({ targeting_type: "LOCATION", targeting_value: l.id, operator_type: "EQ" as const })),
    ...b.excluded_locations.map((l) => ({ targeting_type: "LOCATION", targeting_value: l.id, operator_type: "NE" as const })),
    ...a.keywords.map((k) => ({ targeting_type: "BROAD_KEYWORD", targeting_value: k, operator_type: "EQ" as const })),
    ...a.languages.map((l) => ({ targeting_type: "LANGUAGE", targeting_value: l, operator_type: "EQ" as const })),
    ...a.genders.map((g) => ({ targeting_type: "GENDER", targeting_value: GENDER_VALUE[g], operator_type: "EQ" as const })),
    ...a.ages.map((g) => ({ targeting_type: "AGE", targeting_value: g, operator_type: "EQ" as const })),
  ];
}

export type XExecResult = { ok: boolean; error?: string; code?: string; notice?: string; outcome_unknown?: boolean; agent_outcome?: string; created?: import("@/services/channels/created-object").CreatedObject };
export type XExecRow = { id?: string; decision_class?: string; exec_source?: string; agent_run_id?: string | null; tenant_id: string; body: unknown; approved_by?: string | null; approved_by_source?: string | null };

const refuse = (code: string, error: string): XExecResult => ({ ok: false, code, error });

export function fail(e: unknown): XExecResult {
  if (!(e instanceof ExpectedToolError)) return refuse("x_ads_write_failed", (e as Error)?.message ?? "x_ads_write_failed");
  return e.code === "x_ads_outcome_unknown" ? { ok: false, outcome_unknown: true, code: e.code, error: e.message } : refuse(e.code, e.message);
}

async function lockRefusal(): Promise<XExecResult | null> {
  const locked = await isChannelLockedStrict("x_ads").catch(() => null);
  if (locked === false) return null;
  return refuse(
    "x_ads_write_disabled",
    locked === null
      ? "Zavi could not confirm X Ads changes are switched on, so nothing was changed. Approve again in a minute."
      : "X Ads changes are switched off in Zavi right now, so nothing was changed.",
  );
}

export async function prepare<S extends z.ZodTypeAny>(
  row: XExecRow,
  schema: S,
  isPause: (b: z.infer<S>) => boolean,
): Promise<{ b: z.infer<S>; t: UserToken } | XExecResult> {
  const p = schema.safeParse(row.body);
  if (!p.success) return refuse("x_ads_body_invalid", "X Ads card body invalid");
  const b = p.data;
  if (!isPause(b)) {
    if (row.approved_by_source && NON_TENANT_APPROVAL_SOURCES.has(row.approved_by_source) && !(row.approved_by_source === "cgo" && row.decision_class === "x_ads.create_campaign")) {
      return refuse("x_ads_needs_person", "Existing-object edits and deletion require a person. Only bounded new campaigns may be approved by Autopilot.");
    }
    if (row.approved_by_source !== "cgo" && xActionRaisesSpend(row.decision_class, row.body)) {
      if (!row.approved_by) return refuse("x_ads_admin_required", "Only a workspace owner or admin can approve an X Ads launch, resume or budget increase.");
      let role: string | null;
      try { role = await loadTenantRoleFor(row.approved_by, row.tenant_id); } catch { return refuse("x_ads_role_unavailable", "The approver's workspace role could not be checked. Nothing in X Ads changed; approve again in a minute."); }
      if (role !== "owner" && role !== "admin") return refuse("x_ads_admin_required", "Only a workspace owner or admin can approve an X Ads launch, resume or budget increase. Nothing in X Ads changed.");
    }
    const locked = await lockRefusal();
    if (locked) return locked;
    const plan = await channelPlanLock(row.tenant_id, "x_ads");
    if (plan) return refuse(PLAN_UPGRADE_REQUIRED, `${planUpgradeMessage("x_ads", plan.required_tier)} Nothing in X Ads changed.`);
  }
  try {
    const t = await xAdsTenantToken(row.tenant_id);
    const account = (b as { account_id?: string; request?: { account_id: string } }).account_id ?? (b as { request?: { account_id: string } }).request?.account_id;
    if (!account) return refuse("x_ads_body_invalid", "X Ads account missing");
    await assertXWriteAccess(t, account);
    if (row.approved_by_source === "cgo" && !isPause(b)) {
      if (!row.id) return refuse("x_ads_action_missing", "Autopilot execution requires a persisted action.");
      const { cgoAdBudget } = await import("@/services/growth/cgo-ads");
      const { authorizeUnattended } = await import("@/services/growth/unattended-policy");
      if (!(await cgoAdBudget(row.tenant_id))) return refuse("x_ads_autopilot_off", "Autopilot or its ad budget is no longer active.");
      const verdict = await authorizeUnattended(row.tenant_id, { kind: "ad", exec_class: row.decision_class!, payload: row.body, source: { table: row.exec_source === "channel_actions" ? "channel_actions" : "decisions", id: row.id, run_id: row.agent_run_id ?? null } }, { where: "x_ads_write" });
      if (verdict.verdict !== "allow") return refuse("x_ads_policy_held", `Founder review required: ${verdict.reasons.join(", ")}`);
    }
    return { b, t };
  } catch (e) {
    return e instanceof ExpectedToolError && e.code === "x_ads_not_connected"
      ? refuse("x_ads_not_connected", "Reconnect X Ads, then approve again.")
      : e instanceof ExpectedToolError ? fail(e) : refuse("x_ads_account_check_failed", "Could not read the X Ads connection. Approve again in a minute.");
  }
}

export const isResult = (v: object): v is XExecResult => "ok" in v;

async function statusAfterWrite(t: UserToken, accountId: string, campaignId: string, want: string, what: string): Promise<void> {
  let status: string | undefined;
  try {
    status = (await getXCampaign(t, accountId, campaignId))?.status;
  } catch {
    status = undefined;
  }
  if (status !== want) throw new ExpectedToolError("x_ads_outcome_unknown", `X Ads did not confirm ${what}. Check Ads Manager before retrying.`);
}

async function current(t: UserToken, accountId: string, campaignId: string, name: string): Promise<XCampaignRow | XExecResult> {
  return (await getXCampaign(t, accountId, campaignId)) ?? refuse("x_ads_campaign_not_found", `Campaign "${name}" is no longer in the X Ads account.`);
}

export async function executeXSetStatus(row: XExecRow): Promise<XExecResult> {
  const ready = await prepare(row, statusBody, (b) => b.status === "PAUSED");
  if (isResult(ready)) return ready;
  const { b, t } = ready;
  const resume = b.status === "ACTIVE";
  let hold: AdSpendHold | undefined;
  try {
    const c = await current(t, b.account_id, b.campaign_id, b.name);
    if (isResult(c)) return c;
    if (c.status === b.status) return { ok: true, notice: `"${b.name}" was already ${resume ? "on" : "paused"} in X Ads.` };
    if (c.status !== (resume ? "PAUSED" : "ACTIVE")) {
      return refuse(resume ? "x_ads_campaign_not_paused" : "x_ads_campaign_not_active", `Campaign "${b.name}" is ${c.status}, so Zavi did not change it.`);
    }
    if (resume && (c.daily_budget !== b.daily_budget || (b.total_budget !== undefined && c.total_budget !== b.total_budget))) {
      return refuse("x_ads_campaign_drifted", `The budget of "${b.name}" changed since this was proposed, so Zavi did not turn it on. Propose it again.`);
    }
    if (
      resume &&
      ((c.daily_budget === null && c.total_budget === null) || (c.daily_budget ?? 0) > X_MAX_DAILY_BUDGET || (c.total_budget ?? 0) > X_MAX_TOTAL_BUDGET)
    ) {
      return refuse(
        "x_ads_budget_over_cap",
        `"${b.name}" has no campaign budget Zavi can read, or one above what Zavi may turn on (${X_MAX_DAILY_BUDGET.toLocaleString("en-US")} a day, ${X_MAX_TOTAL_BUDGET.toLocaleString("en-US")} in total), so Zavi did not turn it on. Lower it or turn it on in X Ads Manager.`,
      );
    }
    if (resume) {
      if (c.daily_budget === null) return refuse("x_ads_budget_unknown", "A readable daily budget is required to resume X Ads.");
      hold = await reserveXSpend(row, "resume", c.campaign_id, c.daily_budget, c.currency);
    }
    await updateXCampaign(t, b.account_id, b.campaign_id, { entity_status: b.status });
    await statusAfterWrite(t, b.account_id, b.campaign_id, b.status, "the campaign status");
    if (hold) await settleXSpend(hold, c.campaign_id);
    if (!resume) await releaseAdSpendForObject(row.tenant_id, "x", c.campaign_id);
    return { ok: true, notice: resume ? `Turned "${b.name}" back on in X Ads.` : `Paused "${b.name}" in X Ads.` };
  } catch (e) {
    if (hold) await settleXSpend(hold, null, e, true);
    return fail(e);
  }
}

export async function executeXUpdateCampaign(row: XExecRow): Promise<XExecResult> {
  const ready = await prepare(row, updateBody, () => false);
  if (isResult(ready)) return ready;
  const { b, t } = ready;
  let hold: AdSpendHold | undefined;
  try {
    const c = await current(t, b.account_id, b.campaign_id, b.name);
    if (isResult(c)) return c;
    if (c.name !== b.before.name || c.daily_budget !== b.before.daily_budget || c.total_budget !== b.before.total_budget) {
      return refuse("x_ads_campaign_drifted", `"${b.name}" changed in X Ads since this was proposed, so Zavi did not apply it. Propose it again.`);
    }
    assertBudgetOrder(b.changes.daily_budget ?? c.daily_budget, b.changes.total_budget ?? c.total_budget);
    const delta = b.changes.daily_budget === undefined ? 0 : b.changes.daily_budget - (c.daily_budget ?? 0);
    if (delta > 0) hold = await reserveXSpend(row, "raise", c.campaign_id, delta, c.currency);
    await updateXCampaign(t, b.account_id, b.campaign_id, b.changes);
    if (hold) await settleXSpend(hold, c.campaign_id);
    if (delta < 0 && c.currency === "USD") await rebaseAdSpendForObject(row.tenant_id, "x", c.campaign_id, b.changes.daily_budget!, `${row.id}:rebase`, -delta);
    return { ok: true, notice: `Updated "${b.changes.name ?? b.name}" in X Ads.` };
  } catch (e) {
    if (hold) await settleXSpend(hold, null, e, true);
    return fail(e);
  }
}

export async function executeXCreateCampaign(row: XExecRow): Promise<XExecResult> {
  const ready = await prepare(row, createBody, () => false);
  if (isResult(ready)) return ready;
  const { t } = ready;
  if (ready.b.new_post) {
    try {
      await assertXComposeAccess(t, ready.b.account_id);
    } catch (e) {
      return fail(e);
    }
  }
  const timed = ready.b.duration_days
    ? { ...ready.b, end_time: new Date(Math.max(Date.parse(ready.b.start_time), Date.now()) + ready.b.duration_days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z") }
    : ready.b;
  let testEnd: Awaited<ReturnType<typeof cgoTestEndForRun>>;
  try {
    testEnd = await cgoTestEndForRun(row.tenant_id, row.agent_run_id, new Date());
  } catch {
    return refuse("x_ads_test_end_unreadable", "Zavi could not read this test's end date, so nothing new was created on this attempt. Approve again in a minute.");
  }
  const ended = testEnd ? { ...timed, end_time: earlierEndIso(timed.end_time, testEnd.ends_on) } : timed;
  const envelope = testEnd ? Math.round(ended.daily_budget * 100) * envelopeDays(new Date().toISOString(), testEnd.ends_on) / 100 : null;
  const b = envelope != null && envelope > 0 && (ended.total_budget == null || ended.total_budget > envelope) ? { ...ended, total_budget: envelope } : ended;
  if (testEnd && Date.parse(b.end_time!) <= Math.max(Date.parse(b.start_time), Date.now())) {
    return refuse("x_ads_dates_invalid", `This test ends ${b.end_time}, before the campaign could start. Nothing was created.`);
  }
  try {
    assertBudgetOrder(b.daily_budget, b.total_budget);
    if (b.end_time && Date.parse(b.end_time) <= Date.now()) {
      return refuse("x_ads_dates_invalid", "This campaign's end date has already passed. Propose it again with new dates.");
    }
    const fi = (await listXFundingInstruments(t, b.account_id)).find((f) => f.id === b.funding_instrument_id);
    if (!fi?.able_to_fund) {
      return refuse("x_ads_funding_unable", "The funding instrument on this card cannot pay for a campaign right now. Fix billing in X Ads Manager, then approve again.");
    }
    if (fi.currency !== b.currency) return refuse("x_ads_currency_drifted", "The funding currency no longer matches this proposal. Propose it again before creating a campaign.");
  } catch (e) {
    return fail(e);
  }

  const unknownCreate = (r: XExecResult): XExecResult => (r.outcome_unknown ? { ...r, code: "exec_outcome_unknown" } : r);
  let hold: AdSpendHold | undefined;
  try {
    const xBound = b.currency !== "USD"
      ? {}
      : b.total_budget != null
        ? {
            lifetime_usd: b.total_budget,
            lifetime_daily_usd: b.end_time
              ? lifetimeDailyUsd(b.total_budget, (Date.parse(b.end_time) - Math.max(Date.parse(b.start_time), Date.now())) / 86_400_000, 2)
              : Math.min(b.total_budget, 2 * b.daily_budget),
          }
        : b.end_time
          ? { ends_on: dailyHoldEndsOn(Math.floor(Date.parse(b.end_time) / 1000)) }
          : {};
    if (b.launch === "ACTIVE") hold = await reserveXSpend(row, "create", null, b.daily_budget, b.currency, xBound);
  } catch (e) { return fail(e); }
  let campaignId: string;
  try {
    const created = await createXCampaign(t, b.account_id, { ...b, entity_status: "PAUSED" });
    campaignId = created.campaign_id;
    if (hold) await noteAdSpendObject(hold, campaignId);
    if (created.status !== "PAUSED") throw new ExpectedToolError("x_ads_outcome_unknown", `Campaign ${campaignId} was not confirmed paused. Check Ads Manager before retrying.`);
  } catch (e) {
    if (hold) await settleXSpend(hold, null, e, true);
    return unknownCreate(fail(e));
  }

  try {
    const lineItem = await createXLineItem(t, b.account_id, {
      campaign_id: campaignId,
      name: b.name,
      objective: b.objective,
      start_time: Date.parse(b.start_time) > Date.now() ? b.start_time : isoNow(),
      end_time: b.end_time,
      entity_status: "ACTIVE",
    });
    await addXTargeting(t, b.account_id, lineItem.id, xTargetingOf(b));
    const newPostId = b.new_post ? await createXPromotedOnlyPost(t, b.account_id, await xPromotableUserId(t, b.account_id), b.new_post.text) : null;
    await promoteXTweets(t, b.account_id, lineItem.id, newPostId ? [...b.tweet_ids, newPostId] : b.tweet_ids);
    if (testEnd) {
      const { end_time } = await getXLineItemEnd(t, b.account_id, lineItem.id);
      if (!end_time || Date.parse(end_time) !== Date.parse(b.end_time!)) {
        throw new ExpectedToolError("x_ads_test_end_unverified", `X shows line item ${lineItem.id} ending ${end_time ?? "never"}, not ${b.end_time}, so this test was not switched on`);
      }
    }
  } catch (e) {
    const why = (e as Error).message;
    if (e instanceof ExpectedToolError && e.code === "x_ads_outcome_unknown") {
      if (hold) await settleXSpend(hold, null, e, false);
      return { ok: false, code: "exec_outcome_unknown", outcome_unknown: true, error: `Campaign ${campaignId} is paused; a child creation outcome is unknown. Reconcile in X Ads Manager before retrying.` };
    }
    if (hold) await settleXSpend(hold, null, e, false);
    return refuse("exec_partial", `X Ads did not finish building "${b.name}" (${why}). Campaign ${campaignId} remains paused and cannot spend. Deletion requires a separate human-confirmed proposal.`);
  }

  const outcome = (status: string) => JSON.stringify({ campaign_id: campaignId, status });
  if (b.launch === "PAUSED") {
    return { ok: true, notice: `Built "${b.name}" in X Ads, paused. Nothing spends until it is turned on.`, agent_outcome: outcome("PAUSED"), created: { platform: "x", object_type: "campaign", id: campaignId, status: "PAUSED" } };
  }
  try {
    await updateXCampaign(t, b.account_id, campaignId, { entity_status: "ACTIVE" });
    await statusAfterWrite(t, b.account_id, campaignId, "ACTIVE", `campaign ${campaignId} activation`);
    if (hold) await settleXSpend(hold, campaignId);
  } catch (e) {
    if (hold) await settleXSpend(hold, null, e, true);
    const r = fail(e);
    return r.outcome_unknown ? unknownCreate(r) : refuse("exec_partial", `Built "${b.name}" in X Ads, but X refused to switch it on (${r.error}). It is paused and cannot spend.`);
  }
  return { ok: true, notice: `Started "${b.name}" in X Ads. Delivery is not yet verified.`, agent_outcome: outcome("ACTIVE"), created: { platform: "x", object_type: "campaign", id: campaignId, status: "ACTIVE", activated_at: isoNow() } };
}
