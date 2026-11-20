import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  failTable: {} as Record<string, string>,
  pages: {} as Record<string, number>,
  rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  answers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let ordered = false;
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
        gte: (c: string, v: unknown) => (filters.push((r) => String(r[c]) >= String(v)), q),
        order: () => ((ordered = true), q),
        maybeSingle: async () =>
          db.failTable[table] ? { data: null, error: { message: db.failTable[table] } } : { data: (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null },
        range: async (from: number, to: number) => {
          db.pages[table] = (db.pages[table] ?? 0) + 1;
          if (db.failTable[table]) return { data: null, error: { message: db.failTable[table] } };
          if (!ordered) throw new Error(`${table}: paged without an order`);
          const rows = (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          return { data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null };
        },
      };
      return q;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      db.rpc.push({ name, args });
      const answer = db.answers[name];
      if (!answer) return { data: null, error: { message: `unexpected rpc ${name}` } };
      const out = answer(args);
      if (out instanceof Error) return { data: null, error: { message: out.message } };
      return { data: out, error: null };
    },
  }),
}));

import { BOOK_MAX_PAGES, loadSnapshotInput, readAllPages, readShadowComparison, recordShadowVerdict, storeMonthSnapshot } from "../ad-money-book-store";
import { overProjectionGate, reserveAdSpend } from "../ad-budget";
import { moneyBookShadowEnabled } from "../ad-money-book-flag";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-12T12:00:00Z");
const READ_STARTED = new Date("2026-10-12T11:50:00Z");
const BUDGET = { budget_id: "b1", month_start: "2026-10-01", month_cap_usd: 10000, spent_usd: 2000, creator_held_usd: 0, creator_spent_usd: 0, days_left: 20, margin: 1 };
const VIEW = {
  id: "b1", status: "active", monthly_usd: 10000, month_cap_usd: 10000, spent_usd: 2000, held_usd: 6000, left_usd: 2000,
  creator_held_usd: 0, creator_spent_usd: 0, daily_limit_usd: null, days_left: 20, days_in_month: 31, margin: 1,
  started_on: "2026-09-01", created_at: "2026-09-01T00:00:00Z", stopped_at: null, month_start: "2026-10-01", next_month_start: "2026-11-01",
};
const ACCOUNTS = [{ platform: "meta", account_id: "act_1", today: "2026-10-12" }];
const id = (n: number) => String(n).padStart(8, "0");

function campaign(n: number, over: Row = {}): Row {
  return { id: id(n), tenant_id: T, platform: "meta", account_id: "act_1", object_id: `as${n}`, level: "ad_set", campaign_id: `c${n}`, name: null, budget_kind: "daily", budget_usd: 1, campaign_budget_usd: null, status: "ACTIVE", ...over };
}

beforeEach(() => {
  db.tables = {};
  db.failTable = {};
  db.pages = {};
  db.rpc = [];
  db.answers = {};
});
afterEach(() => {
  delete process.env.AD_MONEY_BOOK_SHADOW;
  vi.restoreAllMocks();
});

describe("the ledger is read whole, page by page", () => {
  it("reads every one of more than 1,000 ledger rows, and only this tenant's", async () => {
    db.tables.ad_campaigns = [
      ...Array.from({ length: 2500 }, (_, n) => campaign(n, { budget_usd: 2 })),
      campaign(9001, { tenant_id: OTHER, budget_usd: 999 }),
    ];
    db.tables.ad_spend_daily = Array.from({ length: 2500 }, (_, n) => ({ id: id(n), tenant_id: T, platform: "meta", account_id: "act_1", object_id: `as${n}`, spend_date: "2026-10-11", amount_usd: 3 }));
    const input = await loadSnapshotInput({ tenant_id: T, budget: BUDGET, accounts: ACCOUNTS, unread_platforms: [], read_started_at: READ_STARTED, now: NOW });
    expect(input.objects).toHaveLength(2500);
    expect(input.spend).toHaveLength(2500);
    expect(db.pages.ad_campaigns).toBe(3);
    expect(db.pages.ad_spend_daily).toBe(3);
  });

  it("a page that fails throws; nothing partial is returned", async () => {
    db.tables.ad_campaigns = [campaign(1)];
    db.failTable.ad_spend_daily = "ledger down";
    await expect(loadSnapshotInput({ tenant_id: T, budget: BUDGET, accounts: ACCOUNTS, unread_platforms: [], read_started_at: READ_STARTED, now: NOW })).rejects.toThrow(/ad_spend_daily read failed: ledger down/);
  });

  it("a list that never ends throws at the page cap", async () => {
    let calls = 0;
    const full = Array.from({ length: 1000 }, () => ({}));
    await expect(readAllPages("endless", async () => ({ data: (calls++, full), error: null }))).rejects.toThrow(/larger than one snapshot covers/);
    expect(calls).toBe(BOOK_MAX_PAGES);
  });

  it("a lifetime budget gets all the spend the ledger has for it, not only the last days", async () => {
    db.tables.ad_campaigns = [campaign(1, { budget_kind: "lifetime", budget_usd: 500 }), campaign(2)];
    db.tables.ad_spend_daily = [
      { id: id(1), tenant_id: T, platform: "meta", account_id: "act_1", object_id: "as1", spend_date: "2026-08-03", amount_usd: 120 },
      { id: id(2), tenant_id: T, platform: "meta", account_id: "act_1", object_id: "as1", spend_date: "2026-10-11", amount_usd: 30 },
      { id: id(3), tenant_id: T, platform: "meta", account_id: "act_1", object_id: "as1", spend_date: "2026-10-11", amount_usd: 25, source: "manual" },
      { id: id(4), tenant_id: T, platform: "meta", account_id: "act_1", object_id: "as2", spend_date: "2026-08-03", amount_usd: 77 },
    ];
    const input = await loadSnapshotInput({ tenant_id: T, budget: BUDGET, accounts: ACCOUNTS, unread_platforms: [], read_started_at: READ_STARTED, now: NOW });
    expect(input.lifetime_spend).toEqual({ "meta:act_1:as1": 150 });
    expect(input.spend.map((s) => s.spend_date).sort()).toEqual(["2026-10-11", "2026-10-11"]);
  });
});

describe("storeMonthSnapshot", () => {
  it("stores the snapshot of the tenant's active budget through the RPC", async () => {
    db.answers.ad_budget_month_view = () => VIEW;
    db.answers.record_ad_budget_snapshot = () => ({ status: "stored", generation: 4 });
    db.tables.ad_campaigns = [campaign(1, { budget_usd: 150 })];
    db.tables.ad_spend_daily = ["2026-10-09", "2026-10-10", "2026-10-11"].map((spend_date, n) => ({ id: id(n), tenant_id: T, platform: "meta", account_id: "act_1", object_id: "as1", spend_date, amount_usd: 160 }));
    db.tables.ad_budget_reservations = [
      { id: "h1", tenant_id: T, budget_id: "b1", idem_key: "d0:raise", platform: "meta", object_id: "as1", status: "committed", paused: false, daily_delta_usd: 300, created_at: "2026-10-07T12:00:00Z", updated_at: "2026-10-07T12:00:00Z" },
      { id: "h0", tenant_id: T, budget_id: "b1", idem_key: "dx:raise", platform: "meta", object_id: "as1", status: "released", paused: false, daily_delta_usd: 999, created_at: "2026-10-07T12:00:00Z", updated_at: "2026-10-07T12:00:00Z" },
    ];
    const out = await storeMonthSnapshot({ tenant_id: T, budget_id: "b1", accounts: ACCOUNTS, unread_platforms: ["google"], read_started_at: READ_STARTED, now: NOW });
    expect(out).toMatchObject({ status: "stored", generation: 4 });
    const call = db.rpc.find((c) => c.name === "record_ad_budget_snapshot")!;
    expect(call.args).toMatchObject({
      p_tenant_id: T, p_budget_id: "b1", p_month_start: "2026-10-01", p_read_started_at: READ_STARTED.toISOString(),
      p_complete_platforms: ["meta"], p_unread_platforms: ["google"], p_reflected_hold_ids: ["h1"],
    });
    expect(call.args.p_totals).toMatchObject({ spent: 2000, expected_rest: 3000, expected_room: 5000, open_authorizations: 0 });
    expect(call.args.p_objects).toEqual([expect.objectContaining({ platform: "meta", account_id: "act_1", object_id: "as1", live_budget_usd: 150, expected_daily_usd: 150, ceiling_daily_usd: 150 })]);
    expect(call.args.p_memory).toEqual({ v: 1, accounts: { "meta:act_1": { as1: { s: "daily|15000||1" } } } });
  });

  it("an ad first seen since the last snapshot counts at its full budget, and the memory is stored for the next one", async () => {
    db.answers.ad_budget_month_view = () => VIEW;
    db.answers.record_ad_budget_snapshot = () => ({ status: "stored", generation: 5 });
    db.tables.ad_campaigns = [campaign(1, { budget_usd: 150 }), campaign(2, { budget_usd: 100 })];
    db.tables.ad_budget_snapshots = [
      { tenant_id: T, budget_id: "b1", memory: { v: 1, accounts: { "meta:act_1": { as1: { s: "daily|15000||1" } } } } },
      { tenant_id: OTHER, budget_id: "b1", memory: { v: 1, accounts: { "meta:act_1": { as1: { s: "daily|15000||1" }, as2: { s: "daily|10000||1" } } } } },
    ];
    await storeMonthSnapshot({ tenant_id: T, budget_id: "b1", accounts: ACCOUNTS, unread_platforms: [], read_started_at: READ_STARTED, now: NOW });
    const call = db.rpc.find((c) => c.name === "record_ad_budget_snapshot")!;
    expect(call.args.p_totals).toMatchObject({ expected_rest: 2000, unknown_budgets: 0 });
    expect(call.args.p_memory).toEqual({ v: 1, accounts: { "meta:act_1": { as1: { s: "daily|15000||1" }, as2: { s: "daily|10000||1", t: NOW.toISOString() } } } });
  });

  it("an unreadable last snapshot stores nothing this hour", async () => {
    db.answers.ad_budget_month_view = () => VIEW;
    db.failTable.ad_budget_snapshots = "down";
    await expect(storeMonthSnapshot({ tenant_id: T, budget_id: "b1", accounts: ACCOUNTS, unread_platforms: [], read_started_at: READ_STARTED, now: NOW })).rejects.toThrow(/ad_budget_snapshots read failed: down/);
    expect(db.rpc.map((c) => c.name)).toEqual(["ad_budget_month_view"]);
  });

  it("skips when the budget is not the tenant's active one; throws when the write fails", async () => {
    db.answers.ad_budget_month_view = () => ({ ...VIEW, id: "b2" });
    expect(await storeMonthSnapshot({ tenant_id: T, budget_id: "b1", accounts: ACCOUNTS, unread_platforms: [], read_started_at: READ_STARTED, now: NOW })).toEqual({ status: "skipped", reason: "other_budget" });
    db.answers.ad_budget_month_view = () => VIEW;
    db.answers.record_ad_budget_snapshot = () => new Error("denied");
    await expect(storeMonthSnapshot({ tenant_id: T, budget_id: "b1", accounts: ACCOUNTS, unread_platforms: [], read_started_at: READ_STARTED, now: NOW })).rejects.toThrow(/record_ad_budget_snapshot failed: denied/);
  });
});

describe("the shadow verdict never changes the reserve", () => {
  const D = { id: "dec-1", tenant_id: T };
  const RAISE = { platform: "meta" as const, op: "raise" as const, object_id: "as2", daily_delta_usd: 120 };
  const context = (snapshot: unknown) => ({
    view: VIEW,
    snapshot,
    open_holds: [{ id: "h1", idem_key: "d0:raise", platform: "meta", object_id: "as1", status: "committed", paused: false, daily_delta_usd: 300, created_at: "2026-10-07T12:00:00Z", updated_at: "2026-10-07T12:00:00Z" }],
    open_holds_truncated: false,
  });
  const fresh = () => ({ budget_id: "b1", month_start: "2026-10-01", generation: 7, read_started_at: new Date(Date.now() - 600_000).toISOString(), totals: { expected_rest: 3000, ceiling_rest: 3000 }, reflected_hold_ids: ["h1"] });
  const stored = () => db.rpc.filter((c) => c.name === "record_ad_budget_shadow_verdict").map((c) => c.args.p_row as Row);
  const names = () => db.rpc.map((c) => c.name);

  beforeEach(() => {
    db.answers.reserve_ad_spend = () => ({ status: "refused", reason: "over_month", amount_usd: 2400 });
    db.answers.ad_budget_shadow_context = () => context(fresh());
    db.answers.record_ad_budget_shadow_verdict = () => ({ status: "recorded" });
  });

  it("is off under vitest unless a test turns it on, off when set to 0, on otherwise", () => {
    expect(moneyBookShadowEnabled({ VITEST: "true" })).toBe(false);
    expect(moneyBookShadowEnabled({ VITEST: "true", AD_MONEY_BOOK_SHADOW: "1" })).toBe(true);
    expect(moneyBookShadowEnabled({})).toBe(true);
    expect(moneyBookShadowEnabled({ AD_MONEY_BOOK_SHADOW: "0" })).toBe(false);
  });

  it("real 'refused over_month' next to shadow 'would_allow'; the answer is byte-identical with and without the shadow path", async () => {
    const without = await reserveAdSpend(D, RAISE);
    expect(names()).toEqual(["reserve_ad_spend"]);

    process.env.AD_MONEY_BOOK_SHADOW = "1";
    db.rpc = [];
    const withShadow = await reserveAdSpend(D, RAISE);
    expect(JSON.stringify(withShadow)).toBe(JSON.stringify(without));
    expect(withShadow).toEqual({ status: "refused", error: "cap_refuse: ad_budget_over_month" });
    await vi.waitFor(() => expect(stored()).toHaveLength(1));
    expect(names()).toEqual(["reserve_ad_spend", "ad_budget_shadow_context", "record_ad_budget_shadow_verdict"]);
    expect(stored()[0]).toMatchObject({
      budget_id: "b1", idem_key: "dec-1:raise", platform: "meta", op: "raise", object_id: "as2", daily_delta_usd: 120,
      real_verdict: "refused", real_reason: "over_month", real_room_usd: 2000,
      shadow_verdict: "would_allow", shadow_change_usd: 2400, shadow_expected_room_usd: 5000, snapshot_generation: 7,
    });
    expect(db.rpc[2].args.p_tenant_id).toBe(T);
  });

  it("no snapshot, or one older than 3 hours, records 'no_snapshot'", async () => {
    process.env.AD_MONEY_BOOK_SHADOW = "1";
    db.answers.ad_budget_shadow_context = () => context(null);
    await reserveAdSpend(D, RAISE);
    await vi.waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()[0]).toMatchObject({ shadow_verdict: "no_snapshot", shadow_note: "missing", real_verdict: "refused" });

    db.answers.ad_budget_shadow_context = () => context({ ...fresh(), read_started_at: new Date(Date.now() - 4 * 3_600_000).toISOString() });
    await reserveAdSpend(D, RAISE);
    await vi.waitFor(() => expect(stored()).toHaveLength(2));
    expect(stored()[1]).toMatchObject({ shadow_verdict: "no_snapshot", shadow_note: "stale" });
  });

  it("a held answer is returned untouched when the shadow read or the shadow write fails", async () => {
    db.answers.reserve_ad_spend = () => ({ status: "held", reason: null, amount_usd: 2400, month_cap_usd: 10000 });
    const gate = vi.spyOn(overProjectionGate, "read").mockResolvedValue(null);
    const without = await reserveAdSpend(D, RAISE);
    expect(without).toEqual({ status: "held", tenant_id: T, idem_key: "dec-1:raise", fresh: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.AD_MONEY_BOOK_SHADOW = "1";

    db.answers.record_ad_budget_shadow_verdict = () => new Error("insert denied");
    expect(JSON.stringify(await reserveAdSpend(D, RAISE))).toBe(JSON.stringify(without));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringMatching(/shadow verdict for dec-1:raise not stored.*insert denied/)));

    db.answers.ad_budget_shadow_context = () => new Error("read denied");
    expect(JSON.stringify(await reserveAdSpend(D, RAISE))).toBe(JSON.stringify(without));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/shadow check skipped.*read denied/));

    db.answers.ad_budget_shadow_context = () => ({ view: { id: 7 }, snapshot: null, open_holds: [] });
    expect(JSON.stringify(await reserveAdSpend(D, RAISE))).toBe(JSON.stringify(without));
    gate.mockRestore();
  });

  it("nothing is compared when the gate gave no verdict (no budget, an RPC error, an unknown answer)", async () => {
    process.env.AD_MONEY_BOOK_SHADOW = "1";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const answer of [{ status: "no_budget" }, new Error("down"), { status: "mystery" }]) {
      db.rpc = [];
      db.answers.reserve_ad_spend = () => answer;
      await reserveAdSpend(D, RAISE);
      expect(names()).toEqual(["reserve_ad_spend"]);
    }
  });

  it("recordShadowVerdict returns the row and a write that never rejects", async () => {
    db.answers.record_ad_budget_shadow_verdict = () => new Error("nope");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await recordShadowVerdict({ tenant_id: T, change: { idem_key: "k:raise", platform: "meta", op: "raise", object_id: "as2", daily_delta_usd: 300, paused: false }, real: { status: "held", amount_usd: 6000 }, now: new Date() });
    expect(r.row).toMatchObject({ shadow_verdict: "would_refuse", shadow_change_usd: 6000, shadow_expected_room_usd: 5000 });
    await expect(r.written).resolves.toBeUndefined();
  });
});

describe("readShadowComparison", () => {
  it("counts one tenant's verdicts since a date", async () => {
    const base = { tenant_id: T, budget_id: "b1", idem_key: "k", platform: "meta", op: "raise", object_id: "o", daily_delta_usd: 1, real_reason: null, real_amount_usd: 1, real_room_usd: 1, shadow_note: null, shadow_change_usd: 1, shadow_open_auth_usd: 0, shadow_expected_room_usd: 9, shadow_ceiling_room_usd: 1, snapshot_generation: 1, snapshot_age_s: 1 };
    db.tables.ad_budget_shadow_verdicts = [
      { ...base, id: id(1), created_at: "2026-10-12T10:00:00.000Z", real_verdict: "held", shadow_verdict: "would_allow" },
      { ...base, id: id(2), created_at: "2026-10-12T11:00:00.000Z", real_verdict: "refused", real_reason: "over_month", shadow_verdict: "would_allow" },
      { ...base, id: id(3), created_at: "2026-10-01T11:00:00.000Z", real_verdict: "held", shadow_verdict: "would_refuse" },
      { ...base, id: id(4), tenant_id: OTHER, created_at: "2026-10-12T11:00:00.000Z", real_verdict: "held", shadow_verdict: "would_refuse" },
    ];
    const c = await readShadowComparison(T, new Date("2026-10-12T00:00:00Z"));
    expect(c).toMatchObject({ total: 2, agree: 1, real_refused_shadow_allows: 1, real_held_shadow_refuses: 0 });
    expect(c.disagreements[0]).toMatchObject({ real_reason: "over_month", shadow_expected_room_usd: 9 });
  });
});
