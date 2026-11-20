
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { buildAllowanceFor, type Plan } from "@/services/agents/entitlement";

type SubRow = { plan: Plan; status: string };
type CreditRow = {
  period_start: string;
  period_end: string;
  included_allowance: number;
  included_used: number;
  purchased_balance: number;
};

function currentCalendarMonth(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export async function billingUsage(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const svc = serviceClient();

  const { data: sub, error: subErr } = await svc
    .from("tenant_subscriptions")
    .select("plan, status")
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle<SubRow>();
  if (subErr) {
    res.status(500).json({ error: { code: "internal", message: subErr.message } });
    return;
  }
  const plan: Plan = sub?.plan ?? "free";
  const allowance = buildAllowanceFor(plan);

  const { data: credit, error: credErr } = await svc
    .from("tenant_build_credits")
    .select("period_start, period_end, included_allowance, included_used, purchased_balance")
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle<CreditRow>();
  if (credErr) {
    res.status(500).json({ error: { code: "internal", message: credErr.message } });
    return;
  }

  const { data: cfg } = await svc
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: { build_credits_enforced?: boolean } | null }>();
  const enforced = cfg?.blob?.build_credits_enforced === true;

  const month = currentCalendarMonth();
  const rowIsCurrent = credit && credit.period_end > month.start;
  const used = rowIsCurrent ? credit!.included_used : 0;
  const purchased = credit?.purchased_balance ?? 0;
  const includedRemaining = Math.max(0, allowance - used);

  res.json({
    enforced,
    plan,
    period_start: rowIsCurrent ? credit!.period_start : month.start,
    period_end: rowIsCurrent ? credit!.period_end : month.end,
    included_allowance: allowance,
    included_used: used,
    included_remaining: includedRemaining,
    purchased_balance: purchased,
    total_remaining: includedRemaining + purchased,
  });
}
