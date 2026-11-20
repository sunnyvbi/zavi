
import { ExpectedToolError } from "@/services/tools/types";
import { assertSpendWritesOn } from "@/services/channels/lock";
import { channelPlanLock } from "@/services/growth/preview-plan";
import { planUpgradeMessage } from "@/services/agents/entitlement";
import { PLAN_UPGRADE_REQUIRED } from "@/services/billing/tiers";
import { commitAdSpend, dropAdSpendHold, rebaseAdSpendForObject, releaseAdSpendForObject, reserveAdSpend, type AdSpendHold } from "@/services/decisions/ad-budget";
import { recordZaviAdChange } from "@/services/decisions/ad-changes";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import { tiktokAdsAccount } from "./composio-read";
import { ensureAdAccounts } from "./ad-accounts";
import {
  TIKTOK_SET_STATUS_CLASS,
  TIKTOK_UPDATE_BUDGET_CLASS,
  tiktokActionFields,
  tiktokActionRaisesSpend,
  tiktokBudgetBody,
  tiktokStatusBody,
  type TiktokLevel,
  type TiktokStatusLevel,
} from "./held-schema";
import { isDailyMode, listTiktokAdGroups, readTiktokObject, tiktokDeliveryFactor, writeTiktokDailyBudget, writeTiktokStatus, type TiktokObject } from "./objects";
import { readTiktokResumePlan, resumeDailyBudget } from "./status-budget";

export type TiktokExecRow = {
  id: string;
  tenant_id: string;
  body: unknown;
  decision_class: string;
  approved_by?: string | null;
  approved_by_source?: string | null;
  exec_source?: string;
  agent_run_id?: string | null;
  test_stop_pause?: true;
};
export type TiktokExecResult = { ok: boolean; code?: string; error?: string; notice?: string; outcome_unknown?: boolean; held_for_founder?: boolean };

const DEFINITE_REFUSALS: ReadonlySet<string> = new Set(["tiktok_ads_write_refused", "tiktok_ads_rate_limited", "tiktok_ads_token_revoked"]);
const HELD_FOR_FOUNDER: ReadonlySet<string> = new Set(["tiktok_ads_approval_required", "tiktok_ads_admin_required", "tiktok_ads_autopilot_off", "tiktok_ads_policy_held"]);

async function guard(d: TiktokExecRow, raisesSpend: boolean): Promise<void> {
  if (raisesSpend) {
    await assertSpendWritesOn("tiktok_ads", "TikTok Ads", "tiktok_ads");
    const plan = await channelPlanLock(d.tenant_id, "tiktok_ads");
    if (plan) throw new ExpectedToolError(PLAN_UPGRADE_REQUIRED, `${planUpgradeMessage("tiktok_ads", plan.required_tier)} Nothing in TikTok Ads changed.`);
  }
  if (d.approved_by_source === "staff" || (d.approved_by_source !== "cgo" && !d.approved_by)) {
    throw new ExpectedToolError("tiktok_ads_approval_required", "This TikTok Ads change needs the founder's approval (or Autopilot's, within its rules).");
  }
  if (d.approved_by_source !== "cgo") {
    if (!raisesSpend) return;
    let role: string | null;
    try {
      role = await loadTenantRoleFor(d.approved_by as string, d.tenant_id);
    } catch {
      throw new ExpectedToolError("tiktok_ads_role_unavailable", "The approver's workspace role could not be checked. Nothing in TikTok Ads changed; approve again in a minute.");
    }
    if (role !== "owner" && role !== "admin") {
      throw new ExpectedToolError("tiktok_ads_admin_required", "Only a workspace owner or admin can approve a TikTok Ads budget increase or turning something back on. Nothing in TikTok Ads changed.");
    }
    return;
  }
  if (d.test_stop_pause === true && d.decision_class === "tiktok_ads.set_status" && (d.body as { status?: unknown } | null)?.status === "PAUSED") return;
  const { cgoAdBudget } = await import("@/services/growth/cgo-ads");
  if (!(await cgoAdBudget(d.tenant_id))) throw new ExpectedToolError("tiktok_ads_autopilot_off", "Autopilot or its ad budget is no longer active. This change is waiting for the founder.");
  const { authorizeUnattended } = await import("@/services/growth/unattended-policy");
  const verdict = await authorizeUnattended(
    d.tenant_id,
    { kind: "ad", exec_class: d.decision_class, payload: d.body, source: { table: d.exec_source === "decisions" ? "decisions" : "channel_actions", id: d.id, run_id: d.agent_run_id ?? null } },
    { where: "tiktok_ads_write" },
  );
  if (verdict.verdict !== "allow") throw new ExpectedToolError("tiktok_ads_policy_held", `Founder review required: ${verdict.reasons.join(", ")}`);
}

async function advertiser(tenantId: string, advertiserId: string): Promise<{ account: OwnedComposioAccount; currency: string | null }> {
  const account = await tiktokAdsAccount(tenantId);
  const state = await ensureAdAccounts(tenantId);
  const saved = state.accounts.find((a) => a.advertiser_id === advertiserId);
  if (!state.connected || !saved) {
    throw new ExpectedToolError("tiktok_ads_unknown_account", `Ad account ${advertiserId} is no longer one of the founder's saved TikTok ad accounts. Nothing was changed.`);
  }
  return { account, currency: saved.currency };
}

async function liveObject(account: OwnedComposioAccount, advertiserId: string, level: TiktokStatusLevel, objectId: string, campaignId: string, name: string): Promise<TiktokObject> {
  const live = await readTiktokObject(account, advertiserId, level, objectId);
  if (!live || live.status === "DELETED") throw new ExpectedToolError("tiktok_ads_object_not_found", `"${name}" is no longer in this TikTok ad account. Nothing was changed.`);
  if (live.campaign_id !== campaignId) throw new ExpectedToolError("tiktok_ads_object_drifted", `"${name}" now sits under another campaign. Nothing was changed; propose it again.`);
  return live;
}

const cents = (n: number) => Math.round(n * 100);

async function confirm(account: OwnedComposioAccount, advertiserId: string, level: TiktokStatusLevel, objectId: string, ok: (o: TiktokObject) => boolean, what: string, delays: readonly number[] = [0]): Promise<TiktokObject> {
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    let after: TiktokObject | null = null;
    try {
      after = await readTiktokObject(account, advertiserId, level, objectId);
    } catch {
      after = null;
    }
    if (after && ok(after)) return after;
  }
  throw new ExpectedToolError("tiktok_ads_outcome_unknown", `TikTok did not confirm ${what}. Check TikTok Ads Manager before approving anything else on it.`);
}

async function execute(d: TiktokExecRow): Promise<TiktokExecResult> {
  let hold: AdSpendHold = { status: "no_budget" };
  const ownerHolds: Array<{ hold: AdSpendHold; objectId: string }> = [];
  let sent = false;
  try {
    const raises = tiktokActionRaisesSpend(d.decision_class, d.body);
    if (d.decision_class !== TIKTOK_UPDATE_BUDGET_CLASS && d.decision_class !== TIKTOK_SET_STATUS_CLASS) {
      throw new ExpectedToolError("tiktok_ads_action_unknown", "Unsupported TikTok Ads action.");
    }
    await guard(d, raises);
    const reserve = async (op: "raise" | "resume", objectId: string, delta: number, currency: string | null, objectScope = false, mode: string | null = null) => {
      hold = await reserveAdSpend(d, { platform: "tiktok", op, object_id: objectId, daily_delta_usd: delta, currency: currency ?? "UNKNOWN", ...(objectScope ? { object_scope: true as const } : {}), ...(tiktokDeliveryFactor(mode) === 1.25 ? { delivery_factor: 1.25 as const } : {}) });
      if (objectScope) ownerHolds.push({ hold, objectId });
      if (hold.status === "refused") throw new ExpectedToolError("tiktok_ads_budget_refused", hold.error);
      if (d.approved_by_source === "cgo" && hold.status !== "held") throw new ExpectedToolError("tiktok_ads_budget_required", "Autopilot needs an active shared ad budget and a spend reservation.");
    };
    const from = { table: d.exec_source === "decisions" ? ("decisions" as const) : ("channel_actions" as const), id: d.id };

    if (d.decision_class === TIKTOK_UPDATE_BUDGET_CLASS) {
      const p = tiktokBudgetBody.safeParse(tiktokActionFields(d.body));
      if (!p.success) throw new ExpectedToolError("tiktok_ads_body_invalid", "This TikTok Ads card's body is invalid. Nothing was changed.");
      const b = p.data;
      const { account, currency } = await advertiser(d.tenant_id, b.advertiser_id);
      if (currency !== "USD") throw new ExpectedToolError("tiktok_ads_currency_unsupported", "TikTok budget edits require a USD advertiser. Nothing changed.");
      const live = await liveObject(account, b.advertiser_id, b.level, b.object_id, b.campaign_id, b.name);
      if (!isDailyMode(live.budget_mode) || live.budget === null) {
        throw new ExpectedToolError("tiktok_ads_budget_mode_unsupported", `"${b.name}" has no daily budget of its own in TikTok (it is ${live.budget_mode ?? "unset"}). Zavi changes daily budgets only; nothing was changed.`);
      }
      if (b.expected_current_budget_mode && b.expected_current_budget_mode !== live.budget_mode) throw new ExpectedToolError("tiktok_ads_budget_drifted", "The budget mode changed since this was proposed. Propose it again.");
      if (cents(live.budget) !== cents(b.expected_current_daily_budget_usd)) {
        throw new ExpectedToolError("tiktok_ads_budget_drifted", `The daily budget of "${b.name}" is now $${live.budget.toFixed(2)}, not the $${b.expected_current_daily_budget_usd.toFixed(2)} this card was proposed against. Nothing was changed; propose it again.`);
      }
      if (live.status !== b.expected_current_status) {
        throw new ExpectedToolError("tiktok_ads_status_drifted", `"${b.name}" is now ${live.status}, not ${b.expected_current_status} as when this card was proposed. Nothing was changed; propose it again.`);
      }
      const delta = b.daily_budget_usd - b.expected_current_daily_budget_usd;
      if (delta > 0) await reserve("raise", live.id, delta, currency, false, live.budget_mode);
      await guard(d, raises);
      sent = true;
      await writeTiktokDailyBudget(account, b.advertiser_id, b.level, live.id, b.daily_budget_usd);
      await confirm(account, b.advertiser_id, b.level, live.id, (o) => o.budget !== null && cents(o.budget) === cents(b.daily_budget_usd), `the new daily budget of "${b.name}"`);
      await recordZaviAdChange(d.tenant_id, from, { platform: "tiktok", object_id: live.id, level: b.level, campaign_id: live.campaign_id, object_name: live.name, change_kind: "budget", before_status: live.status, after_status: live.status, before_daily_usd: b.expected_current_daily_budget_usd, after_daily_usd: b.daily_budget_usd });
      if (delta > 0) await commitAdSpend(hold, live.id);
      else await rebaseAdSpendForObject(d.tenant_id, "tiktok", live.id, b.daily_budget_usd, `${d.id}:rebase`, -delta);
      return { ok: true, notice: `Changed the daily budget of "${b.name}" in TikTok Ads (${b.advertiser_name}) from $${b.expected_current_daily_budget_usd.toFixed(2)} to $${b.daily_budget_usd.toFixed(2)}. TikTok confirmed it.` };
    }

    const p = tiktokStatusBody.safeParse(tiktokActionFields(d.body));
    if (!p.success) throw new ExpectedToolError("tiktok_ads_body_invalid", "This TikTok Ads card's body is invalid. Nothing was changed.");
    const b = p.data;
    const { account, currency } = await advertiser(d.tenant_id, b.advertiser_id);
    const live = await liveObject(account, b.advertiser_id, b.level, b.object_id, b.campaign_id, b.name);
    if (b.level === "ad" && live.ad_group_id !== b.ad_group_id) throw new ExpectedToolError("tiktok_ads_object_drifted", "This ad moved to a different ad group. Propose the change again.");
    if (live.status !== b.expected_current_status) {
      throw new ExpectedToolError("tiktok_ads_status_drifted", `"${b.name}" is ${live.status} in TikTok now, not ${b.expected_current_status} as when this was proposed. Nothing was changed; propose it again if it is still needed.`);
    }
    const resume = b.status === "ACTIVE";
    if (resume) {
      if (currency !== "USD") throw new ExpectedToolError("tiktok_ads_currency_unsupported", "TikTok resumes require a USD advertiser. Pausing remains available.");
      if (b.resume_plan) {
        const plan = await readTiktokResumePlan(account, b.advertiser_id, live);
        if (JSON.stringify(plan) !== JSON.stringify(b.resume_plan) || resumeDailyBudget(plan) !== b.daily_budget_usd) {
          throw new ExpectedToolError("tiktok_ads_budget_drifted", "The campaign, budget owners or their switches changed since this resume was proposed. Propose it again.");
        }
        for (const source of plan.sources) await reserve("resume", source.object_id, source.daily_budget_usd, currency, true, source.budget_mode);
        const current = await readTiktokObject(account, b.advertiser_id, b.level, b.object_id);
        if (!current || JSON.stringify(await readTiktokResumePlan(account, b.advertiser_id, current)) !== JSON.stringify(plan)) throw new ExpectedToolError("tiktok_ads_budget_drifted", "The delivery tree changed while reserving its budget. Nothing changed; propose it again.");
      } else {
      if (!isDailyMode(live.budget_mode) || live.budget === null) {
        throw new ExpectedToolError("tiktok_ads_budget_unknown", `"${b.name}" has no daily budget of its own in TikTok, so Zavi cannot hold the shared budget for turning it on. Nothing was changed; turn it on in TikTok Ads Manager if you want it running.`);
      }
      if (b.daily_budget_usd === null || cents(live.budget) !== cents(b.daily_budget_usd)) {
        throw new ExpectedToolError("tiktok_ads_budget_drifted", `The daily budget of "${b.name}" changed since this was proposed. Nothing was changed; propose it again.`);
      }
      await reserve("resume", live.id, live.budget, currency, false, live.budget_mode);
      }
    }
    await guard(d, raises);
    sent = true;
    await writeTiktokStatus(account, b.advertiser_id, b.level, live.id, b.status);
    await confirm(account, b.advertiser_id, b.level, live.id, (o) => o.status === b.status && o.campaign_id === b.campaign_id && (b.level !== "ad" || o.ad_group_id === b.ad_group_id), resume ? `that "${b.name}" is on` : `that "${b.name}" is paused`);
    await recordZaviAdChange(d.tenant_id, from, { platform: "tiktok", object_id: live.id, level: b.level, campaign_id: live.campaign_id, object_name: live.name, change_kind: "status", before_status: live.status, after_status: b.status, before_daily_usd: null, after_daily_usd: null });
    if (resume) {
      if (b.resume_plan) for (const owner of ownerHolds) await commitAdSpend(owner.hold, owner.objectId);
      else await commitAdSpend(hold, live.id);
      return { ok: true, notice: `Turned "${b.name}" back on in TikTok Ads (${b.advertiser_name}). TikTok confirmed it; delivery is not yet verified.` };
    }
    await releaseHolds(d.tenant_id, account, b.advertiser_id, b.level, live.id);
    return { ok: true, notice: `Paused "${b.name}" in TikTok Ads (${b.advertiser_name}). TikTok confirmed it.` };
  } catch (e) {
    const code = e instanceof ExpectedToolError ? e.code : "tiktok_ads_execution_failed";
    const unknown = code === "tiktok_ads_outcome_unknown" || (sent && !DEFINITE_REFUSALS.has(code));
    if (!unknown && (!sent || DEFINITE_REFUSALS.has(code))) {
      if (ownerHolds.length) for (const owner of ownerHolds) await dropAdSpendHold(owner.hold);
      else await dropAdSpendHold(hold);
    }
    const error = e instanceof Error ? e.message : "TikTok Ads execution failed";
    return {
      ok: false,
      code: unknown ? "exec_outcome_unknown" : code,
      error,
      ...(unknown ? { outcome_unknown: true } : {}),
      ...(HELD_FOR_FOUNDER.has(code) ? { held_for_founder: true } : {}),
    };
  }
}

async function releaseHolds(tenantId: string, account: OwnedComposioAccount, advertiserId: string, level: TiktokStatusLevel, objectId: string): Promise<void> {
  if (level === "ad") return;
  await releaseAdSpendForObject(tenantId, "tiktok", objectId);
  if (level !== "campaign") return;
  try {
    for (const g of await listTiktokAdGroups(account, advertiserId, [objectId])) await releaseAdSpendForObject(tenantId, "tiktok", g.id);
  } catch (e) {
    console.error(`[tiktok-ads] ad groups of paused campaign ${objectId} unreadable; their holds stay: ${(e as Error).message}`);
  }
}

export async function executeTiktokAction(d: TiktokExecRow): Promise<TiktokExecResult> {
  return execute(d);
}

export async function pauseTiktokBudgetObject(tenantId: string, objectId: string): Promise<void> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("ad_campaigns")
    .select("account_id, level")
    .eq("platform", "tiktok")
    .eq("object_id", objectId)
    .limit(2);
  const rows = (data ?? []) as Array<{ account_id: string; level: string }>;
  const unreadable = () => new Error("Cannot tell which TikTok ad account this object is in; its budget hold remains. Pause it in TikTok Ads Manager.");
  if (error || rows.length > 1 || (rows.length === 1 && rows[0].level !== "campaign" && rows[0].level !== "ad_group")) throw unreadable();
  const account = await tiktokAdsAccount(tenantId);
  const found = rows.length === 1 ? { advertiserId: rows[0].account_id, level: rows[0].level as TiktokLevel } : await findUnledgered(tenantId, account, objectId);
  if (!found) throw unreadable();
  const live = await readTiktokObject(account, found.advertiserId, found.level, objectId);
  if (!live || live.status === "PAUSED" || live.status === "DELETED") return;
  await writeTiktokStatus(account, found.advertiserId, found.level, objectId, "PAUSED");
  const after = await readTiktokObject(account, found.advertiserId, found.level, objectId).catch(() => null);
  if (after?.status !== "PAUSED") throw new Error("TikTok did not confirm the pause; its budget hold remains.");
}

async function findUnledgered(tenantId: string, account: OwnedComposioAccount, objectId: string): Promise<{ advertiserId: string; level: TiktokLevel } | null> {
  const state = await ensureAdAccounts(tenantId);
  if (!state.connected) return null;
  const matches: Array<{ advertiserId: string; level: TiktokLevel }> = [];
  for (const a of state.accounts) {
    for (const level of ["campaign", "ad_group"] as const) {
      if (await readTiktokObject(account, a.advertiser_id, level, objectId)) matches.push({ advertiserId: a.advertiser_id, level });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
