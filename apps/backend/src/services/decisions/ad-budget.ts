
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { normalizeCurrency } from "@/services/tools/meta-ads/write/_currency";
import { moneyBookShadowEnabled } from "./ad-money-book-flag";
import { adConstraintForPlatform } from "@zavi/shared";
import { adsNoFrictionEnabled } from "@/services/growth/ads-no-friction-flag";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";

export type AdPlatform = "meta" | "google" | "chatgpt" | "reddit" | "x" | "tiktok" | "linkedin";
export type AdSpendOp = "raise" | "resume" | "create";

export const AD_BUDGET_NAME_PREFIX = "Zavi · ";

export type AdSpendHold =
  | { status: "no_budget" }
  | { status: "refused"; error: string }
  | {
      status: "held";
      tenant_id: string;
      idem_key: string;
      fresh: boolean;
      over_cap?: boolean;
    };

type ReserveAnswer = {
  status?: string;
  reason?: string | null;
  amount_usd?: number | string;
};

export function adBudgetIdemKey(actionOrDecisionId: string, op: AdSpendOp): string {
  return `${actionOrDecisionId}:${op}`;
}

export function adHoldLink(d: { id: string; exec_source?: string }): { p_channel_action_id?: string; p_decision_id?: string } {
  if (d.exec_source === "workspace") return {};
  return d.exec_source === "channel_actions" ? { p_channel_action_id: d.id } : { p_decision_id: d.id };
}

export function adBudgetRefusal(reason: string): string {
  return `cap_refuse: ad_budget_${reason}`;
}

const PAUSED_CREATE_CLASSES: ReadonlySet<string> = new Set(["meta_ads.create_ad_set", "google_ads.create_campaign"]);

export function holdsOneDay(
  d: { decision_class?: string; approved_by_source?: string | null },
  a: { op: AdSpendOp; paused?: boolean },
): boolean {
  if (a.op !== "create") return false;
  if (a.paused !== undefined) return a.paused;
  return d.approved_by_source === "cgo" && !!d.decision_class && PAUSED_CREATE_CLASSES.has(d.decision_class);
}

type ReserveDecision = {
  id: string;
  tenant_id: string;
  exec_source?: string;
  decision_class?: string;
  approved_by?: string | null;
  approved_by_source?: string | null;
  body?: unknown;
};
type ReserveAsk = {
  platform: AdPlatform;
  op: AdSpendOp;
  object_id: string | null;
  daily_delta_usd: number;
  object_scope?: true;
  delivery_factor?: 1.25;
  paused?: boolean;
  currency?: string;
  ends_on?: string;
  lifetime_usd?: number;
  observed_usd?: number;
  refuse_over_cap?: boolean;
};

function reserveIdemKey(d: ReserveDecision, a: ReserveAsk): string {
  return adBudgetIdemKey(d.id, a.op) + (a.object_scope && a.object_id ? `:${a.object_id}` : "");
}

function roundAdUsd(value: number, direction: "up" | "down" = "up"): number {
  const micros = Math.round(Number(value.toFixed(6)) * 1_000_000);
  return (direction === "up" ? Math.ceil(micros / 10_000) : Math.floor(micros / 10_000)) / 100;
}

export function lifetimeDailyUsd(lifetime_usd: number, flight_days: number, factor: number): number {
  const days = Math.max(1, Math.ceil(flight_days));
  return roundAdUsd(Math.min(lifetime_usd, (factor * lifetime_usd) / days));
}

function isPersonApproval(d: ReserveDecision): d is ReserveDecision & { approved_by: string } {
  return typeof d.approved_by === "string" && d.approved_by.length > 0 && (d.approved_by_source == null || d.approved_by_source === "email");
}

function founderSide(d: ReserveDecision): boolean {
  if (isPersonApproval(d)) return true;
  const origin = d.body && typeof d.body === "object" ? (d.body as { origin?: unknown }).origin : undefined;
  return origin === "user_initiated_chat" || origin === "user_initiated_ledger";
}

const usdWords = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export const overProjectionGate = {
  read: async (tenant_id: string, excludeIdemKey?: string): Promise<{ projection: { projected_usd: number; month_cap_usd: number; days_left: number; over: boolean } } | null> => {
    const { readCountedProjection } = await import("./ad-month-counter");
    return readCountedProjection(tenant_id, excludeIdemKey === undefined ? {} : { excludeIdemKey });
  },
};

export const OVER_PROJECTION_WITH_CHANGE = "ad_budget_over_projection_with_change";

async function overProjectionRefusal(d: ReserveDecision, a: ReserveAsk, retry: boolean, idem_key: string): Promise<{ status: "refused"; error: string } | null> {
  if (founderSide(d)) return null;
  if (!(a.daily_delta_usd > 0)) return null;
  const sent = retry ? "nothing was sent on this attempt; an earlier attempt may have applied it, so check the ad account" : "nothing was sent";
  let read: Awaited<ReturnType<typeof overProjectionGate.read>>;
  try {
    read = await overProjectionGate.read(d.tenant_id, idem_key);
  } catch (e) {
    console.error(`[ad-budget] month projection unreadable for tenant ${d.tenant_id}; refusing the Autopilot change: ${(e as Error).message}`);
    return { status: "refused", error: adBudgetRefusal(`unavailable: this month's projection could not be checked, so Autopilot added no spend; ${sent}`) };
  }
  const p = read?.projection;
  if (!p) return null;
  if (!p.over) {
    const { capWarningWords } = await import("@/services/channels/cap-warning");
    const warning = capWarningWords(p, a.daily_delta_usd * (a.delivery_factor ?? 1));
    if (!warning) return null;
    return { status: "refused", error: adBudgetRefusal(`over_projection_with_change: ${warning}, so Autopilot left it for you to approve; ${sent}`) };
  }
  return {
    status: "refused",
    error: adBudgetRefusal(
      `over_projection: this month is on track for ${usdWords(p.projected_usd)}, ${usdWords(Math.round((p.projected_usd - p.month_cap_usd) * 100) / 100)} over your ${usdWords(p.month_cap_usd)} cap, so Autopilot adds no spend. Approve it yourself to go ahead; ${sent}`,
    ),
  };
}

async function isOwnerOrAdmin(tenant_id: string, user_id: string): Promise<boolean> {
  try {
    const role = await loadTenantRoleFor(user_id, tenant_id);
    return role === "owner" || role === "admin";
  } catch {
    return false;
  }
}

const hasBudgetChoice = (b: unknown): boolean => !!b && typeof b === "object" && !Array.isArray(b) && "budget_choice" in (b as object);

async function boundedArgs(d: ReserveDecision, a: ReserveAsk): Promise<Record<string, unknown> | "invalid"> {
  const wantsBound = a.lifetime_usd != null || a.ends_on != null;
  if (!wantsBound && !isPersonApproval(d)) return {};
  const boundedResume = a.op === "resume" && a.lifetime_usd != null && a.ends_on != null;
  const out: Record<string, unknown> = {};
  if (boundedResume) {
    if (!Number.isFinite(a.lifetime_usd) || a.lifetime_usd! <= 0 || a.lifetime_usd! >= 1_000_000) return "invalid";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.ends_on!)) return "invalid";
    out.p_cap_usd = roundAdUsd(a.lifetime_usd!);
    out.p_ends_on = a.ends_on;
    out.p_factor = 1;
    if (a.observed_usd != null) {
      if (!Number.isFinite(a.observed_usd) || a.observed_usd < 0) return "invalid";
      out.p_observed_usd = roundAdUsd(a.observed_usd);
    }
  }
  if (!(await adsNoFrictionEnabled())) return out;
  if (wantsBound && !boundedResume) {
    if (a.op !== "create") return "invalid";
    if (a.lifetime_usd != null) {
      if (!Number.isFinite(a.lifetime_usd) || a.lifetime_usd <= 0 || a.lifetime_usd >= 1_000_000) return "invalid";
      out.p_cap_usd = roundAdUsd(a.lifetime_usd);
      out.p_factor = 1;
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(a.ends_on!)) return "invalid";
      out.p_ends_on = a.ends_on;
      out.p_factor = adConstraintForPlatform(a.platform)?.hold_factor ?? (a.platform === "chatgpt" || a.platform === "x" ? 2 : 1);
    }
  }
  if (!a.refuse_over_cap && isPersonApproval(d) && !hasBudgetChoice(d.body) && (await isOwnerOrAdmin(d.tenant_id, d.approved_by))) out.p_over_cap_ok = true;
  return out;
}

export async function reserveAdSpend(d: ReserveDecision, a: ReserveAsk): Promise<AdSpendHold> {
  const gate: { answer?: ReserveAnswer } = {};
  const hold = await reserveAtGate(d, a, gate);
  if (gate.answer) await shadowAfterReserve(d, a, gate.answer);
  return hold;
}

async function shadowAfterReserve(d: ReserveDecision, a: ReserveAsk, ans: ReserveAnswer): Promise<void> {
  try {
    if (!moneyBookShadowEnabled()) return;
    const { recordShadowVerdict } = await import("./ad-money-book-store");
    await recordShadowVerdict({
      tenant_id: d.tenant_id,
      change: {
        idem_key: reserveIdemKey(d, a),
        platform: a.platform,
        op: a.op,
        object_id: a.object_id,
        daily_delta_usd: a.daily_delta_usd,
        paused: holdsOneDay(d, a),
      },
      real: {
        status: ans.status as "held" | "already_held" | "refused",
        reason: ans.reason ?? null,
        amount_usd: ans.amount_usd == null ? null : Number(ans.amount_usd),
      },
    });
  } catch (e) {
    console.warn(`[ad-money-book] shadow check skipped for tenant ${d.tenant_id}: ${(e as Error)?.message ?? String(e)}`);
  }
}

async function reserveAtGate(d: ReserveDecision, a: ReserveAsk, gate: { answer?: ReserveAnswer }): Promise<AdSpendHold> {
  if (a.delivery_factor !== undefined && (a.platform !== "tiktok" || a.delivery_factor !== 1.25 || a.lifetime_usd !== undefined)) return { status: "refused", error: adBudgetRefusal("invalid_delivery_factor") };
  if (!Number.isFinite(a.daily_delta_usd) || a.daily_delta_usd < 0) {
    return { status: "refused", error: adBudgetRefusal("invalid_amount") };
  }
  if ((a.platform === "meta" || a.platform === "reddit" || a.platform === "x" || a.platform === "tiktok") && normalizeCurrency(a.currency) !== "USD") {
    let active: ActiveAdBudget | null;
    try {
      active = await readActiveAdBudget(d.tenant_id);
    } catch (e) {
      console.error(`[ad-budget] budget read failed for tenant ${d.tenant_id}; refusing: ${(e as Error).message}`);
      return { status: "refused", error: adBudgetRefusal("unavailable: the ad budget could not be checked, nothing was sent") };
    }
    if (active) {
      return {
        status: "refused",
        error: adBudgetRefusal(
          `non_usd_account: Autopilot ad budgets run on USD ad accounts only, and this one is ${normalizeCurrency(a.currency)}. Stop the ad budget to approve changes yourself.`,
        ),
      };
    }
    return { status: "no_budget" };
  }
  const idem_key = reserveIdemKey(d, a);
  const bounded = await boundedArgs(d, a);
  if (bounded === "invalid") return { status: "refused", error: adBudgetRefusal("invalid_amount") };
  let data: unknown;
  try {
    const r = await tenantRpc(asTenantId(d.tenant_id), "reserve_ad_spend", {
      p_idem_key: idem_key,
      p_platform: a.platform,
      p_op: a.op,
      p_object_id: a.object_id,
      p_daily_delta_usd: roundAdUsd(a.daily_delta_usd),
      ...adHoldLink(d),
      ...(holdsOneDay(d, a) ? { p_paused: true } : {}),
      ...bounded,
      ...(a.delivery_factor === 1.25 ? { p_factor: 1.25 } : {}),
    });
    if (r.error) throw new Error(r.error.message);
    data = r.data;
  } catch (e) {
    console.error(
      `[ad-budget] reserve_ad_spend failed for tenant ${d.tenant_id} (${idem_key}); refusing: ${(e as Error).message}`,
    );
    return { status: "refused", error: adBudgetRefusal("unavailable: the ad budget could not be checked, nothing was sent") };
  }
  const ans = (data ?? {}) as ReserveAnswer;
  if (ans.status === "held" || ans.status === "already_held" || ans.status === "refused") gate.answer = ans;
  switch (ans.status) {
    case "no_budget":
      return { status: "no_budget" };
    case "held":
    case "already_held": {
      const hold: AdSpendHold = {
        status: "held",
        tenant_id: d.tenant_id,
        idem_key,
        fresh: ans.status === "held",
        ...(ans.reason === "over_cap" ? { over_cap: true } : {}),
      };
      const refused = await overProjectionRefusal(d, a, ans.status === "already_held", idem_key);
      if (refused) {
        if (ans.status === "held") await settle(hold, "released");
        gate.answer = { status: "refused", reason: refused.error.includes(OVER_PROJECTION_WITH_CHANGE) ? "over_projection_with_change" : "over_projection" };
        return refused;
      }
      return hold;
    }
    case "refused":
      if (ans.reason === "platform_unread") {
        const name = PLATFORM_LABEL[a.platform];
        const login = await readFailureNeedsReconnect(d.tenant_id, a.platform);
        return {
          status: "refused",
          error: adBudgetRefusal(
            login
              ? `platform_unread: ${name} spend could not be read on the last check, so its month is unknown. Reconnect it in Settings; nothing was sent`
              : `platform_unread: ${name} spend couldn't be read this hour; budget raises on ${name} wait until it reads again. Nothing was sent`,
          ),
        };
      }
      if (ans.reason === "object_busy") {
        return {
          status: "refused",
          error: adBudgetRefusal("object_busy: another change to this ad is still in flight; try again shortly"),
        };
      }
      return { status: "refused", error: adBudgetRefusal(ans.reason || "over_month") };
  }
  console.error(`[ad-budget] reserve_ad_spend returned an unknown answer for ${idem_key}; refusing`);
  return { status: "refused", error: adBudgetRefusal("unavailable: the ad budget answer was not understood, nothing was sent") };
}

async function readFailureNeedsReconnect(tenant_id: string, platform: AdPlatform): Promise<boolean> {
  try {
    const { tenantClient } = await import("@/services/tenant-client");
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("ad_budgets")
      .select("read_failure_kinds")
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (error) return false;
    const kind = (data as { read_failure_kinds?: Record<string, string> | null } | null)?.read_failure_kinds?.[platform];
    return kind === "auth" || kind === "account_gone";
  } catch {
    return false;
  }
}

async function settle(
  hold: AdSpendHold,
  outcome: "committed" | "released",
  object_id?: string | null,
  strict = false,
): Promise<void> {
  if (hold.status !== "held") return;
  try {
    const r = await tenantRpc(asTenantId(hold.tenant_id), "settle_ad_spend", {
      p_idem_key: hold.idem_key,
      p_outcome: outcome,
      p_object_id: object_id ?? null,
    });
    if (r.error) throw new Error(r.error.message);
    if (strict && (r.data as { status?: string } | null)?.status !== outcome)
      throw new Error("Ad budget hold cleanup could not be confirmed");
  } catch (e) {
    console.error(
      `[ad-budget] settle_ad_spend(${outcome}) failed for ${hold.idem_key}; the hold stays: ${(e as Error).message}`,
    );
    if (strict) throw e;
  }
}

export function commitAdSpend(hold: AdSpendHold, object_id?: string | null, options?: { strict: boolean }): Promise<void> {
  return settle(hold, "committed", object_id, options?.strict);
}

export async function noteAdSpendObject(hold: AdSpendHold, object_id: string): Promise<void> {
  if (hold.status !== "held") return;
  try {
    const r = await tenantRpc(asTenantId(hold.tenant_id), "note_ad_spend_object", {
      p_idem_key: hold.idem_key,
      p_object_id: object_id,
    });
    if (r.error) throw new Error(r.error.message);
  } catch (e) {
    console.error(`[ad-budget] note_ad_spend_object failed for ${hold.idem_key} (${object_id}): ${(e as Error).message}`);
  }
}

export type AdHoldRef =
  | { kind: "meta_tag"; level: "adset" | "campaign"; campaign_id: string; tag: string }
  | { kind: "meta_adset_name"; campaign_id: string; name: string }
  | { kind: "google_campaign_name"; name: string }
  | { kind: "chatgpt_campaign_name"; name: string; account_binding_id?: string }
  | { kind: "tiktok_tag"; advertiser_id: string; tag: string };

export async function noteAdSpendRef(hold: AdSpendHold, ref: AdHoldRef): Promise<string | null> {
  if (hold.status !== "held") return null;
  let status: string | undefined;
  try {
    const r = await tenantRpc(asTenantId(hold.tenant_id), "note_ad_spend_ref", {
      p_idem_key: hold.idem_key,
      p_ref: ref,
    });
    if (r.error) throw new Error(r.error.message);
    status = (r.data as { status?: string } | null)?.status;
  } catch (e) {
    console.error(`[ad-budget] note_ad_spend_ref failed for ${hold.idem_key}; refusing: ${(e as Error).message}`);
  }
  if (status === "noted" || status === "unchanged") return null;
  await dropAdSpendHold(hold);
  return adBudgetRefusal("unavailable: the ad budget hold could not be labelled, nothing was sent");
}

export function dropAdSpendHold(hold: AdSpendHold, options?: { strict: boolean }): Promise<void> {
  if (hold.status !== "held" || !hold.fresh) return Promise.resolve();
  return settle(hold, "released", null, options?.strict);
}

export const AD_PRE_SEND_FAILED = "ad_pre_send_failed";

export async function beforeSend<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (e) {
    if (e instanceof ExpectedToolError && PRE_SEND_CODES.has(e.code)) throw e;
    throw new ExpectedToolError(AD_PRE_SEND_FAILED, (e as Error)?.message ?? String(e));
  }
}

const PRE_SEND_CODES = new Set([
  AD_PRE_SEND_FAILED,
  "meta_ads_adset_name_exists",
  "meta_ads_bid_unavailable",
  "google_ads_campaign_name_exists",
  "google_ads_demand_gen_logo_mismatch",
  "google_ads_demand_gen_logo_missing",
  "google_ads_demand_gen_logo_unavailable",
  "google_ads_ad_image_mismatch",
  "google_ads_ad_image_missing",
  "google_ads_ad_image_unavailable",
]);

const CONFIRMED_OFF_CODES = new Set(["meta_ads_launch_switched_off"]);

export function isDefinitePlatformRejection(e: unknown): boolean {
  if (!(e instanceof ExpectedToolError)) return false;
  if (PRE_SEND_CODES.has(e.code) || CONFIRMED_OFF_CODES.has(e.code)) return true;
  if (e.code !== "meta_ads_write_failed" && e.code !== "google_ads_mutate_failed") return false;
  return /\bfailed: 4\d\d\b/.test(e.message);
}

export async function settleAdSpendAfterError(hold: AdSpendHold, e: unknown): Promise<void> {
  if (hold.status !== "held" || !hold.fresh) return;
  if (isDefinitePlatformRejection(e)) await settle(hold, "released");
}

export async function runAdBudgetChecks(
  hold: AdSpendHold,
  check: () => Promise<string | null>,
): Promise<string | null> {
  if (hold.status !== "held") return null;
  let reason: string | null;
  try {
    reason = await check();
  } catch (e) {
    console.error(`[ad-budget] budget check failed for ${hold.idem_key}; refusing: ${(e as Error).message}`);
    reason = "check_failed";
  }
  if (reason === null) return null;
  await dropAdSpendHold(hold);
  return adBudgetRefusal(reason);
}

export async function releaseAdSpendForObject(
  tenant_id: string,
  platform: AdPlatform,
  object_id: string,
  opts: { confirm?: boolean } = {},
): Promise<boolean> {
  try {
    const r = await tenantRpc(asTenantId(tenant_id), "release_ad_spend_for_object", {
      p_platform: platform,
      p_object_id: object_id,
    });
    if (r.error) throw new Error(r.error.message);
    if (!opts.confirm) return true;
    const status = (r.data as { status?: string } | null)?.status;
    if (status !== "released" && status !== "no_budget") return false;
    const none = await noCommittedAdSpendHold(tenant_id, platform, object_id);
    if (none === null) throw new Error("committed hold read-back failed");
    return none;
  } catch (e) {
    console.error(
      `[ad-budget] release_ad_spend_for_object failed for ${platform} ${object_id}; the hold stays: ${(e as Error).message}`,
    );
    return false;
  }
}

export async function noCommittedAdSpendHold(tenant_id: string, platform: AdPlatform, object_id: string): Promise<boolean | null> {
  try {
    const { tenantClient } = await import("@/services/tenant-client");
    const left = await tenantClient(asTenantId(tenant_id))
      .from("ad_budget_reservations")
      .select("id")
      .eq("platform", platform)
      .eq("object_id", object_id)
      .eq("status", "committed")
      .limit(1);
    if (left.error) throw new Error(left.error.message);
    return (left.data ?? []).length === 0;
  } catch (e) {
    console.error(`[ad-budget] committed hold read-back failed for ${platform} ${object_id}: ${(e as Error).message}`);
    return null;
  }
}

export async function committedAdHoldIds(tenant_id: string, platform: AdPlatform, object_id: string): Promise<string[] | null> {
  try {
    const { tenantClient } = await import("@/services/tenant-client");
    const r = await tenantClient(asTenantId(tenant_id))
      .from("ad_budget_reservations")
      .select("id")
      .eq("platform", platform)
      .eq("object_id", object_id)
      .eq("status", "committed");
    if (r.error) throw new Error(r.error.message);
    return ((r.data ?? []) as Array<{ id: unknown }>).map((row) => String(row.id));
  } catch (e) {
    console.error(`[ad-budget] committed holds unreadable for ${platform} ${object_id}; nothing will be released: ${(e as Error).message}`);
    return null;
  }
}

export async function releaseAdSpendHolds(tenant_id: string, platform: AdPlatform, object_id: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const r = await tenantRpc(asTenantId(tenant_id), "release_ad_spend_holds", {
      p_platform: platform,
      p_object_id: object_id,
      p_reservation_ids: [...ids],
    });
    if (r.error) throw new Error(r.error.message);
  } catch (e) {
    console.error(`[ad-budget] release_ad_spend_holds failed for ${platform} ${object_id}; the holds stay: ${(e as Error).message}`);
  }
}

export function adBudgetRebaseKey(actionOrDecisionId: string): string {
  return `${actionOrDecisionId}:rebase`;
}

const REBASE_ATTEMPTS = 3;
const REBASE_BACKOFF_MS = 500;

export async function rebaseAdSpendForObject(
  tenant_id: string,
  platform: AdPlatform,
  object_id: string,
  new_daily_usd: number,
  idem_key: string,
  cut_usd?: number,
): Promise<void> {
  if (!Number.isFinite(new_daily_usd) || new_daily_usd < 0) {
    console.error(`[ad-budget] rebase skipped for ${platform} ${object_id}: unreadable amount; the hold stays`);
    return;
  }
  if (cut_usd !== undefined && !(Number.isFinite(cut_usd) && cut_usd > 0)) {
    console.error(`[ad-budget] rebase skipped for ${platform} ${object_id}: unreadable cut; the hold stays`);
    return;
  }
  let last: unknown = null;
  for (let attempt = 1; attempt <= REBASE_ATTEMPTS; attempt++) {
    try {
      const r = await tenantRpc(asTenantId(tenant_id), "rebase_ad_spend_for_object", {
        p_platform: platform,
        p_object_id: object_id,
        p_new_daily_usd: roundAdUsd(new_daily_usd),
        p_idem_key: idem_key,
        ...(cut_usd !== undefined ? { p_cut_usd: roundAdUsd(cut_usd, "down") } : {}),
      });
      if (r.error) throw new Error(r.error.message);
      const status = (r.data as { status?: string } | null)?.status;
      if (status === "object_busy") throw new Error("object_busy: another change on this object is in flight");
      return;
    } catch (e) {
      last = e;
      if (attempt < REBASE_ATTEMPTS) await new Promise((r) => setTimeout(r, REBASE_BACKOFF_MS * attempt));
    }
  }
  console.error(
    `[ad-budget] rebase_ad_spend_for_object failed ${REBASE_ATTEMPTS}x for ${platform} ${object_id}; the old hold stays until the month resets: ${(last as Error).message}`,
  );
}

export function prefixAdName(name: string, maxLength: number): string {
  const base = name.startsWith(AD_BUDGET_NAME_PREFIX) ? name : `${AD_BUDGET_NAME_PREFIX}${name}`;
  return base.slice(0, maxLength);
}

export type ActiveAdBudget = {
  id: string;
  monthly_usd: number;
  month_cap_usd: number;
  spent_usd: number;
  held_usd: number;
  creator_held_usd: number;
  creator_spent_usd: number;
  left_usd: number;
  daily_limit_usd: number | null;
  next_month_start: string;
  days_left: number;
  days_in_month: number;
  margin?: number;
  actual_read_at?: string | null;
};

export function budgetMargin(budget: { margin?: number | null } | null | undefined): number {
  const m = budget?.margin;
  return typeof m === "number" && Number.isFinite(m) && m >= 1 ? m : 1;
}

export type AdBudgetMonthView = ActiveAdBudget & {
  status: "active" | "stopped";
  started_on: string;
  created_at: string;
  stopped_at: string | null;
  month_start: string;
};

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export function parseMonthView(raw: unknown): AdBudgetMonthView | null {
  if (raw === null || raw === undefined) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || (r.status !== "active" && r.status !== "stopped")) {
    throw new Error("ad_budget_month_view returned an unreadable budget");
  }
  const out: AdBudgetMonthView = {
    id: r.id,
    status: r.status,
    monthly_usd: num(r.monthly_usd),
    month_cap_usd: num(r.month_cap_usd),
    spent_usd: num(r.spent_usd),
    held_usd: num(r.held_usd),
    left_usd: num(r.left_usd),
    creator_held_usd: num(r.creator_held_usd),
    creator_spent_usd: num(r.creator_spent_usd),
    daily_limit_usd: r.daily_limit_usd == null ? null : num(r.daily_limit_usd),
    next_month_start: String(r.next_month_start ?? ""),
    days_left: num(r.days_left),
    days_in_month: num(r.days_in_month),
    started_on: String(r.started_on ?? ""),
    created_at: String(r.created_at ?? ""),
    stopped_at: typeof r.stopped_at === "string" ? r.stopped_at : null,
    month_start: String(r.month_start ?? ""),
    ...(r.margin != null && Number.isFinite(Number(r.margin)) ? { margin: Number(r.margin) } : {}),
    ...(typeof r.actual_read_at === "string" ? { actual_read_at: r.actual_read_at } : {}),
  };
  for (const k of ["monthly_usd", "month_cap_usd", "spent_usd", "held_usd", "left_usd", "creator_held_usd", "creator_spent_usd"] as const) {
    if (!Number.isFinite(out[k])) throw new Error(`ad_budget_month_view returned an unreadable ${k}`);
  }
  return out;
}

export async function readAdBudgetMonthView(tenant_id: string): Promise<AdBudgetMonthView | null> {
  const r = await tenantRpc(asTenantId(tenant_id), "ad_budget_month_view", {});
  if (r.error) throw new Error(`ad budget read failed: ${r.error.message}`);
  return parseMonthView(r.data);
}

const PLATFORM_LABEL: Record<AdPlatform, string> = { meta: "Meta Ads", google: "Google Ads", chatgpt: "ChatGPT Ads", reddit: "Reddit Ads", x: "X Ads", tiktok: "TikTok Ads", linkedin: "LinkedIn Ads" };

export async function readActiveAdBudget(tenant_id: string): Promise<ActiveAdBudget | null> {
  const v = await readAdBudgetMonthView(tenant_id);
  if (!v || v.status !== "active") return null;
  const { status: _s, started_on: _o, created_at: _c, stopped_at: _t, month_start: _m, ...active } = v;
  return active;
}

export async function adBudgetStandsInForCap(
  d: { tenant_id: string; approved_by_source?: string | null },
  capRead: { cap: unknown; cap_row_absent?: boolean },
): Promise<boolean> {
  if (d.approved_by_source !== "cgo" || capRead.cap != null || capRead.cap_row_absent !== true) return false;
  try {
    return (await readActiveAdBudget(d.tenant_id)) !== null;
  } catch (e) {
    console.error(`[ad-budget] budget read failed for tenant ${d.tenant_id}; the cap governs: ${(e as Error).message}`);
    return false;
  }
}

export function budgetMustHold(d: { approved_by_source?: string | null }, hold: AdSpendHold): string | null {
  if (d.approved_by_source !== "cgo" || hold.status === "held") return null;
  return adBudgetRefusal("not_active: the CGO spends only under an active ad budget");
}

export type HoldUpkeep = { status: string; released?: number; released_daily_usd?: number; shrunk?: number };

async function holdUpkeep(tenant_id: string, fn: "release_idle_ad_holds" | "shrink_underdelivering_ad_holds"): Promise<HoldUpkeep> {
  try {
    const r = await tenantRpc(asTenantId(tenant_id), fn, {});
    if (r.error) throw new Error(r.error.message);
    const a = (r.data ?? {}) as Record<string, unknown>;
    return {
      status: typeof a.status === "string" ? a.status : "unknown",
      ...(a.released != null ? { released: Number(a.released) } : {}),
      ...(a.released_daily_usd != null ? { released_daily_usd: Number(a.released_daily_usd) } : {}),
      ...(a.shrunk != null ? { shrunk: Number(a.shrunk) } : {}),
    };
  } catch (e) {
    console.error(`[ad-budget] ${fn} failed for tenant ${tenant_id}; holds unchanged: ${(e as Error).message}`);
    return { status: "error" };
  }
}

export function releaseIdleAdHolds(tenant_id: string): Promise<HoldUpkeep> {
  return holdUpkeep(tenant_id, "release_idle_ad_holds");
}

export function shrinkUnderdeliveringAdHolds(tenant_id: string): Promise<HoldUpkeep> {
  return holdUpkeep(tenant_id, "shrink_underdelivering_ad_holds");
}

export async function adBudgetReadStart(tenant_id: string): Promise<Date | null> {
  try {
    const r = await tenantRpc(asTenantId(tenant_id), "ad_budget_read_start", {});
    if (r.error) throw new Error(r.error.message);
    const at = new Date(String(r.data ?? ""));
    return Number.isFinite(at.getTime()) ? at : null;
  } catch (e) {
    console.error(`[ad-budget] ad_budget_read_start failed for tenant ${tenant_id}; the hold sync is skipped: ${(e as Error).message}`);
    return null;
  }
}

export async function syncAdHoldsToLive(
  tenant_id: string,
  platforms: readonly string[],
  readStartedAt: Date,
): Promise<HoldUpkeep & { lowered?: number }> {
  const held = platforms.filter((p) => p === "meta" || p === "google" || p === "tiktok" || p === "linkedin");
  if (held.length === 0) return { status: "no_platforms" };
  try {
    const r = await tenantRpc(asTenantId(tenant_id), "sync_ad_holds_to_live", {
      p_platforms: [...new Set(held)],
      p_read_started_at: readStartedAt.toISOString(),
    });
    if (r.error) throw new Error(r.error.message);
    const a = (r.data ?? {}) as Record<string, unknown>;
    return {
      status: typeof a.status === "string" ? a.status : "unknown",
      ...(a.released != null ? { released: Number(a.released) } : {}),
      ...(a.released_daily_usd != null ? { released_daily_usd: Number(a.released_daily_usd) } : {}),
      ...(a.lowered != null ? { lowered: Number(a.lowered) } : {}),
    };
  } catch (e) {
    console.error(`[ad-budget] sync_ad_holds_to_live failed for tenant ${tenant_id}; holds unchanged: ${(e as Error).message}`);
    return { status: "error" };
  }
}
