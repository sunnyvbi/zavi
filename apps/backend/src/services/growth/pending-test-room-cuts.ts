
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { budgetMargin, readActiveAdBudget } from "@/services/decisions/ad-budget";
import { launchHoldUsd } from "@/services/connectors/tiktok-ads/launch-schema";
import { PENDING_CHANNEL_LABEL, isLivePending, readPendingTests, type PendingChannel } from "./pending-tests";
import type { AdObject, PlannedOrder } from "./ad-spend-controller";
import type { CutCandidate } from "./business-rules";
import type { PlannerNumbers } from "./cgo-ad-orders";
import { MAKE_ROOM_FLOOR_USD, freedDailyUsd, makeRoomTo, roomOfDaily } from "./make-room-math";

export const MAKE_ROOM_TEST_KEY = "make_room_test_id";
export const MAKE_ROOM_REVISION_KEY = "make_room_test_revision";
export const MAKE_ROOM_FREES_KEY = "make_room_frees_usd";
export const IN_FLIGHT_HOURS = 3;
export const EXECUTED_IN_FLIGHT_HOURS = 24;
export const MIN_MAKE_ROOM_CUT_USD = 1;
const FLOOR_USD = MAKE_ROOM_FLOOR_USD;

const round2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${round2(n).toFixed(2)}`;

export type MakeRoomTest = { id: string; revision: number; channel: PendingChannel; daily_budget_usd: number; hold_usd: number; created_at: string };

export type MakeRoomNeed = {
  budget_id: string;
  left_usd: number;
  days_left: number;
  margin: number;
  tests: MakeRoomTest[];
  inflight_usd: number;
  inflight: number;
};

export type ObjectHold = {
  held_daily_usd: number;
  base_usd: number;
};

export const holdKeyOf = (platform: "meta" | "google", id: string) => `${platform}:${id}`;

export { freedDailyUsd, roomOfDaily };

export type ShortTest = { test: MakeRoomTest; short_usd: number };

export function shortTests(need: Pick<MakeRoomNeed, "left_usd" | "inflight_usd" | "tests">): ShortTest[] {
  let available = Math.max(0, need.left_usd) + Math.max(0, need.inflight_usd);
  const out: ShortTest[] = [];
  for (const t of [...need.tests].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    if (available >= t.hold_usd) {
      available = round2(available - t.hold_usd);
      continue;
    }
    out.push({ test: t, short_usd: round2(t.hold_usd - available) });
    available = 0;
  }
  return out;
}

export type MakeRoomCut = {
  test_id: string;
  test_revision: number;
  channel: PendingChannel;
  object: AdObject;
  from_usd: number;
  to_usd: number;
  freed_daily_usd: number;
  frees_usd: number;
  step: number;
  hold_daily_usd: number;
  base_usd: number;
  need_daily_usd: number;
  max_step: number;
  short_usd: number;
  days_left: number;
  margin: number;
  median_cpr_usd: number | null;
};

export type MakeRoomPlan = {
  orders: PlannedOrder[];
  cuts: MakeRoomCut[];
  still_short: Array<{ test: MakeRoomTest; short_usd: number; why: string }>;
};

export function sizeCut(o: AdObject, h: ObjectHold | undefined, needDaily: number, maxStep: number): { to: number; freed: number; step: number } | { skip: "not_held" | "too_small" } {
  const from = o.daily_budget_usd;
  if (from === null || !(from > 0) || !h) return { skip: "not_held" };
  const cur = Math.min(h.held_daily_usd, Math.max(0, from - h.base_usd));
  if (!(cur > 0)) return { skip: "not_held" };
  const to = makeRoomTo({ from_usd: from, hold_daily_usd: h.held_daily_usd, base_usd: h.base_usd, need_daily_usd: needDaily, step: maxStep, floor_usd: FLOOR_USD });
  if (from - to < MIN_MAKE_ROOM_CUT_USD) return { skip: "too_small" };
  const freed = freedDailyUsd(h, from, to);
  if (!(freed > 0)) return { skip: "not_held" };
  return { to, freed, step: round2((from - to) / from) };
}

export function planMakeRoomCuts(a: {
  need: MakeRoomNeed;
  cands: readonly CutCandidate[];
  holds: ReadonlyMap<string, ObjectHold>;
  maxStep: number;
  excluded?: ReadonlySet<string>;
  numbers?: { required_usd: number; capacity_usd: number };
}): MakeRoomPlan {
  const { need } = a;
  const days = Math.max(1, need.days_left);
  const margin = Math.max(1, need.margin);
  const used = new Set<string>();
  const orders: PlannedOrder[] = [];
  const cuts: MakeRoomCut[] = [];
  const still_short: MakeRoomPlan["still_short"] = [];
  for (const { test, short_usd } of shortTests(need)) {
    let remaining = short_usd;
    let notHeld = 0;
    let tooSmall = 0;
    let tried = 0;
    for (const c of a.cands) {
      if (remaining <= 0) break;
      const key = holdKeyOf(c.o.platform, c.o.id);
      if (used.has(key) || a.excluded?.has(key)) continue;
      tried += 1;
      const needDaily = Math.ceil((remaining / (days * margin)) * 100) / 100;
      const s = sizeCut(c.o, a.holds.get(key), needDaily, a.maxStep);
      if ("skip" in s) {
        if (s.skip === "not_held") notHeld += 1;
        else tooSmall += 1;
        continue;
      }
      used.add(key);
      const h = a.holds.get(key)!;
      const frees = roomOfDaily(s.freed, days, margin);
      const cut: MakeRoomCut = {
        test_id: test.id,
        test_revision: test.revision,
        channel: test.channel,
        object: c.o,
        from_usd: c.o.daily_budget_usd as number,
        to_usd: s.to,
        freed_daily_usd: s.freed,
        frees_usd: frees,
        step: s.step,
        hold_daily_usd: h.held_daily_usd,
        base_usd: h.base_usd,
        need_daily_usd: needDaily,
        max_step: a.maxStep,
        short_usd: remaining,
        days_left: days,
        margin,
        median_cpr_usd: Number.isFinite(c.median) ? c.median : null,
      };
      remaining = round2(remaining - frees);
      cuts.push(cut);
      orders.push(orderOf(cut, c.why, a.numbers));
    }
    if (remaining > 0) {
      const why =
        a.cands.length === 0
          ? "no clearly worse ad to cut"
          : tried === 0
            ? "every clearly worse ad is protected this hour"
            : notHeld > 0 && tooSmall === 0
              ? `the clearly worse ads left hold no Zavi budget a cut would free (${notHeld})`
              : `the clearly worse ads left are protected, hold nothing a cut frees, or are already near $${FLOOR_USD}/day (${notHeld} not held, ${tooSmall} too small)`;
      still_short.push({ test, short_usd: round2(remaining), why });
    }
  }
  return { orders, cuts, still_short };
}

export function orderOf(c: MakeRoomCut, why: string, numbers: { required_usd: number; capacity_usd: number } = { required_usd: 0, capacity_usd: 0 }): PlannedOrder {
  const o = c.object;
  const label = PENDING_CHANNEL_LABEL[c.channel];
  const name = o.name ?? (o.level === "campaign" ? "Campaign" : "Ad set");
  const channel_slug = o.platform === "meta" ? ("meta_ads" as const) : ("google_ads" as const);
  const reason =
    `${name}: ${why}, so its daily budget goes from ${usd(c.from_usd)} to ${usd(c.to_usd)} to make room for the ${label} first test ` +
    `waiting for ad budget (frees about ${usd(c.frees_usd)} of this month's budget; ${Math.round(c.step * 100)}% this time).`;
  const metaSet = o.platform === "meta" && o.level === "ad_set";
  return {
    channel_slug,
    exec_class: o.platform === "meta" ? `meta_ads.update_${metaSet ? "ad_set" : "campaign"}_budget` : "google_ads.update_campaign_budget",
    body: {
      [metaSet ? "ad_set_id" : "campaign_id"]: o.id,
      daily_budget_usd: c.to_usd,
      expected_current_daily_budget_usd: c.from_usd,
      rationale: reason.slice(0, 500),
      over_cap: false,
      ...(o.name ? { name: o.name } : {}),
      [MAKE_ROOM_TEST_KEY]: c.test_id,
      [MAKE_ROOM_REVISION_KEY]: c.test_revision,
      [MAKE_ROOM_FREES_KEY]: c.frees_usd,
    },
    reason,
    dwell_key: `cut:${o.platform}:${o.id}`,
    adds_usd: 0,
    planner: makeRoomPlanner(c, numbers),
  };
}

export function makeRoomPlanner(c: MakeRoomCut, numbers: { required_usd: number; capacity_usd: number }): PlannerNumbers {
  const s = c.object.settled;
  return {
    kind: "make_room_cut",
    required_usd: round2(numbers.required_usd),
    capacity_usd: round2(numbers.capacity_usd),
    gap_usd: round2(Math.max(0, numbers.required_usd - numbers.capacity_usd)),
    from_usd: c.from_usd,
    step: c.max_step,
    floor_usd: FLOOR_USD,
    hold_daily_usd: c.hold_daily_usd,
    base_usd: c.base_usd,
    need_daily_usd: c.need_daily_usd,
    short_usd: c.short_usd,
    days_left: c.days_left,
    margin: c.margin,
    test_id: c.test_id,
    test_revision: c.test_revision,
    cpr_usd: s && s.results > 0 ? round2(s.spend_usd / s.results) : null,
    median_cpr_usd: c.median_cpr_usd,
  };
}

export const PAGE_ROWS = 1000;
export const MAX_PAGES = 20;

export async function readAllPages<T>(label: string, page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let n = 0; n < MAX_PAGES; n++) {
    const { data, error } = await page(n * PAGE_ROWS, (n + 1) * PAGE_ROWS - 1);
    if (error) throw new Error(`${label} read failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_ROWS) return out;
  }
  throw new Error(`${label}: more than ${MAX_PAGES * PAGE_ROWS} rows, not read whole`);
}

export async function loadMakeRoomNeed(tenant_id: string, now: Date): Promise<MakeRoomNeed | null> {
  const live = (await readPendingTests(tenant_id)).filter((r) => isLivePending(r, now));
  if (live.length === 0) return null;
  const b = await readActiveAdBudget(tenant_id);
  if (!b) return null;
  const margin = budgetMargin(b);
  const tests = live
    .map((r) => ({ id: r.id, revision: r.revision, channel: r.channel_slug, daily_budget_usd: r.daily_budget_usd, hold_usd: launchHoldUsd(r.daily_budget_usd, b.days_left, margin, undefined, r.channel_slug === "tiktok_ads" ? 1.25 : 1), created_at: r.created_at }))
    .sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));
  const inflight = await readInflightMakeRoom(tenant_id, tests, now);
  return { budget_id: b.id, left_usd: b.left_usd, days_left: b.days_left, margin, tests, inflight_usd: inflight.usd, inflight: inflight.count };
}

type InflightRow = { id: string; order_key: string | null; proposed_at: string | null; status_at?: string | null; exec_claimed_at?: string | null; exec_payload: Record<string, unknown> | null; exec_status: string | null; status: string; exec_result: Record<string, unknown> | null };

export async function readInflightMakeRoom(
  tenant_id: string,
  tests: ReadonlyArray<{ id: string; revision: number }>,
  now: Date,
  self?: string,
): Promise<{ usd: number; count: number }> {
  if (tests.length === 0) return { usd: 0, count: 0 };
  const current = new Map(tests.map((t) => [t.id, t.revision]));
  const test_ids = [...current.keys()];
  const { CGO_ORDER_ORIGIN, CGO_ORDER_KEY } = await import("./cgo-ad-orders");
  const { orderDefinitelyFailed } = await import("./ad-spend-controller");
  const since = new Date(now.getTime() - IN_FLIGHT_HOURS * 3_600_000).toISOString();
  const ranSince = new Date(now.getTime() - EXECUTED_IN_FLIGHT_HOURS * 3_600_000).toISOString();
  const db = tenantClient(asTenantId(tenant_id));
  const rows = await readAllPages<InflightRow>("make-room cuts", (from, to) =>
    db
      .from("channel_actions")
      .select(`id, order_key:body->>${CGO_ORDER_KEY}, proposed_at, status_at, exec_claimed_at, exec_payload, exec_status, status, exec_result`)
      .eq(`body->>${CGO_ORDER_ORIGIN}`, "ad_spend_controller")
      .in(`exec_payload->>${MAKE_ROOM_TEST_KEY}`, [...test_ids])
      .or(`exec_status.is.null,exec_status.in.(queued,dispatching),executed_at.gte.${ranSince},proposed_at.gte.${ranSince},exec_claimed_at.gte.${ranSince},status_at.gte.${ranSince}`)
      .order("id")
      .range(from, to),
  );
  const mine = self ? rows.find((r) => r.id === self || r.order_key === self) : undefined;
  const filedBefore = (r: InflightRow) => {
    if (!mine) return true;
    const a = Date.parse(r.proposed_at ?? "");
    const b = Date.parse(mine.proposed_at ?? "");
    if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
    return a < b || (a === b && r.id < mine.id);
  };
  let sum = 0;
  let count = 0;
  for (const r of rows) {
    if (self && (r.id === self || r.order_key === self)) continue;
    if (!filedBefore(r)) continue;
    const tid = r.exec_payload?.[MAKE_ROOM_TEST_KEY];
    if (typeof tid !== "string" || r.exec_payload?.[MAKE_ROOM_REVISION_KEY] !== current.get(tid)) continue;
    if (orderDefinitelyFailed(r as Parameters<typeof orderDefinitelyFailed>[0])) continue;
    if (r.exec_status === "failed" && String(r.exec_result?.error ?? "").startsWith("cgo_not_authorized")) continue;
    if (r.exec_status === null && ["rejected", "stale", "displaced", "redone"].includes(r.status)) continue;
    if (r.exec_status === null && !["pending", "snoozed"].includes(r.status) && !((r.proposed_at ?? "") >= ranSince || (r.status_at ?? "") >= ranSince)) continue;
    const v = Number(r.exec_payload?.[MAKE_ROOM_FREES_KEY]);
    if (Number.isFinite(v) && v > 0) {
      sum += v;
      count += 1;
    }
  }
  return { usd: round2(sum), count };
}

export async function readObjectHolds(tenant_id: string, budget_id: string): Promise<Map<string, ObjectHold>> {
  const db = tenantClient(asTenantId(tenant_id));
  type Row = { platform: "meta" | "google"; object_id: string; status: string; op: string; idem_key: string; daily_delta_usd: number | string; paused: boolean | null; pause_due: boolean | null };
  const rows = await readAllPages<Row>("ad holds", (from, to) =>
    db
      .from("ad_budget_reservations")
      .select("id, platform, object_id, status, op, idem_key, daily_delta_usd, paused, pause_due")
      .eq("budget_id", budget_id)
      .in("platform", ["meta", "google"])
      .in("status", ["reserved", "committed"])
      .not("object_id", "is", null)
      .order("id")
      .range(from, to),
  );
  const by = new Map<string, { held: number; whole: boolean; skip: boolean; platform: "meta" | "google"; id: string }>();
  for (const r of rows) {
    const k = holdKeyOf(r.platform, r.object_id);
    const e = by.get(k) ?? { held: 0, whole: false, skip: false, platform: r.platform, id: r.object_id };
    if (r.status === "reserved" || r.paused === true || r.pause_due === true) e.skip = true;
    if (r.status === "committed") e.held += Number(r.daily_delta_usd) || 0;
    if (r.op === "create" || r.op === "resume" || r.idem_key.startsWith("shrink:")) e.whole = true;
    by.set(k, e);
  }
  const out = new Map<string, ObjectHold>();
  for (const [k, e] of by) {
    if (e.skip || !(e.held > 0) || !e.whole) continue;
    out.set(k, { held_daily_usd: round2(e.held), base_usd: 0 });
  }
  return out;
}

export async function makeRoomCutLive(tenant_id: string, payload: unknown, now: Date, self?: string): Promise<boolean> {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const id = p[MAKE_ROOM_TEST_KEY];
  const revision = Number(p[MAKE_ROOM_REVISION_KEY]);
  const frees = Number(p[MAKE_ROOM_FREES_KEY]);
  if (typeof id !== "string" || !id || !Number.isInteger(revision) || !(frees > 0)) return false;
  const live = (await readPendingTests(tenant_id)).filter((r) => isLivePending(r, now));
  if (!live.some((r) => r.id === id && r.revision === revision)) return false;
  const b = await readActiveAdBudget(tenant_id);
  if (!b) return false;
  const margin = budgetMargin(b);
  const reserve = live.reduce((sum, r) => sum + launchHoldUsd(r.daily_budget_usd, b.days_left, margin, undefined, r.channel_slug === "tiktok_ads" ? 1.25 : 1), 0);
  const others = await readInflightMakeRoom(tenant_id, live.map((r) => ({ id: r.id, revision: r.revision })), now, self);
  return round2(reserve - Math.max(0, b.left_usd) - others.usd) >= round2(frees) - 0.01;
}
