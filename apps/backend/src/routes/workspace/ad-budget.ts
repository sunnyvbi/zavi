
import type { Request, Response } from "express";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { loadTenantRole, requireTenantRole } from "@/services/auth/tenant-role";
import { loadTierGateConfig, resolveTenantTier } from "@/services/agents/entitlement";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import {
  parseBudgetInput,
  parseHumanAction,
  readAdBudgetLedger,
  readAdBudgetView,
  stopAdBudget,
  utcToday,
} from "@/services/decisions/ad-budget-setup";
import { stageUndo } from "@/services/decisions/ad-changes";
import { loadLiveForecast } from "@/services/growth/spend-pace";
import type { AdBudgetView } from "@/services/decisions/ad-budget-setup";
import {
  buildMoneyTable,
  readResultsSnapshot,
  readSpendReadFailures,
  readSpendRows,
  spendReadSince,
} from "@/services/growth/ad-money-table";

const MANAGERS = ["owner", "admin"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AD_BUDGET_PRO_MESSAGE = "Ad budgets are on the Pro plan.";

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: { code, message, ...extra } });
}

async function isPro(tenant_id: string): Promise<boolean> {
  return (await resolveTenantTier(tenant_id, await loadTierGateConfig())) === "pro";
}

export async function authorizeWrite(req: Request, res: Response, opts: { anyPlan?: boolean } = {}): Promise<AuthedRequest | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (auth.tenant_overridden === true) {
    fail(res, 403, "tenant_override_forbidden", "Not available for an overridden tenant.");
    return null;
  }
  let allowed: boolean;
  try {
    allowed = await requireTenantRole(auth, MANAGERS, res);
  } catch {
    fail(res, 503, "role_unavailable", "Could not check your role. Try again.");
    return null;
  }
  if (!allowed) return null;
  if (!opts.anyPlan) {
    let pro: boolean;
    try {
      pro = await isPro(auth.tenant_id);
    } catch {
      fail(res, 503, "tier_unavailable", "Could not check your plan. Try again.");
      return null;
    }
    if (!pro) {
      fail(res, 403, "plan_upgrade_required", AD_BUDGET_PRO_MESSAGE, { required_tier: "pro" });
      return null;
    }
  }
  return auth;
}

function budgetIdParam(req: Request, res: Response): string | null {
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) {
    fail(res, 400, "bad_request", "That is not a budget.");
    return null;
  }
  return id;
}

function rpcError(res: Response, e: { message: string; code?: string }): void {
  if (e.code === "42501") {
    fail(res, 403, /Pro plan/.test(e.message) ? "plan_upgrade_required" : "forbidden",
      /Pro plan/.test(e.message) ? AD_BUDGET_PRO_MESSAGE : "Only owners and admins can change the ad budget.");
    return;
  }
  if (e.code === "22023") {
    fail(res, 400, "bad_request", "One of the values is not allowed. Check the monthly amount and the daily limit.");
    return;
  }
  console.error(`[ad-budget] rpc failed: ${e.message}`);
  fail(res, 500, "ad_budget_failed", "Could not save that. Try again.");
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type AdBudgetForecast = {
  daily_usd: number | null;
  runs_out_on: string | null;
  projected_month_usd: number | null;
};

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function adBudgetForecast(
  b: Pick<AdBudgetView, "left_usd" | "spent_usd" | "month_cap_usd" | "next_month_start">,
  live: { forecast_daily_usd: number; actual_today_usd: number },
  now: Date,
): AdBudgetForecast {
  const daily = Number.isFinite(live.forecast_daily_usd) && live.forecast_daily_usd > 0 ? live.forecast_daily_usd : 0;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monthEnd = Date.parse(`${b.next_month_start}T00:00:00Z`);
  const daysLeft = Number.isFinite(monthEnd) ? Math.max(0, Math.round((monthEnd - today) / DAY_MS)) : 0;
  const rest = Math.max(0, daily * daysLeft - (live.actual_today_usd || 0));
  const projected = round2(Math.min(b.month_cap_usd, b.spent_usd + rest));
  if (daily === 0) return { daily_usd: 0, runs_out_on: null, projected_month_usd: projected };
  const day = new Date(today + Math.max(0, Math.floor(b.left_usd / daily)) * DAY_MS).toISOString().slice(0, 10);
  return {
    daily_usd: round2(daily),
    runs_out_on: Number.isFinite(monthEnd) && day < b.next_month_start ? day : null,
    projected_month_usd: projected,
  };
}

async function readForecast(tenant_id: string, budget: AdBudgetView | null): Promise<AdBudgetForecast | null> {
  if (!budget || budget.status !== "active") return null;
  try {
    const now = new Date();
    const live = await Promise.race([
      loadLiveForecast(tenant_id, now, { fetchZones: false }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    return live ? adBudgetForecast(budget, live, now) : null;
  } catch (e) {
    console.warn(`[ad-budget] forecast unreadable for tenant ${tenant_id}: ${(e as Error).message}`);
    return null;
  }
}

export async function getAdBudget(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const [budget, role, pro] = await Promise.all([
      readAdBudgetView(auth.tenant_id),
      loadTenantRole(auth),
      isPro(auth.tenant_id),
    ]);
    res.json({
      budget,
      can_manage: role === "owner" || role === "admin",
      pro,
      forecast: await readForecast(auth.tenant_id, budget),
    });
  } catch (e) {
    console.error(`[ad-budget] read failed for tenant ${auth.tenant_id}: ${(e as Error).message}`);
    fail(res, 503, "ad_budget_unavailable", "Could not load the ad budget.");
  }
}

export async function getAdBudgetLedger(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.json({ rows: await readAdBudgetLedger(auth.tenant_id, auth.user_id) });
  } catch (e) {
    console.error(`[ad-budget] ledger read failed for tenant ${auth.tenant_id}: ${(e as Error).message}`);
    fail(res, 503, "ledger_unavailable", "Could not load the ledger.");
  }
}

export async function getAdBudgetChannels(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const today = utcToday();
    const budget = await readAdBudgetView(auth.tenant_id);
    const monthStart = budget?.month_start ?? `${today.slice(0, 7)}-01`;
    const [spend, snapshot, spendReadFailed] = await Promise.all([
      readSpendRows(auth.tenant_id, spendReadSince(monthStart, today)),
      readResultsSnapshot(auth.access_token, auth.tenant_id),
      readSpendReadFailures(auth.tenant_id, budget?.id ?? null),
    ]);
    res.json(buildMoneyTable({ spend, snapshot, budget, today, spendReadFailed }));
  } catch (e) {
    console.error(`[ad-budget] channels read failed for tenant ${auth.tenant_id}: ${(e as Error).message}`);
    fail(res, 503, "ad_spend_unavailable", "Could not load where your ad money goes.");
  }
}

export async function postAdBudget(req: Request, res: Response): Promise<void> {
  const auth = await authorizeWrite(req, res);
  if (!auth) return;
  const parsed = parseBudgetInput(req.body);
  if (!parsed.ok) return fail(res, 400, "bad_request", parsed.message);
  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "create_ad_budget", {
    p_actor: auth.user_id,
    p_monthly_usd: parsed.value.monthly_usd,
    p_daily_limit_usd: parsed.value.daily_limit_usd,
  });
  if (error) return rpcError(res, error);
  const ans = (data ?? {}) as { status?: string; budget_id?: string; month_cap_usd?: number | string };
  if (ans.status === "already_active") {
    return fail(res, 409, "already_active", "There is already an active ad budget. Stop it before setting up a new one.");
  }
  if (ans.status === "outstanding_holds") {
    return fail(res, 409, "outstanding_holds",
      "Your stopped budget still holds money: ads that could not be paused, or a creator hire not yet charged or released. Press Stop again to pause the ads, and wait for any creator hire to finish, before setting up a new budget.");
  }
  if (ans.status !== "created") return fail(res, 500, "ad_budget_failed", "Could not save that. Try again.");
  res.status(201).json({ budget_id: ans.budget_id, month_cap_usd: Number(ans.month_cap_usd ?? 0) });
}

export async function patchAdBudget(req: Request, res: Response): Promise<void> {
  const auth = await authorizeWrite(req, res);
  if (!auth) return;
  const id = budgetIdParam(req, res);
  if (!id) return;
  const parsed = parseBudgetInput(req.body);
  if (!parsed.ok) return fail(res, 400, "bad_request", parsed.message);
  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "update_ad_budget", {
    p_actor: auth.user_id,
    p_budget_id: id,
    p_monthly_usd: parsed.value.monthly_usd,
    p_daily_limit_usd: parsed.value.daily_limit_usd,
  });
  if (error) return rpcError(res, error);
  const ans = (data ?? {}) as {
    status?: string;
    used_usd?: number | string;
    month_cap_usd?: number | string;
    daily_limit_usd?: number | string;
    live_daily_usd?: number | string;
  };
  switch (ans.status) {
    case "updated":
      res.json({ ok: true, month_cap_usd: Number(ans.month_cap_usd ?? 0) });
      return;
    case "not_found":
      return fail(res, 404, "not_found", "There is no active ad budget to edit.");
    case "below_used": {
      const used = Number(ans.used_usd ?? 0);
      const cap = Number(ans.month_cap_usd ?? 0);
      return fail(res, 409, "below_used",
        `That would make this month's budget ${money(cap)}, but ${money(used)} is already spent or set aside this month for running ads and creator hires. ` +
          `Pick an amount that leaves at least ${money(used)} this month, or pause some ads first.`,
        { used_usd: used, month_cap_usd: cap });
    }
    case "daily_below_live": {
      const limit = Number(ans.daily_limit_usd ?? 0);
      const live = Number(ans.live_daily_usd ?? 0);
      return fail(res, 409, "daily_below_live",
        `Your running ads already spend up to ${money(live)} a day, more than a ${money(limit)} daily limit. ` +
          `Set the daily limit to at least ${money(live)}, or pause some ads first.`,
        { daily_limit_usd: limit, live_daily_usd: live });
    }
  }
  fail(res, 500, "ad_budget_failed", "Could not save that. Try again.");
}

export async function postAdBudgetStop(req: Request, res: Response): Promise<void> {
  const auth = await authorizeWrite(req, res, { anyPlan: true });
  if (!auth) return;
  const id = budgetIdParam(req, res);
  if (!id) return;
  let out;
  try {
    out = await stopAdBudget(auth.tenant_id, auth.user_id, id);
  } catch (e) {
    const err = e as Error & { code?: string };
    console.error(`[ad-budget] stop failed for tenant ${auth.tenant_id}: ${err.message}`);
    if (/not an owner or admin/.test(err.message)) return fail(res, 403, "forbidden", "Only owners and admins can stop the ad budget.");
    return fail(res, 500, "stop_failed", "Could not stop the budget. Try again.");
  }
  if (out.status === "not_found") return fail(res, 404, "not_found", "There is no such ad budget.");
  const failed = out.failed.map(({ platform, object_id, label, reason }) => ({ platform, object_id, label, reason }));
  res.json({ status: out.status, paused: out.paused, failed, partial: failed.length > 0 });
}

export async function postAdBudgetHumanAction(req: Request, res: Response): Promise<void> {
  const auth = await authorizeWrite(req, res);
  if (!auth) return;
  const id = budgetIdParam(req, res);
  if (!id) return;
  const parsed = parseHumanAction(req.body);
  if (!parsed.ok) return fail(res, 400, "bad_request", parsed.message);
  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "log_ad_budget_human_action", {
    p_actor: auth.user_id,
    p_budget_id: id,
    p_occurred_at: parsed.value.occurred_at,
    p_note: parsed.value.note,
    p_amount_usd: parsed.value.amount_usd,
  });
  if (error) return rpcError(res, error);
  const ans = (data ?? {}) as { status?: string };
  if (ans.status === "not_found") return fail(res, 404, "not_found", "There is no such ad budget.");
  if (ans.status !== "logged") return fail(res, 500, "ad_budget_failed", "Could not save that. Try again.");
  res.status(201).json({ ok: true });
}

export async function postAdChangeUndo(req: Request, res: Response): Promise<void> {
  const auth = await authorizeWrite(req, res, { anyPlan: true });
  if (!auth) return;
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return fail(res, 400, "bad_request", "That is not a change in the ledger.");
  let out;
  try {
    out = await stageUndo(auth.tenant_id, id, { isPro: () => isPro(auth.tenant_id) });
  } catch (e) {
    console.error(`[ad-budget] undo failed for tenant ${auth.tenant_id}: ${(e as Error).message}`);
    return fail(res, 500, "undo_failed", "Could not set up the undo. Try again.");
  }
  switch (out.status) {
    case "staged":
      res.status(201).json({ decision_id: out.decision_id, change: out.change, raises_spend: out.raises_spend });
      return;
    case "not_found":
      return fail(res, 404, "not_found", "That change is not in your ledger.");
    case "not_undoable":
      return fail(res, 409, "not_undoable", "This change can't be undone from here.");
    case "changed_since":
      return fail(res, 409, "changed_since", "This ad changed again since. Undo the newest change instead.");
    case "plan_upgrade_required":
      return fail(res, 403, "plan_upgrade_required", AD_BUDGET_PRO_MESSAGE, { required_tier: "pro" });
    case "write_disabled":
      return fail(res, 409, "write_disabled", "Ad changes are switched off right now. Try again later.");
  }
}
