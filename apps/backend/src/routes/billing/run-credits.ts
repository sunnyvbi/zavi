import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { costToCredits, creditsToUsd } from "@/services/agents/credits";
import { BUILD_CONDUCTOR_RUN_ID_KEY } from "@/services/billing/tiers";

export const RUN_CREDITS_MAX_IDS = 40;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RunCreditStatus = "settled" | "pending" | "refunded" | "none";
export type RunCreditsEntry = { credits: number; usd: number; status: RunCreditStatus; covered?: number; daily?: number };

type LedgerRow = { run_id: string | null; kind: string; amount: number | null; attempt?: number | null; debited?: number | null; debited_daily?: number | null };
type ChildRunRow = { id: string; conductor_id: string | null; status?: string | null; cost_usd?: number | string | null };

const BILLABLE_RUN_STATUSES = new Set(["success", "paused_awaiting_approval"]);

export function parseRunIds(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  const ids = Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  );
  if (ids.length === 0 || ids.length > RUN_CREDITS_MAX_IDS) return null;
  if (!ids.every((id) => UUID_RE.test(id))) return null;
  return ids;
}

type ToolChargeRow = {
  run_id: string | null;
  refunded_daily: number | null;
  refunded_included: number | null;
  refunded_purchased: number | null;
};

export function summarizeLedger(
  rows: ReadonlyArray<LedgerRow>,
  refundedByRun: ReadonlyMap<string, number> = new Map(),
  unbilledCredits = 0,
  refundedDailyByRun: ReadonlyMap<string, number> = new Map(),
): RunCreditsEntry {
  const settledByRun = new Map<string, number>();
  const dailyByRun = new Map<string, number>();
  const reserved = new Set<string>();
  const closed = new Set<string>();
  let refunded = false;
  let hasSettle = false;
  let covered = Math.max(0, unbilledCredits);
  for (const row of rows) {
    const attempt = `${(row.run_id ?? "").toLowerCase()}:${row.attempt ?? 0}`;
    if (row.kind === "settle") {
      const run = (row.run_id ?? "").toLowerCase();
      const debited = Math.max(0, row.debited ?? row.amount ?? 0);
      settledByRun.set(run, (settledByRun.get(run) ?? 0) + debited);
      dailyByRun.set(run, (dailyByRun.get(run) ?? 0) + Math.max(0, row.debited_daily ?? 0));
      covered += Math.max(0, (row.amount ?? 0) - debited);
      hasSettle = true;
      closed.add(attempt);
    } else if (row.kind === "refund") {
      refunded = true;
      closed.add(attempt);
    } else if (row.kind === "reserve") {
      reserved.add(attempt);
    }
  }
  let settled = 0;
  for (const [run, credits] of settledByRun) {
    settled += Math.max(0, credits - (refundedByRun.get(run) ?? 0));
  }
  let daily = 0;
  for (const [run, credits] of dailyByRun) {
    daily += Math.max(0, credits - (refundedDailyByRun.get(run) ?? 0));
  }
  const pending = Array.from(reserved).some((id) => !closed.has(id));
  const status: RunCreditStatus = pending
    ? "pending"
    : hasSettle || covered > 0
      ? "settled"
      : refunded
        ? "refunded"
        : "none";
  const entry: RunCreditsEntry = { credits: settled, usd: Number(creditsToUsd(settled).toFixed(4)), status };
  if (covered > 0) entry.covered = covered;
  if (daily > 0) entry.daily = Math.min(daily, settled);
  return entry;
}

export async function billingRunCredits(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const ids = parseRunIds(req.query.ids);
  if (!ids) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: `ids must be 1-${RUN_CREDITS_MAX_IDS} comma-separated run ids`,
      },
    });
    return;
  }

  const sb = tenantClient(asTenantId(auth.tenant_id));
  const { data: childData, error: childErr } = await sb
    .from("agent_runs")
    .select(`id, status, cost_usd, conductor_id:payload->>${BUILD_CONDUCTOR_RUN_ID_KEY}`)
    .in(`payload->>${BUILD_CONDUCTOR_RUN_ID_KEY}`, ids);
  if (childErr) {
    res.status(500).json({ error: { code: "internal", message: childErr.message } });
    return;
  }
  const membersOf = new Map<string, string[]>();
  for (const id of ids) membersOf.set(id, [id]);
  const workCredits = new Map<string, number>();
  for (const row of (childData ?? []) as ChildRunRow[]) {
    const conductorId = (row.conductor_id ?? "").toLowerCase();
    const childId = row.id.toLowerCase();
    const members = membersOf.get(conductorId);
    if (members && UUID_RE.test(childId) && !members.includes(childId)) {
      members.push(childId);
      if (BILLABLE_RUN_STATUSES.has(row.status ?? "")) workCredits.set(childId, costToCredits(Number(row.cost_usd)));
    }
  }
  const lookup = Array.from(new Set(Array.from(membersOf.values()).flat()));

  const { data: ledgerData, error: ledgerErr } = await sb
    .from("tenant_credit_ledger")
    .select("run_id, kind, amount, attempt, debited, debited_daily")
    .in("kind", ["reserve", "settle", "refund"])
    .in("run_id", lookup);
  if (ledgerErr) {
    res.status(500).json({ error: { code: "internal", message: ledgerErr.message } });
    return;
  }
  const byRun = new Map<string, LedgerRow[]>();
  for (const row of (ledgerData ?? []) as LedgerRow[]) {
    const key = (row.run_id ?? "").toLowerCase();
    const list = byRun.get(key) ?? [];
    list.push(row);
    byRun.set(key, list);
  }

  const { data: chargeData, error: chargeErr } = await sb
    .from("tool_charges")
    .select("run_id, refunded_daily, refunded_included, refunded_purchased")
    .in("run_id", lookup);
  if (chargeErr) {
    res.status(500).json({ error: { code: "internal", message: chargeErr.message } });
    return;
  }
  const refundedByRun = new Map<string, number>();
  const refundedDailyByRun = new Map<string, number>();
  for (const c of (chargeData ?? []) as ToolChargeRow[]) {
    const key = (c.run_id ?? "").toLowerCase();
    const back = (c.refunded_daily ?? 0) + (c.refunded_included ?? 0) + (c.refunded_purchased ?? 0);
    if (key && back > 0) refundedByRun.set(key, (refundedByRun.get(key) ?? 0) + back);
    if (key && (c.refunded_daily ?? 0) > 0) refundedDailyByRun.set(key, (refundedDailyByRun.get(key) ?? 0) + (c.refunded_daily ?? 0));
  }

  const runs: Record<string, RunCreditsEntry> = {};
  for (const [id, members] of membersOf) {
    const unbilled = members.reduce((total, m) => total + (byRun.has(m) ? 0 : (workCredits.get(m) ?? 0)), 0);
    runs[id] = summarizeLedger(members.flatMap((m) => byRun.get(m) ?? []), refundedByRun, unbilled, refundedDailyByRun);
  }
  res.json({ runs });
}
