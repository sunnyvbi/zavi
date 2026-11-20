
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";

type SettleRow = { run_id: string | null; amount: number | null; created_at: string };
type ReserveRow = { run_id: string | null; agent_slug: string | null };
type ToolChargeRow = {
  run_id: string | null;
  refunded_daily: number | null;
  refunded_included: number | null;
  refunded_purchased: number | null;
};
type MediaRow = { amount: number | null; created_at: string; agent_slug: string | null };

function mediaLabel(agentSlug: string | null): string {
  const task = (agentSlug ?? "").split(":")[0];
  if (task.startsWith("image.")) return "Images";
  if (task.startsWith("video.")) return "Video";
  if (task === "audio.voiceover") return "Voiceover";
  return "Media";
}

const ALLOWED_WINDOWS = [7, 30, 90] as const;
const DEFAULT_WINDOW_DAYS = 30;
const MS_PER_DAY = 86400 * 1000;
const MAX_AGENTS = 50;
const RESERVE_LOOKUP_CHUNK = 150;

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function resolveWindowDays(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return (ALLOWED_WINDOWS as readonly number[]).includes(n) ? n : DEFAULT_WINDOW_DAYS;
}

export async function billingUsageBreakdown(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const windowDays = resolveWindowDays(req.query.days);

  const svc = serviceClient();
  const nowD = new Date();
  const today0 = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate());
  const startMs = today0 - (windowDays - 1) * MS_PER_DAY;
  const sinceIso = new Date(startMs).toISOString();

  const { data: settleData, error: settleErr } = await svc
    .from("tenant_credit_ledger")
    .select("run_id, amount, created_at")
    .eq("tenant_id", auth.tenant_id)
    .eq("kind", "settle")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });
  if (settleErr) {
    res.status(500).json({ error: { code: "internal", message: settleErr.message } });
    return;
  }
  const settles = (settleData ?? []) as SettleRow[];

  const { data: mediaData, error: mediaErr } = await svc
    .from("tenant_credit_ledger")
    .select("amount, created_at, agent_slug")
    .eq("tenant_id", auth.tenant_id)
    .eq("kind", "media")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });
  if (mediaErr) {
    res.status(500).json({ error: { code: "internal", message: mediaErr.message } });
    return;
  }
  const mediaRows = (mediaData ?? []) as MediaRow[];

  const runIds = Array.from(
    new Set(settles.map((s) => s.run_id).filter((id): id is string => !!id)),
  );
  const runAgent = new Map<string, string>();
  const refundLeft = new Map<string, number>();
  for (let i = 0; i < runIds.length; i += RESERVE_LOOKUP_CHUNK) {
    const chunk = runIds.slice(i, i + RESERVE_LOOKUP_CHUNK);
    const { data: reserveData, error: reserveErr } = await svc
      .from("tenant_credit_ledger")
      .select("run_id, agent_slug")
      .eq("tenant_id", auth.tenant_id)
      .eq("kind", "reserve")
      .in("run_id", chunk);
    if (reserveErr) {
      res.status(500).json({ error: { code: "internal", message: reserveErr.message } });
      return;
    }
    for (const r of (reserveData ?? []) as ReserveRow[]) {
      if (r.run_id && r.agent_slug) runAgent.set(r.run_id, r.agent_slug);
    }
    const { data: chargeData, error: chargeErr } = await svc
      .from("tool_charges")
      .select("run_id, refunded_daily, refunded_included, refunded_purchased")
      .eq("tenant_id", auth.tenant_id)
      .in("run_id", chunk);
    if (chargeErr) {
      res.status(500).json({ error: { code: "internal", message: chargeErr.message } });
      return;
    }
    for (const c of (chargeData ?? []) as ToolChargeRow[]) {
      const back = (c.refunded_daily ?? 0) + (c.refunded_included ?? 0) + (c.refunded_purchased ?? 0);
      if (c.run_id && back > 0) refundLeft.set(c.run_id, (refundLeft.get(c.run_id) ?? 0) + back);
    }
  }

  const buckets = new Map<string, number>();
  for (let i = windowDays - 1; i >= 0; i--) buckets.set(dayKey(today0 - i * MS_PER_DAY), 0);

  const byAgent = new Map<string, number>();
  let total = 0;
  for (const r of settles) {
    let amt = typeof r.amount === "number" && Number.isFinite(r.amount) ? r.amount : 0;
    const back = r.run_id ? (refundLeft.get(r.run_id) ?? 0) : 0;
    if (back > 0 && amt > 0) {
      const take = Math.min(amt, back);
      amt -= take;
      refundLeft.set(r.run_id as string, back - take);
    }
    if (amt <= 0) continue;
    total += amt;
    const k = dayKey(Date.parse(r.created_at));
    if (buckets.has(k)) buckets.set(k, (buckets.get(k) ?? 0) + amt);
    const slug = (r.run_id && runAgent.get(r.run_id)) || "unknown";
    byAgent.set(slug, (byAgent.get(slug) ?? 0) + amt);
  }

  for (const r of mediaRows) {
    const amt = typeof r.amount === "number" && Number.isFinite(r.amount) ? r.amount : 0;
    if (amt <= 0) continue;
    total += amt;
    const k = dayKey(Date.parse(r.created_at));
    if (buckets.has(k)) buckets.set(k, (buckets.get(k) ?? 0) + amt);
    const label = mediaLabel(r.agent_slug);
    byAgent.set(label, (byAgent.get(label) ?? 0) + amt);
  }

  const daily = Array.from(buckets, ([date, credits]) => ({ date, credits }));
  const by_agent = Array.from(byAgent, ([agent_slug, credits]) => ({ agent_slug, credits }))
    .sort((a, b) => b.credits - a.credits)
    .slice(0, MAX_AGENTS);

  res.json({
    window_days: windowDays,
    period_start: dayKey(startMs),
    period_end: dayKey(today0),
    total_credits: total,
    daily,
    by_agent,
  });
}
