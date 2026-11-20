
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import {
  creditAllowanceFor,
  creditsToUsd,
  CREDIT_USD,
  creditsEnforcedFromBlob,
} from "@/services/agents/credits";
import type { Plan } from "@/services/agents/entitlement";

type TenantRow = { id: string; slug: string; display_name: string; credits_unlimited: boolean | null };
type SubRow = {
  plan: Plan;
  status: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  monthly_credits: number | null;
  credits_revoked_at: string | null;
  tier: string | null;
  comp_expires_at: string | null;
};
type BalanceRow = {
  period_start: string;
  period_end: string;
  included_allowance: number;
  included_used: number;
  purchased_balance: number;
  reserved: number;
  updated_at: string | null;
};
type SettleRow = { run_id: string | null; amount: number | null; created_at: string; kind?: string | null; agent_slug?: string | null };
type ReserveRow = { run_id: string | null; agent_slug: string | null };

const WINDOW_DAYS = 30;
const MS_PER_DAY = 86400 * 1000;
const MAX_AGENTS = 50;

function currentCalendarMonth(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function staffTenantCredits(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenantId = req.params.tenant_id;
  const svc = serviceClient();

  const tenantQ = svc
    .from("tenants")
    .select("id, slug, display_name, credits_unlimited")
    .eq("id", tenantId)
    .maybeSingle<TenantRow>();

  const subQ = svc
    .from("tenant_subscriptions")
    .select(
      "plan, status, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end, monthly_credits, credits_revoked_at, tier, comp_expires_at",
    )
    .eq("tenant_id", tenantId)
    .maybeSingle<SubRow>();

  const balQ = svc
    .from("tenant_credit_balances")
    .select(
      "period_start, period_end, included_allowance, included_used, purchased_balance, reserved, updated_at",
    )
    .eq("tenant_id", tenantId)
    .maybeSingle<BalanceRow>();

  const cfgQ = svc
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{
      blob: { credits_enforced?: boolean; credits_enforced_allowlist?: unknown } | null;
    }>();

  const nowD = new Date();
  const today0 = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate());
  const startMs = today0 - (WINDOW_DAYS - 1) * MS_PER_DAY;
  const sinceIso = new Date(startMs).toISOString();
  const settleQ = svc
    .from("tenant_credit_ledger")
    .select("run_id, amount, created_at, kind, agent_slug")
    .eq("tenant_id", tenantId)
    .in("kind", ["settle", "media"])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });

  const [tenantRes, sub, bal, cfg, settle] = await Promise.all([tenantQ, subQ, balQ, cfgQ, settleQ]);

  if (tenantRes.error) {
    res
      .status(500)
      .json({ error: { code: "tenant_lookup_failed", message: tenantRes.error.message } });
    return;
  }
  if (!tenantRes.data) {
    res.status(404).json({ error: { code: "tenant_not_found", message: tenantId } });
    return;
  }
  const tenant = tenantRes.data;

  if (sub.error) {
    res.status(500).json({ error: { code: "sub_query_failed", message: sub.error.message } });
    return;
  }
  if (bal.error) {
    res.status(500).json({ error: { code: "balance_query_failed", message: bal.error.message } });
    return;
  }
  if (settle.error) {
    res.status(500).json({ error: { code: "usage_query_failed", message: settle.error.message } });
    return;
  }

  const plan: Plan = sub.data?.plan ?? "free";
  const enforced = creditsEnforcedFromBlob(cfg.data?.blob, tenantId);

  const month = currentCalendarMonth();
  const balRow = bal.data;
  const rowIsCurrent = !!balRow && balRow.period_end > month.start;
  const allowance = rowIsCurrent ? balRow!.included_allowance : creditAllowanceFor(plan);
  const used = rowIsCurrent ? balRow!.included_used : 0;
  const reserved = rowIsCurrent ? balRow!.reserved : 0;
  const purchased = balRow?.purchased_balance ?? 0;
  const includedRemaining = Math.max(0, allowance - used);
  const effectiveAvailable = includedRemaining + purchased - reserved;

  const settles = (settle.data ?? []) as SettleRow[];
  const runIds = Array.from(
    new Set(settles.filter((s) => s.kind !== "media").map((s) => s.run_id).filter((id): id is string => !!id)),
  );
  const runAgent = new Map<string, string>();
  if (runIds.length > 0) {
    const { data: reserveData } = await svc
      .from("tenant_credit_ledger")
      .select("run_id, agent_slug")
      .eq("tenant_id", tenantId)
      .eq("kind", "reserve")
      .in("run_id", runIds);
    for (const r of (reserveData ?? []) as ReserveRow[]) {
      if (r.run_id && r.agent_slug) runAgent.set(r.run_id, r.agent_slug);
    }
  }

  const buckets = new Map<string, number>();
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) buckets.set(dayKey(today0 - i * MS_PER_DAY), 0);
  const byAgent = new Map<string, number>();
  let usageTotal = 0;
  for (const r of settles) {
    const amt = typeof r.amount === "number" && Number.isFinite(r.amount) ? r.amount : 0;
    if (amt <= 0) continue;
    usageTotal += amt;
    const k = dayKey(Date.parse(r.created_at));
    if (buckets.has(k)) buckets.set(k, (buckets.get(k) ?? 0) + amt);
    const slug = r.kind === "media" ? (r.agent_slug ?? "media") : (r.run_id && runAgent.get(r.run_id)) || "unknown";
    byAgent.set(slug, (byAgent.get(slug) ?? 0) + amt);
  }
  const daily = Array.from(buckets, ([date, credits]) => ({ date, credits }));
  const by_agent = Array.from(byAgent, ([agent_slug, credits]) => ({ agent_slug, credits }))
    .sort((a, b) => b.credits - a.credits)
    .slice(0, MAX_AGENTS);

  res.json({
    tenant: { id: tenant.id, slug: tenant.slug, display_name: tenant.display_name },
    credit_usd: CREDIT_USD,
    enforced,
    credits_unlimited: tenant.credits_unlimited === true,
    subscription: {
      plan,
      status: sub.data?.status ?? null,
      grandfathered: false,
      monthly_credits: sub.data?.monthly_credits ?? null,
      stripe_customer_id: sub.data?.stripe_customer_id ?? null,
      stripe_subscription_id: sub.data?.stripe_subscription_id ?? null,
      current_period_end: sub.data?.current_period_end ?? null,
      cancel_at_period_end: sub.data?.cancel_at_period_end ?? null,
      credits_revoked_at: sub.data?.credits_revoked_at ?? null,
      tier: sub.data?.tier ?? null,
      comp_expires_at: sub.data?.comp_expires_at ?? null,
    },
    balance: {
      period_start: rowIsCurrent ? balRow!.period_start : month.start,
      period_end: rowIsCurrent ? balRow!.period_end : month.end,
      included_allowance: allowance,
      included_used: used,
      included_remaining: includedRemaining,
      purchased_balance: purchased,
      reserved,
      effective_available: effectiveAvailable,
      effective_available_display: Math.max(0, effectiveAvailable),
      effective_available_usd: creditsToUsd(Math.max(0, effectiveAvailable)),
      has_balance_row: !!balRow,
      updated_at: balRow?.updated_at ?? null,
    },
    usage_30d: {
      window_days: WINDOW_DAYS,
      period_start: dayKey(startMs),
      period_end: dayKey(today0),
      total_credits: usageTotal,
      total_usd: creditsToUsd(usageTotal),
      daily,
      by_agent,
    },
  });
}

type LedgerRow = {
  id: string;
  run_id: string | null;
  kind: string;
  amount: number;
  source: string;
  agent_slug: string | null;
  cost_usd: number | null;
  period_start: string;
  stripe_payment_intent_id: string | null;
  created_at: string;
};

export async function staffTenantCreditLedger(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenantId = req.params.tenant_id;
  const svc = serviceClient();

  const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
  const before = typeof req.query.before === "string" && req.query.before ? req.query.before : null;

  let q = svc
    .from("tenant_credit_ledger")
    .select(
      "id, run_id, kind, amount, source, agent_slug, cost_usd, period_start, stripe_payment_intent_id, created_at",
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (before) q = q.lt("created_at", before);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ error: { code: "ledger_query_failed", message: error.message } });
    return;
  }

  const rows = (data ?? []) as LedgerRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const needResolve = page.filter((r) => !r.agent_slug && r.run_id).map((r) => r.run_id as string);
  if (needResolve.length > 0) {
    const { data: reserveData } = await svc
      .from("tenant_credit_ledger")
      .select("run_id, agent_slug")
      .eq("tenant_id", tenantId)
      .eq("kind", "reserve")
      .in("run_id", Array.from(new Set(needResolve)));
    const map = new Map<string, string>();
    for (const r of (reserveData ?? []) as ReserveRow[]) {
      if (r.run_id && r.agent_slug) map.set(r.run_id, r.agent_slug);
    }
    for (const r of page) {
      if (!r.agent_slug && r.run_id && map.has(r.run_id)) r.agent_slug = map.get(r.run_id) ?? null;
    }
  }

  res.json({
    rows: page,
    next_before: hasMore ? page[page.length - 1]?.created_at ?? null : null,
  });
}
