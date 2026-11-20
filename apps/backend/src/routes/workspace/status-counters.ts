
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import { creditsEnforcedFromBlob } from "@/services/agents/credits";
import {
  creditBalanceView,
  type BalanceRow,
  type BalanceSubRow,
} from "@/services/billing/balance-view";
import { tenantDayStartIso } from "@/services/tenants/local-day";
import {
  countOpenChannelActions,
  totalWaitingOnYou,
} from "@/services/channels/open-actions-count";

export async function workspaceStatusCounters(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);

  let tenantTz: string | null = null;
  let credits_unlimited = false;
  try {
    const { data: t } = await serviceClient()
      .from("tenants")
      .select("credits_unlimited, timezone")
      .eq("id", auth.tenant_id)
      .maybeSingle<{ credits_unlimited: boolean | null; timezone: string | null }>();
    credits_unlimited = t?.credits_unlimited === true;
    tenantTz = t?.timezone ?? null;
  } catch {
    credits_unlimited = false;
    tenantTz = null;
  }
  const todayStartIso = tenantDayStartIso(tenantTz);

  const [costRes, activeRes, approvalsRes, openChannelActions, creditRes, subRes, cfgRes] = await Promise.all([
    supabase
      .from("agent_runs")
      .select("cost_usd")
      .eq("tenant_id", auth.tenant_id)
      .neq("agent_definition_hash", "seed-synthetic")
      .gte("started_at", todayStartIso),
    supabase
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", auth.tenant_id)
      .neq("agent_definition_hash", "seed-synthetic")
      .in("status", ["queued", "running"]),
    supabase
      .from("customer_visible_pending_decisions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", auth.tenant_id),
    countOpenChannelActions(supabase, auth.tenant_id),
    supabase
      .from("tenant_credit_balances")
      .select("included_allowance, included_used, purchased_balance, reserved, period_start, period_end, daily_allowance, daily_used, daily_period_end")
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle(),
    supabase
      .from("tenant_subscriptions")
      .select("plan, status, tier, current_period_end, comp_expires_at")
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle(),
    serviceClient().from("system_config").select("blob").eq("id", 1).maybeSingle(),
  ]);

  if (costRes.error) {
    res.status(500).json({
      error: { code: "cost_query_failed", message: costRes.error.message },
    });
    return;
  }
  if (activeRes.error) {
    res.status(500).json({
      error: { code: "active_query_failed", message: activeRes.error.message },
    });
    return;
  }
  if (approvalsRes.error) {
    res.status(500).json({
      error: {
        code: "approvals_query_failed",
        message: approvalsRes.error.message,
      },
    });
    return;
  }

  const cost_today_usd = (costRes.data ?? []).reduce(
    (sum, r) => sum + ((r as { cost_usd: number | null }).cost_usd ?? 0),
    0,
  );

  let credits_remaining: number | null = null;
  let included_allowance: number | null = null;
  let credits_total: number | null = null;
  if (!creditRes.error) {
    const v = creditBalanceView(
      (subRes.data as BalanceSubRow | null) ?? null,
      (creditRes.data as BalanceRow | null) ?? null,
      cfgRes.data?.blob,
    );
    credits_remaining = Math.max(0, v.effective_available);
    included_allowance = v.allowance;
    credits_total = v.credits_total;
  }

  let credits_enforced = false;
  try {
    const { data: cfg } = await serviceClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{
        blob: { credits_enforced?: boolean; credits_enforced_allowlist?: unknown } | null;
      }>();
    credits_enforced = creditsEnforcedFromBlob(cfg?.blob, auth.tenant_id);
  } catch {
    credits_enforced = false;
  }

  res.json({
    drift_pct: 0,
    cost_today_usd,
    active_runs: activeRes.count ?? 0,
    approvals_pending: totalWaitingOnYou(approvalsRes.count, openChannelActions),
    credits_remaining,
    credits_enforced,
    credits_unlimited,
    included_allowance,
    credits_total,
  });
}
