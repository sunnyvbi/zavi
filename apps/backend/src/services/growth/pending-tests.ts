
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { budgetMargin, readActiveAdBudget } from "@/services/decisions/ad-budget";
import { flightDaysTo, launchHoldUsd } from "@/services/connectors/tiktok-ads/launch-schema";

export type PendingChannel = "tiktok_ads" | "reddit_ads";
export const PENDING_TEST_DAYS = 7;
export const PENDING_TEST_MAX_DAYS = 28;
const DAY_MS = 86_400_000;

export const PENDING_CHANNEL_LABEL: Record<PendingChannel, string> = { tiktok_ads: "TikTok", reddit_ads: "Reddit" };

export type PendingTestRow = {
  id: string;
  tenant_id: string;
  channel_slug: PendingChannel;
  status: "pending" | "claimed" | "closed";
  daily_budget_usd: number;
  hold_usd: number;
  proposal: Record<string, unknown>;
  action_id: string | null;
  hold_idem_key: string | null;
  closed_reason: string | null;
  revision: number;
  created_at: string;
  expires_at: string;
  updated_at: string;
};

const COLUMNS = "id,tenant_id,channel_slug,status,daily_budget_usd,hold_usd,proposal,action_id,hold_idem_key,closed_reason,revision,created_at,expires_at,updated_at";

function parseRow(raw: Record<string, unknown>): PendingTestRow {
  return {
    ...(raw as unknown as PendingTestRow),
    daily_budget_usd: Number(raw.daily_budget_usd),
    hold_usd: Number(raw.hold_usd),
    revision: Number(raw.revision),
    proposal: raw.proposal && typeof raw.proposal === "object" && !Array.isArray(raw.proposal) ? (raw.proposal as Record<string, unknown>) : {},
  };
}

export async function readPendingTests(tenant_id: string): Promise<PendingTestRow[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("ad_pending_tests").select(COLUMNS).limit(10);
  if (error) throw new Error(`ad_pending_tests read failed: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map(parseRow);
}

export function isLivePending(r: Pick<PendingTestRow, "status" | "expires_at">, now: Date): boolean {
  return r.status === "pending" && Date.parse(r.expires_at) > now.getTime();
}

export function pendingReserveUsd(rows: readonly PendingTestRow[], budget: { days_left: number; margin: number }, now: Date): number {
  let sum = 0;
  for (const r of rows) if (isLivePending(r, now)) sum += launchHoldUsd(r.daily_budget_usd, budget.days_left, budget.margin, flightDaysTo(r.proposal.end_date, now), r.channel_slug === "tiktok_ads" ? 1.25 : 1);
  return Math.round(sum * 100) / 100;
}

export function pendingDailyUsd(rows: readonly PendingTestRow[], now: Date): number {
  let sum = 0;
  for (const r of rows) if (isLivePending(r, now)) sum += launchHoldUsd(r.daily_budget_usd, 1, 1, undefined, r.channel_slug === "tiktok_ads" ? 1.25 : 1);
  return Math.round(sum * 100) / 100;
}

export type RecordResult =
  | { status: "recorded" | "replaced"; expires_at: string }
  | { status: "claim_open"; action_id: string | null }
  | { status: "gave_up" };

export async function recordPendingTest(
  tenant_id: string,
  t: { channel: PendingChannel; daily_budget_usd: number; hold_usd: number; proposal: Record<string, unknown> },
  now: Date = new Date(),
): Promise<RecordResult> {
  if (!(t.daily_budget_usd > 0) || !(t.hold_usd >= 0)) throw new Error("pending test: unreadable amounts");
  const db = tenantClient(asTenantId(tenant_id));
  const at = now.toISOString();
  const expires_at = new Date(now.getTime() + PENDING_TEST_DAYS * DAY_MS).toISOString();
  const fields = {
    status: "pending",
    daily_budget_usd: Math.ceil(t.daily_budget_usd * 100) / 100,
    hold_usd: Math.ceil(t.hold_usd * 100) / 100,
    proposal: t.proposal,
    action_id: null,
    hold_idem_key: null,
    closed_reason: null,
    created_at: at,
    expires_at,
    updated_at: at,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await db.from("ad_pending_tests").select("id,status,action_id,revision,created_at").eq("channel_slug", t.channel).limit(1);
    if (error) throw new Error(`ad_pending_tests read failed: ${error.message}`);
    const prior = ((data ?? []) as Array<{ id: string; status: string; action_id: string | null; revision: number; created_at: string | null }>)[0];
    if (!prior) {
      const ins = await db.from("ad_pending_tests").insert({ channel_slug: t.channel, ...fields, revision: 1 });
      if (!ins.error) return { status: "recorded", expires_at };
      if ((ins.error as { code?: string }).code !== "23505") throw new Error(`ad_pending_tests insert failed: ${ins.error.message}`);
      continue;
    }
    if (prior.status === "claimed") return { status: "claim_open", action_id: prior.action_id };
    if (prior.status === "pending" && prior.action_id) return { status: "claim_open", action_id: prior.action_id };
    let keep: { created_at: string; expires_at: string } | null = null;
    const born = prior.status === "pending" && prior.created_at ? Date.parse(prior.created_at) : NaN;
    if (Number.isFinite(born)) {
      const last = born + PENDING_TEST_MAX_DAYS * DAY_MS;
      if (now.getTime() >= last) {
        const closed = await db
          .from("ad_pending_tests")
          .update({ status: "closed", closed_reason: "expired", updated_at: at, revision: Number(prior.revision) + 1 })
          .eq("id", prior.id)
          .eq("revision", prior.revision)
          .select("id");
        if (closed.error) throw new Error(`ad_pending_tests update failed: ${closed.error.message}`);
        if ((closed.data ?? []).length === 1) return { status: "gave_up" };
        continue;
      }
      keep = { created_at: new Date(born).toISOString(), expires_at: new Date(Math.min(now.getTime() + PENDING_TEST_DAYS * DAY_MS, last)).toISOString() };
    }
    const up = await db
      .from("ad_pending_tests")
      .update({ ...fields, ...(keep ?? {}), revision: Number(prior.revision) + 1 })
      .eq("id", prior.id)
      .eq("revision", prior.revision)
      .select("id");
    if (up.error) throw new Error(`ad_pending_tests update failed: ${up.error.message}`);
    if ((up.data ?? []).length === 1) return { status: prior.status === "pending" ? "replaced" : "recorded", expires_at: keep?.expires_at ?? expires_at };
  }
  throw new Error("ad_pending_tests: the row kept changing, nothing recorded");
}

export type PendingRoom = {
  reserve_usd: number;
  daily_usd: number;
  left_usd: number;
  days_left: number;
  margin: number;
  channels: PendingChannel[];
};

export async function loadPendingRoom(tenant_id: string, now: Date = new Date()): Promise<PendingRoom | null> {
  const rows = await readPendingTests(tenant_id);
  const live = rows.filter((r) => isLivePending(r, now));
  if (live.length === 0) return null;
  const b = await readActiveAdBudget(tenant_id);
  if (!b) return null;
  const margin = budgetMargin(b);
  return {
    reserve_usd: pendingReserveUsd(live, { days_left: b.days_left, margin }, now),
    daily_usd: pendingDailyUsd(live, now),
    left_usd: b.left_usd,
    days_left: b.days_left,
    margin,
    channels: live.map((r) => r.channel_slug),
  };
}

type SpendOrder = { exec_class: string; body: Record<string, unknown>; adds_usd: number };

export function orderDailyAddUsd(o: SpendOrder): number {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const next = n(o.body.daily_budget_usd);
  const from = n(o.body.expected_current_daily_budget_usd);
  const fromBody = next === null ? 0 : from === null ? next : next - from;
  return Math.max(0, Number.isFinite(o.adds_usd) ? o.adds_usd : 0, fromBody);
}

export function fitOrdersToRoom<T extends SpendOrder>(orders: readonly T[], room_usd: number, days_left: number, margin: number): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  let left = Number.isFinite(room_usd) ? room_usd : 0;
  for (const o of orders) {
    const daily = orderDailyAddUsd(o);
    if (daily <= 0) {
      kept.push(o);
      continue;
    }
    const dynamicTikTok = o.exec_class.startsWith("tiktok_ads.") && (o.body.budget_mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET" || o.body.expected_current_budget_mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET");
    const hold = launchHoldUsd(daily, Math.max(1, days_left), Math.max(1, margin), undefined, dynamicTikTok ? 1.25 : 1);
    if (hold <= left) {
      kept.push(o);
      left = Math.round((left - hold) * 100) / 100;
    } else dropped.push(o);
  }
  return { kept, dropped };
}

export async function keepPendingTestRoom<T extends SpendOrder>(
  orders: readonly T[],
  read: () => Promise<PendingRoom | null>,
): Promise<{ orders: T[]; note: string | null; kept_room: boolean }> {
  if (!orders.some((o) => orderDailyAddUsd(o) > 0)) return { orders: [...orders], note: null, kept_room: false };
  let room: PendingRoom | null;
  try {
    room = await read();
  } catch (e) {
    const kept = orders.filter((o) => orderDailyAddUsd(o) <= 0);
    return {
      orders: kept,
      note: `pending channel tests could not be read (${(e as Error).message.slice(0, 120)}): no order that adds daily spend this hour`,
      kept_room: true,
    };
  }
  if (!room) return { orders: [...orders], note: null, kept_room: false };
  const free = Math.round((room.left_usd - room.reserve_usd) * 100) / 100;
  const { kept, dropped } = fitOrdersToRoom(orders, free, room.days_left, room.margin);
  const names = room.channels.map((c) => PENDING_CHANNEL_LABEL[c]).join(" and ");
  if (dropped.length === 0) {
    return { orders: kept, note: `$${room.reserve_usd.toFixed(2)} kept free for the pending ${names} test`, kept_room: false };
  }
  return {
    orders: kept,
    note: `${dropped.length} order${dropped.length === 1 ? "" : "s"} not placed: $${room.reserve_usd.toFixed(2)} of the budget is kept free for the pending ${names} test ($${Math.max(0, free).toFixed(2)} left beside it)`,
    kept_room: true,
  };
}

export async function spareAfterPendingTests(
  spare: number | null,
  tenant_id: string,
  now: Date,
  read: (tenant_id: string, now: Date) => Promise<PendingRoom | null> = loadPendingRoom,
): Promise<number | null> {
  if (spare === null) return null;
  try {
    const room = await read(tenant_id, now);
    if (!room) return spare;
    const beside = Math.max(0, room.left_usd - room.reserve_usd) / (Math.max(1, room.days_left) * Math.max(1, room.margin));
    return Math.max(0, Math.floor(Math.min(spare - room.daily_usd, beside) * 100) / 100);
  } catch (e) {
    console.warn(`[pending-tests] spare capacity for ${tenant_id} set to 0: pending tests unreadable: ${(e as Error).message}`);
    return 0;
  }
}
