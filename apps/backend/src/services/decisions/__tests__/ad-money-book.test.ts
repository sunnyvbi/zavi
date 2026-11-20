import { describe, it, expect } from "vitest";
import {
  advanceMemory,
  compareShadowVerdicts,
  monthSnapshot,
  objectCounts,
  shadowVerdict,
  type BookHold,
  type BookObject,
  type BookSpend,
  type ShadowContext,
  type SnapshotInput,
} from "../ad-money-book";

const NOW = new Date("2026-10-12T12:00:00Z");
const READ_STARTED = "2026-10-12T11:50:00Z";
const TODAY = "2026-10-12";
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const BUDGET = { budget_id: "b1", month_start: "2026-10-01", month_cap_usd: 10000, spent_usd: 2000, creator_held_usd: 0, creator_spent_usd: 0, days_left: 20, margin: 1 };

function obj(o: Partial<BookObject> & Pick<BookObject, "object_id">): BookObject {
  return { platform: "meta", account_id: "act_1", level: "ad_set", campaign_id: `c-${o.object_id}`, name: null, budget_kind: "daily", budget_usd: null, status: "ACTIVE", ...o };
}
function delivers(object_id: string, perDay: number, o: Partial<BookSpend> = {}): BookSpend[] {
  return ["2026-10-09", "2026-10-10", "2026-10-11"].map((spend_date) => ({ platform: "meta", account_id: "act_1", object_id, spend_date, amount_usd: perDay, ...o }));
}
function hold(h: Partial<BookHold> & Pick<BookHold, "id">): BookHold {
  return { idem_key: `${h.id}:raise`, platform: "meta", object_id: null, status: "committed", paused: false, daily_delta_usd: 0, created_at: hoursAgo(120), updated_at: hoursAgo(120), ...h };
}
function input(over: Partial<SnapshotInput>): SnapshotInput {
  return {
    budget: BUDGET,
    objects: [],
    spend: [],
    changes: [],
    holds: [],
    accounts: [{ platform: "meta", account_id: "act_1", today: TODAY }],
    unread_platforms: [],
    read_started_at: READ_STARTED,
    now: NOW,
    ...over,
  };
}
const row = (s: ReturnType<typeof monthSnapshot>, object_id: string) => s.objects.find((o) => o.object_id === object_id);

describe("a hold left higher than the live budget holds no money (the motivating case)", () => {
  const stale = input({
    objects: [obj({ object_id: "as1", budget_usd: 150 })],
    spend: delivers("as1", 160),
    changes: [{ platform: "meta", object_id: "as1", occurred_at: hoursAgo(30) }],
    holds: [hold({ id: "h1", object_id: "as1", daily_delta_usd: 300 })],
  });

  it("counts the object at its live budget, not at the stale hold", () => {
    const s = monthSnapshot(stale);
    expect(row(s, "as1")).toMatchObject({ live_budget_usd: 150, expected_daily_usd: 150, ceiling_daily_usd: 150, basis: "budget_cap" });
    expect(s.totals.expected_rest).toBe(3000);
    expect(s.totals.open_authorizations).toBe(0);
    expect(s.reflected_hold_ids).toEqual(["h1"]);
  });

  it("frees exactly the phantom amount the old gate still holds", () => {
    const s = monthSnapshot(stale);
    const oldGateLeft = BUDGET.month_cap_usd - BUDGET.spent_usd - 300 * BUDGET.days_left;
    expect(oldGateLeft).toBe(2000);
    expect(s.totals.expected_room).toBe(5000);
    expect(s.totals.expected_room - oldGateLeft).toBe((300 - 150) * BUDGET.days_left);
  });

  it("the real gate refuses for the month; the shadow would allow", () => {
    const s = monthSnapshot(stale);
    const ctx: ShadowContext = {
      view: { id: "b1", status: "active", month_start: "2026-10-01", month_cap_usd: 10000, spent_usd: 2000, held_usd: 6000, creator_held_usd: 0, creator_spent_usd: 0, days_left: 20, margin: 1 },
      snapshot: { budget_id: "b1", month_start: "2026-10-01", generation: 7, read_started_at: READ_STARTED, totals: s.totals, reflected_hold_ids: s.reflected_hold_ids },
      open_holds: stale.holds,
    };
    const v = shadowVerdict(ctx, { idem_key: "d9:raise", platform: "meta", op: "raise", object_id: "as2", daily_delta_usd: 120, paused: false }, { status: "refused", reason: "over_month", amount_usd: 2400 }, NOW);
    expect(v).toMatchObject({
      real_verdict: "refused", real_reason: "over_month", real_room_usd: 2000,
      shadow_verdict: "would_allow", shadow_change_usd: 2400, shadow_open_auth_usd: 0, shadow_expected_room_usd: 5000,
      snapshot_generation: 7, snapshot_age_s: 600,
    });
    expect(compareShadowVerdicts([v!])).toMatchObject({ total: 1, agree: 0, real_refused_shadow_allows: 1, real_held_shadow_refuses: 0 });
  });
});

describe("what counts", () => {
  it("an object Zavi never touched counts at what it delivers", () => {
    const s = monthSnapshot(input({ objects: [obj({ object_id: "base", budget_usd: 110 })], spend: delivers("base", 91) }));
    expect(row(s, "base")).toMatchObject({ expected_daily_usd: 91, ceiling_daily_usd: 110, basis: "trailing_delivery" });
    expect(s.totals.expected_rest).toBe(1820);
    expect(s.totals.ceiling_rest).toBe(2200);
  });

  it("a change in the last 24 hours, by Zavi or outside, counts the object at its full live budget", () => {
    const s = monthSnapshot(
      input({
        objects: [obj({ object_id: "zavi", budget_usd: 200 }), obj({ object_id: "outside", budget_usd: 80 }), obj({ object_id: "quiet", budget_usd: 80 })],
        spend: [...delivers("zavi", 20), ...delivers("outside", 10), ...delivers("quiet", 10)],
        holds: [hold({ id: "h2", object_id: "zavi", daily_delta_usd: 100, created_at: hoursAgo(2), updated_at: hoursAgo(2) })],
        changes: [{ platform: "meta", object_id: "outside", occurred_at: hoursAgo(3) }],
      }),
    );
    expect(row(s, "zavi")).toMatchObject({ expected_daily_usd: 200, basis: "changed_24h_full_budget" });
    expect(row(s, "outside")).toMatchObject({ expected_daily_usd: 80, basis: "changed_24h_full_budget" });
    expect(row(s, "quiet")).toMatchObject({ expected_daily_usd: 10, basis: "trailing_delivery" });
    expect(s.totals.open_authorizations).toBe(0);
  });

  it("a lifetime budget counts what is left of it once, never times the days left", () => {
    const fresh = monthSnapshot(input({ objects: [obj({ object_id: "life", budget_kind: "lifetime", budget_usd: 100 })] }));
    expect(row(fresh, "life")).toMatchObject({ expected_daily_usd: 0, ceiling_daily_usd: 0, exposure_usd: 100, basis: "lifetime_remaining" });
    expect(fresh.totals).toMatchObject({ fixed_exposure: 100, expected_rest: 100, ceiling_rest: 100 });
    const partSpent = monthSnapshot(input({ objects: [obj({ object_id: "life", budget_kind: "lifetime", budget_usd: 100 })], lifetime_spend: { "meta:act_1:life": 30 } }));
    expect(partSpent.totals.expected_rest).toBe(70);
  });

  it("a campaign budget shared by its ad sets is counted once", () => {
    const sets = ["a", "b", "c"].map((id) => obj({ object_id: id, campaign_id: "camp", budget_kind: "campaign_level", budget_usd: null, campaign_budget_usd: 40 }));
    const s = monthSnapshot(input({ objects: sets, spend: [...delivers("a", 10), ...delivers("b", 8), ...delivers("c", 5)] }));
    expect(s.objects).toHaveLength(1);
    expect(s.objects[0]).toMatchObject({ object_id: "camp", live_budget_usd: 40, expected_daily_usd: 23, ceiling_daily_usd: 40 });
    expect(s.totals.ceiling_daily).toBe(40);
  });

  it("a campaign row that carries the budget is counted once, with nothing added for the ad groups under it", () => {
    const tiktok = { platform: "tiktok", account_id: "adv1" };
    const s = monthSnapshot(
      input({
        accounts: [{ ...tiktok, today: TODAY }],
        objects: [
          obj({ ...tiktok, object_id: "camp", level: "campaign", campaign_id: "camp", budget_usd: 60 }),
          obj({ ...tiktok, object_id: "g1", level: "ad_group", campaign_id: "camp", budget_kind: "campaign_level" }),
          obj({ ...tiktok, object_id: "g2", level: "ad_group", campaign_id: "camp", budget_kind: "campaign_level" }),
        ],
        spend: delivers("camp", 50, tiktok),
      }),
    );
    expect(s.objects).toHaveLength(1);
    expect(s.objects[0]).toMatchObject({ platform: "tiktok", object_id: "camp", expected_daily_usd: 50, ceiling_daily_usd: 60 });
  });

  it("a campaign that is off counts nothing under it", () => {
    const tiktok = { platform: "tiktok", account_id: "adv1" };
    const s = monthSnapshot(
      input({
        accounts: [{ ...tiktok, today: TODAY }],
        objects: [
          obj({ ...tiktok, object_id: "camp", level: "campaign", campaign_id: "camp", budget_usd: 60, status: "PAUSED" }),
          obj({ ...tiktok, object_id: "g1", level: "ad_group", campaign_id: "camp", budget_kind: "campaign_level" }),
        ],
        spend: delivers("camp", 50, tiktok),
      }),
    );
    expect(s.objects).toEqual([]);
    expect(s.totals.expected_rest).toBe(0);
  });

  it("an unknown status counts (fail closed); paused and removed count 0", () => {
    const s = monthSnapshot(
      input({
        accounts: [{ platform: "meta", account_id: "act_1", today: TODAY }, { platform: "snapchat", account_id: "s1", today: TODAY }],
        objects: [
          obj({ object_id: "odd", budget_usd: 50, status: "WITH_ISSUES" }),
          obj({ object_id: "nostatus", platform: "snapchat", account_id: "s1", budget_usd: 30, status: null }),
          obj({ object_id: "paused", budget_usd: 500, status: "PAUSED" }),
          obj({ object_id: "gone", budget_usd: 500, status: "removed" }),
        ],
        spend: [...delivers("odd", 20), ...delivers("nostatus", 30, { platform: "snapchat", account_id: "s1" }), ...delivers("paused", 400), ...delivers("gone", 400)],
      }),
    );
    expect(row(s, "odd")).toMatchObject({ expected_daily_usd: 20, ceiling_daily_usd: 50, basis: "trailing_delivery+unknown_status" });
    expect(row(s, "nostatus")).toMatchObject({ expected_daily_usd: 30, ceiling_daily_usd: 30 });
    expect(row(s, "paused")).toBeUndefined();
    expect(row(s, "gone")).toBeUndefined();
    expect(s.totals).toMatchObject({ expected_daily: 50, ceiling_daily: 80, objects_total: 4, objects_counted: 2 });
    expect(objectCounts({ platform: "meta", status: "ACTIVE" })).toEqual({ counts: true, known: true });
    expect(objectCounts({ platform: "chatgpt", status: "ENDED" })).toEqual({ counts: false, known: true });
  });

  it("a prepaid platform counts its full daily budget, never its trailing delivery", () => {
    const chatgpt = { platform: "chatgpt", account_id: "chatgpt:t" };
    const s = monthSnapshot(input({ accounts: [{ ...chatgpt, today: TODAY }], objects: [obj({ ...chatgpt, object_id: "cg", level: "campaign", campaign_id: "cg", budget_usd: 25 })] }));
    expect(row(s, "cg")).toMatchObject({ expected_daily_usd: 25, ceiling_daily_usd: 25, basis: "prepaid_full_budget" });
  });

  it("spend reported per account, on no object, counts at most the room the running budgets leave", () => {
    const x = { platform: "x", account_id: "acc" };
    const base = { accounts: [{ ...x, today: TODAY }], spend: delivers("account_acc", 70, x) };
    const on = monthSnapshot(input({ ...base, objects: [obj({ ...x, object_id: "xc", level: "campaign", campaign_id: "xc", budget_usd: 50 })] }));
    expect(on.totals).toMatchObject({ expected_daily: 50, ceiling_daily: 50 });
    const off = monthSnapshot(input({ ...base, objects: [obj({ ...x, object_id: "xc", level: "campaign", campaign_id: "xc", budget_usd: 50, status: "PAUSED" })] }));
    expect(off.totals.expected_daily).toBe(0);
  });

  it("an account this hour's read did not cover counts nothing; an unread platform counts its last known rows", () => {
    const objects = [obj({ object_id: "old", account_id: "act_old", budget_usd: 90 }), obj({ object_id: "g", platform: "google", account_id: "9", level: "campaign", campaign_id: "g", budget_usd: 40, status: "ENABLED" })];
    const spend = [...delivers("old", 90, { account_id: "act_old" }), ...delivers("g", 40, { platform: "google", account_id: "9" })];
    const s = monthSnapshot(input({ objects, spend, unread_platforms: ["google"] }));
    expect(row(s, "old")).toBeUndefined();
    expect(row(s, "g")).toMatchObject({ expected_daily_usd: 40 });
    expect(s.complete_platforms).toEqual(["meta"]);
    expect(s.unread_platforms).toEqual(["google"]);
  });

  it("creator hires and open authorizations come off the room; spent, cap and days are the month view's", () => {
    const s = monthSnapshot(
      input({
        budget: { ...BUDGET, creator_held_usd: 300, creator_spent_usd: 200 },
        objects: [obj({ object_id: "as1", budget_usd: 100 }), obj({ object_id: "g", platform: "google", account_id: "9", budget_usd: 10, status: "ENABLED" })],
        spend: delivers("as1", 100),
        unread_platforms: ["google"],
        holds: [
          hold({ id: "inflight", object_id: "as1", status: "reserved", daily_delta_usd: 10 }),
          hold({ id: "late", object_id: "as1", daily_delta_usd: 5, updated_at: "2026-10-12T11:55:00Z" }),
          hold({ id: "noobject", daily_delta_usd: 4 }),
          hold({ id: "unread", platform: "google", object_id: "g", daily_delta_usd: 3 }),
          hold({ id: "paused", object_id: "new", daily_delta_usd: 50, paused: true }),
          hold({ id: "shown", object_id: "as1", daily_delta_usd: 999 }),
        ],
      }),
    );
    expect(s.reflected_hold_ids).toEqual(["shown"]);
    expect(s.totals.open_authorizations).toBe((10 + 5 + 4 + 3) * 20 + 50);
    expect(s.totals.creator_committed).toBe(500);
    expect(s.totals.expected_rest).toBe(2000);
    expect(s.totals.expected_room).toBe(10000 - 2000 - 500 - 2000 - 490);
  });
});

describe("what the last snapshot remembered (changes the outside-Zavi log does not record)", () => {
  const TEN_DAYS = { ...BUDGET, month_cap_usd: 1200, spent_usd: 0, days_left: 10 };
  const view = { id: "b1", status: "active", month_start: "2026-10-01", month_cap_usd: 1200, spent_usd: 0, held_usd: 0, creator_held_usd: 0, creator_spent_usd: 0, days_left: 10, margin: 1 };
  const ctxOf = (s: ReturnType<typeof monthSnapshot>): ShadowContext => ({
    view,
    snapshot: { budget_id: "b1", month_start: "2026-10-01", generation: 2, read_started_at: READ_STARTED, totals: s.totals, reflected_hold_ids: [] },
    open_holds: [],
  });
  const raise50 = { idem_key: "d1:raise", platform: "meta", op: "raise" as const, object_id: "other", daily_delta_usd: 50, paused: false };
  const refused = { status: "refused" as const, reason: "over_month", amount_usd: 500 };
  const accounts = [{ platform: "meta", account_id: "act_1", today: TODAY }];
  const remember = (objects: BookObject[], now = new Date(NOW.getTime() - 3_600_000)) => advanceMemory(null, { objects, accounts, unread_platforms: [], now }).memory;

  it("an active $100/day ad first seen this hour, made outside Zavi, counts at its full budget: $1,000 over ten days, so a $50/day raise does not fit $1,200", () => {
    const old = obj({ object_id: "old", budget_usd: 20, status: "PAUSED" });
    const fresh = obj({ object_id: "new1", budget_usd: 100 });
    const blind = monthSnapshot(input({ budget: TEN_DAYS, objects: [old, fresh] }));
    expect(blind.totals.expected_rest).toBe(0);

    const { memory, changes } = advanceMemory(remember([old]), { objects: [old, fresh], accounts, unread_platforms: [], now: NOW });
    expect(changes).toEqual([{ platform: "meta", object_id: "new1", campaign_id: "c-new1", occurred_at: NOW.toISOString() }]);
    const s = monthSnapshot(input({ budget: TEN_DAYS, objects: [old, fresh], changes }));
    expect(row(s, "new1")).toMatchObject({ expected_daily_usd: 100, basis: "changed_24h_full_budget" });
    expect(s.totals).toMatchObject({ expected_rest: 1000, expected_room: 200 });
    expect(shadowVerdict(ctxOf(s), raise50, refused, NOW)).toMatchObject({ shadow_verdict: "would_refuse", shadow_change_usd: 500, shadow_expected_room_usd: 200 });

    const later = (h: number) => advanceMemory(memory, { objects: [old, fresh], accounts, unread_platforms: [], now: new Date(NOW.getTime() + h * 3_600_000) });
    expect(later(23).changes).toHaveLength(1);
    expect(later(25).changes).toEqual([]);
    expect(later(25).memory.accounts["meta:act_1"].new1).toEqual({ s: memory.accounts["meta:act_1"].new1.s });
  });

  it("a campaign budget raised outside Zavi from $50 to $500 a day counts at $500, not at the $10 it delivers", () => {
    const sets = (campaign_budget_usd: number) => ["a", "b"].map((id) => obj({ object_id: id, campaign_id: "camp", budget_kind: "campaign_level", budget_usd: null, campaign_budget_usd }));
    const spend = [...delivers("a", 6), ...delivers("b", 4)];
    const blind = monthSnapshot(input({ budget: TEN_DAYS, objects: sets(500), spend }));
    expect(blind.objects[0]).toMatchObject({ expected_daily_usd: 10, ceiling_daily_usd: 500 });

    const { changes } = advanceMemory(remember(sets(50)), { objects: sets(500), accounts, unread_platforms: [], now: NOW });
    expect(changes.map((c) => c.object_id).sort()).toEqual(["a", "b"]);
    const s = monthSnapshot(input({ budget: TEN_DAYS, objects: sets(500), spend, changes }));
    expect(s.objects).toHaveLength(1);
    expect(s.objects[0]).toMatchObject({ object_id: "camp", live_budget_usd: 500, expected_daily_usd: 500, basis: "campaign_budget:changed_24h_full_budget" });
    expect(shadowVerdict(ctxOf(s), raise50, refused, NOW)).toMatchObject({ shadow_verdict: "would_refuse" });
    expect(advanceMemory(remember(sets(500)), { objects: sets(500), accounts, unread_platforms: [], now: NOW }).changes).toEqual([]);
  });

  it("a campaign budget whose amount the ledger does not carry (a $1,000 lifetime campaign budget, $30 delivered in three days) gives no verdict, never a confident number", () => {
    const sets = ["a", "b"].map((id) => obj({ object_id: id, campaign_id: "camp", budget_kind: "campaign_level", budget_usd: null, campaign_budget_usd: null }));
    const s = monthSnapshot(input({ budget: { ...TEN_DAYS, days_left: 5 }, objects: sets, spend: [...delivers("a", 6), ...delivers("b", 4)] }));
    expect(s.objects[0]).toMatchObject({ object_id: "camp", live_budget_usd: null, expected_daily_usd: 10, basis: "campaign_budget:unknown_amount_trailing_delivery_only" });
    expect(s.totals).toMatchObject({ expected_rest: 50, unknown_budgets: 1 });
    expect(shadowVerdict(ctxOf(s), raise50, refused, NOW)).toMatchObject({ shadow_verdict: "no_snapshot", shadow_note: "unknown_campaign_budget", shadow_expected_room_usd: null });
    const off = monthSnapshot(input({ budget: TEN_DAYS, objects: sets.map((o) => ({ ...o, status: "CAMPAIGN_PAUSED" })) }));
    expect(off.totals.unknown_budgets).toBe(0);
    expect(monthSnapshot(input({ objects: sets.map((o) => ({ ...o, campaign_budget_usd: 40 })) })).totals.unknown_budgets).toBe(0);
  });

  it("the first snapshot of an account marks nothing new; an account not read this hour keeps its memory; a switch back on is a change", () => {
    const a = obj({ object_id: "a", budget_usd: 30 });
    const first = advanceMemory(null, { objects: [a], accounts, unread_platforms: [], now: NOW });
    expect(first.changes).toEqual([]);
    expect(first.memory).toEqual({ v: 1, accounts: { "meta:act_1": { a: { s: "daily|3000||1" } } } });
    const two = advanceMemory(first.memory, { objects: [a, obj({ object_id: "g", platform: "google", account_id: "9", budget_usd: 5, status: "ENABLED" })], accounts: [...accounts, { platform: "google", account_id: "9", today: TODAY }], unread_platforms: [], now: NOW });
    expect(two.changes).toEqual([]);
    const marked = { v: 1 as const, accounts: { "meta:act_1": { a: { s: "daily|3000||1", t: hoursAgo(2) } } } };
    const unread = advanceMemory(marked, { objects: [obj({ object_id: "zzz", budget_usd: 1 })], accounts, unread_platforms: ["meta"], now: NOW });
    expect(unread.memory.accounts["meta:act_1"]).toEqual({ a: { s: "daily|3000||1", t: hoursAgo(2) } });
    expect(unread.changes).toEqual([{ platform: "meta", object_id: "a", occurred_at: hoursAgo(2) }]);
    const paused = advanceMemory(first.memory, { objects: [{ ...a, status: "PAUSED" }], accounts, unread_platforms: [], now: new Date(NOW.getTime() - 48 * 3_600_000) });
    expect(advanceMemory(paused.memory, { objects: [a], accounts, unread_platforms: [], now: NOW }).changes).toHaveLength(1);
    expect(advanceMemory({ v: 9, accounts: "x" }, { objects: [a], accounts, unread_platforms: [], now: NOW }).changes).toEqual([]);
  });
});

describe("shadowVerdict", () => {
  const view = { id: "b1", status: "active", month_start: "2026-10-01", month_cap_usd: 1000, spent_usd: 100, held_usd: 200, creator_held_usd: 0, creator_spent_usd: 50, days_left: 10, margin: 1 };
  const snapshot = { budget_id: "b1", month_start: "2026-10-01", generation: 3, read_started_at: READ_STARTED, totals: { expected_rest: 400, ceiling_rest: 700 }, reflected_hold_ids: ["old"] };
  const raise = (daily: number) => ({ idem_key: "d1:raise", platform: "meta", op: "raise" as const, object_id: "as1", daily_delta_usd: daily, paused: false });
  const held = { status: "held" as const, amount_usd: 100 };

  it("no snapshot, a stale one, another month's or another budget's all answer no_snapshot", () => {
    expect(shadowVerdict({ view, snapshot: null, open_holds: [] }, raise(10), held, NOW)).toMatchObject({ shadow_verdict: "no_snapshot", shadow_note: "missing", shadow_expected_room_usd: null });
    const old = { ...snapshot, read_started_at: hoursAgo(3.1) };
    expect(shadowVerdict({ view, snapshot: old, open_holds: [] }, raise(10), held, NOW)).toMatchObject({ shadow_verdict: "no_snapshot", shadow_note: "stale" });
    expect(shadowVerdict({ view, snapshot: { ...snapshot, month_start: "2026-09-01" }, open_holds: [] }, raise(10), held, NOW)).toMatchObject({ shadow_note: "other_month" });
    expect(shadowVerdict({ view, snapshot: { ...snapshot, budget_id: "b0" }, open_holds: [] }, raise(10), held, NOW)).toMatchObject({ shadow_note: "other_budget" });
    expect(shadowVerdict({ view, snapshot, open_holds: [], open_holds_truncated: true }, raise(10), held, NOW)).toMatchObject({ shadow_note: "holds_truncated" });
  });

  it("no active budget: nothing to compare", () => {
    expect(shadowVerdict({ view: null, snapshot: null, open_holds: [] }, raise(10), held, NOW)).toBeNull();
    expect(shadowVerdict({ view: { ...view, status: "stopped" }, snapshot, open_holds: [] }, raise(10), held, NOW)).toBeNull();
  });

  it("expected rest + open authorizations not in the snapshot + creator + this change <= cap - spent", () => {
    const open_holds = [
      hold({ id: "old", object_id: "as1", daily_delta_usd: 500 }),
      hold({ id: "new", object_id: "as9", daily_delta_usd: 20, updated_at: "2026-10-12T11:58:00Z" }),
      hold({ id: "mine", idem_key: "d1:raise", object_id: "as1", status: "reserved", daily_delta_usd: 10 }),
    ];
    const fits = shadowVerdict({ view, snapshot, open_holds }, raise(25), held, NOW)!;
    expect(fits).toMatchObject({ shadow_verdict: "would_allow", shadow_change_usd: 250, shadow_open_auth_usd: 200, shadow_expected_room_usd: 250, shadow_ceiling_room_usd: -50 });
    const over = shadowVerdict({ view, snapshot, open_holds }, raise(25.01), held, NOW)!;
    expect(over).toMatchObject({ shadow_verdict: "would_refuse", shadow_change_usd: 250.1 });
    expect(fits.real_room_usd).toBe(1000 - 100 - 200 - 50 + 100);
  });

  it("a change that adds no daily spend always passes; a paused create counts one day", () => {
    const full = { ...snapshot, totals: { expected_rest: 5000, ceiling_rest: 5000 } };
    expect(shadowVerdict({ view, snapshot: full, open_holds: [] }, raise(0), held, NOW)).toMatchObject({ shadow_verdict: "would_allow", shadow_change_usd: 0 });
    const create = { idem_key: "d2:create", platform: "meta", op: "create" as const, object_id: null, daily_delta_usd: 30, paused: true };
    expect(shadowVerdict({ view, snapshot, open_holds: [] }, create, held, NOW)).toMatchObject({ shadow_change_usd: 30 });
  });

  it("values a change like the hold the gate stores for it (2x on the platforms the gate doubles)", () => {
    const cg = { idem_key: "d3:raise", platform: "chatgpt", op: "raise" as const, object_id: "cg", daily_delta_usd: 10, paused: false };
    expect(shadowVerdict({ view, snapshot, open_holds: [] }, cg, held, NOW)).toMatchObject({ shadow_change_usd: 200 });
  });
});

describe("compareShadowVerdicts", () => {
  it("counts agreement only where both answers are about the month's room", () => {
    const base = { budget_id: "b1", idem_key: "k", platform: "meta", op: "raise", object_id: "o", daily_delta_usd: 1, real_reason: null, real_amount_usd: 1, real_room_usd: 1, shadow_note: null, shadow_change_usd: 1, shadow_open_auth_usd: 0, shadow_expected_room_usd: 1, shadow_ceiling_room_usd: 1, snapshot_generation: 1, snapshot_age_s: 1 };
    const c = compareShadowVerdicts([
      { ...base, real_verdict: "held", shadow_verdict: "would_allow" },
      { ...base, real_verdict: "refused", real_reason: "over_month", shadow_verdict: "would_refuse" },
      { ...base, real_verdict: "held", shadow_verdict: "would_refuse" },
      { ...base, real_verdict: "refused", real_reason: "over_month", shadow_verdict: "would_allow" },
      { ...base, real_verdict: "refused", real_reason: "platform_unread", shadow_verdict: "would_allow" },
      { ...base, real_verdict: "already_held", shadow_verdict: "would_allow" },
      { ...base, real_verdict: "held", shadow_verdict: "no_snapshot" },
    ]);
    expect(c).toMatchObject({ total: 7, agree: 2, real_held_shadow_refuses: 1, real_refused_shadow_allows: 1, not_comparable: 2, no_snapshot: 1 });
    expect(c.disagreements).toHaveLength(2);
  });
});
