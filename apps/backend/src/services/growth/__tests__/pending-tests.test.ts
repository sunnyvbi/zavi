import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ rows: [] as Row[], failReads: false, nextId: 1 }));

vi.mock("@/services/tenant-client", () => {
  class Q {
    private filters: Array<[string, unknown]> = [];
    private op: "select" | "insert" | "update" = "select";
    private payload: Row = {};
    constructor(private tenant: string) {}
    select() {
      return this;
    }
    eq(k: string, v: unknown) {
      this.filters.push([k, v]);
      return this;
    }
    limit() {
      return this;
    }
    insert(r: Row) {
      this.op = "insert";
      this.payload = r;
      return this;
    }
    update(r: Row) {
      this.op = "update";
      this.payload = r;
      return this;
    }
    private match(r: Row) {
      return r.tenant_id === this.tenant && this.filters.every(([k, v]) => r[k] === v);
    }
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(res, rej);
    }
    private run() {
      if (db.failReads) return { data: null, error: { message: "db down" } };
      if (this.op === "insert") {
        if (db.rows.some((r) => r.tenant_id === this.tenant && r.channel_slug === this.payload.channel_slug)) return { data: null, error: { code: "23505", message: "dup" } };
        db.rows.push({ id: `p${db.nextId++}`, tenant_id: this.tenant, ...this.payload });
        return { data: null, error: null };
      }
      const hit = db.rows.filter((r) => this.match(r));
      if (this.op === "update") {
        for (const r of hit) Object.assign(r, this.payload);
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      return { data: hit.map((r) => ({ ...r })), error: null };
    }
  }
  return { asTenantId: (t: string) => t, tenantClient: (t: string) => ({ from: () => new Q(t) }) };
});

const budget = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock("@/services/decisions/ad-budget", async (orig) => ({
  ...(await orig<typeof import("@/services/decisions/ad-budget")>()),
  readActiveAdBudget: async () => budget.value,
}));

import {
  fitOrdersToRoom,
  isLivePending,
  keepPendingTestRoom,
  loadPendingRoom,
  pendingReserveUsd,
  pendingDailyUsd,
  readPendingTests,
  recordPendingTest,
  spareAfterPendingTests,
  type PendingRoom,
  type PendingTestRow,
} from "../pending-tests";
import { budgetShortFix } from "../pending-test-claim";

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-11T12:00:00Z");
const DAY = 86_400_000;

beforeEach(() => {
  db.rows = [];
  db.failReads = false;
  budget.value = null;
});

const tiktok = { channel: "tiktok_ads" as const, daily_budget_usd: 25, hold_usd: 525, proposal: { name: "Spring test", daily_budget_usd: 25 } };

describe("B1: a refused launch records ONE pending test per channel", () => {
  it("records it with a 7-day expiry", async () => {
    const r = await recordPendingTest(T, tiktok, NOW);
    expect(r).toEqual({ status: "recorded", expires_at: new Date(NOW.getTime() + 7 * DAY).toISOString() });
    const [row] = await readPendingTests(T);
    expect(row).toMatchObject({ channel_slug: "tiktok_ads", status: "pending", daily_budget_usd: 25, hold_usd: 525, action_id: null, revision: 1 });
  });

  it("a second refusal replaces the pending one (newest amounts and expiry), never adds a second", async () => {
    await recordPendingTest(T, tiktok, NOW);
    const later = new Date(NOW.getTime() + DAY);
    const r = await recordPendingTest(T, { ...tiktok, daily_budget_usd: 40, hold_usd: 800 }, later);
    expect(r.status).toBe("replaced");
    const rows = await readPendingTests(T);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ daily_budget_usd: 40, hold_usd: 800, revision: 2, expires_at: new Date(later.getTime() + 7 * DAY).toISOString() });
  });

  it("F2: a re-proposal keeps the test's age, so the wait (and its make-room cuts) still ends 28 days after it was first recorded", async () => {
    await recordPendingTest(T, tiktok, NOW);
    const day24 = new Date(NOW.getTime() + 24 * DAY);
    const r = await recordPendingTest(T, { ...tiktok, daily_budget_usd: 30, hold_usd: 600 }, day24);
    expect(r).toEqual({ status: "replaced", expires_at: new Date(NOW.getTime() + 28 * DAY).toISOString() });
    expect((await readPendingTests(T))[0]).toMatchObject({ created_at: NOW.toISOString(), daily_budget_usd: 30, status: "pending" });

    const day28 = new Date(NOW.getTime() + 28 * DAY);
    expect(await recordPendingTest(T, tiktok, day28)).toEqual({ status: "gave_up" });
    expect((await readPendingTests(T))[0]).toMatchObject({ status: "closed", closed_reason: "expired", created_at: NOW.toISOString() });
    db.rows = [{ ...db.rows[0], status: "pending", created_at: new Date(NOW.getTime() - 30 * DAY).toISOString() }];
    expect(await budgetShortFix({ tenant_id: T } as never, tiktok, NOW)).toMatch(/waited 28 days for ad budget room and was given up/);
  });

  it("another channel gets its own row; a claimed one (card filed, hold taken) is never replaced", async () => {
    await recordPendingTest(T, tiktok, NOW);
    await recordPendingTest(T, { ...tiktok, channel: "reddit_ads" }, NOW);
    expect(await readPendingTests(T)).toHaveLength(2);
    Object.assign(db.rows[0], { status: "claimed", action_id: "a-1", hold_idem_key: "a-1:create" });
    expect(await recordPendingTest(T, tiktok, NOW)).toEqual({ status: "claim_open", action_id: "a-1" });
    expect(db.rows[0]).toMatchObject({ status: "claimed", daily_budget_usd: 25 });
  });

  it("a pending one whose card is filed but not yet held keeps that card", async () => {
    await recordPendingTest(T, tiktok, NOW);
    db.rows[0].action_id = "a-2";
    expect(await recordPendingTest(T, { ...tiktok, daily_budget_usd: 60 }, NOW)).toEqual({ status: "claim_open", action_id: "a-2" });
  });

  it("the refusal message says Zavi makes room and files the card, and a run that writes nothing records nothing", async () => {
    const fix = await budgetShortFix({ tenant_id: T } as never, tiktok, NOW);
    expect(fix).toContain("pending TikTok test (checked weekly from 2026-10-18, kept for up to 28 days while TikTok has launched nothing)");
    expect(fix).toContain("cuts clearly worse Meta and Google ads to make that room");
    expect(fix).toContain("files this card for approval as soon as the budget has that much left");
    expect(await readPendingTests(T)).toHaveLength(1);

    db.rows = [];
    for (const ctx of [{ tenant_id: T, writes_suppressed: true }, { tenant_id: T, redo: true }, { tenant_id: T, pending_test_replay: true }]) {
      expect(await budgetShortFix(ctx as never, tiktok, NOW)).toContain("raise the ad budget");
    }
    expect(db.rows).toHaveLength(0);
  });

  it("a failed write still refuses with the old advice", async () => {
    db.failReads = true;
    expect(await budgetShortFix({ tenant_id: T } as never, tiktok, NOW)).toBe("raise the ad budget on the Growth page, or propose a smaller daily budget.");
  });
});

const row = (over: Partial<PendingTestRow> = {}): PendingTestRow => ({
  id: "p1",
  tenant_id: T,
  channel_slug: "tiktok_ads",
  status: "pending",
  daily_budget_usd: 25,
  hold_usd: 525,
  proposal: {},
  action_id: null,
  hold_idem_key: null,
  closed_reason: null,
  revision: 1,
  created_at: NOW.toISOString(),
  expires_at: new Date(NOW.getTime() + 3 * DAY).toISOString(),
  updated_at: NOW.toISOString(),
  ...over,
});

describe("the hold a pending test keeps", () => {
  it("keeps ordinary channels at 1x while TikTok reserves cent-rounded worst-day exposure", () => {
    expect(pendingDailyUsd([row({ daily_budget_usd: 20.01 }), row({ channel_slug: "reddit_ads", daily_budget_usd: 10 })], NOW)).toBe(35.02);
    const ordinary = { exec_class: "google_ads.update_budget", body: { daily_budget_usd: 25 }, adds_usd: 25 };
    const dynamic = { ...ordinary, exec_class: "tiktok_ads.create_launch", body: { daily_budget_usd: 25, budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET" } };
    expect(fitOrdersToRoom([ordinary], 600, 20, 1).kept).toEqual([ordinary]);
    expect(fitOrdersToRoom([dynamic], 600, 20, 1).dropped).toEqual([dynamic]);
  });

  it("is the launch's own math at today's days left; expired, claimed and closed tests keep nothing", () => {
    const b = { days_left: 21, margin: 1 };
    expect(pendingReserveUsd([row()], b, NOW)).toBe(656.25);
    expect(pendingReserveUsd([row(), row({ channel_slug: "reddit_ads", daily_budget_usd: 10 })], { days_left: 21, margin: 1.25 }, NOW)).toBe(1082.82);
    const expired = row({ expires_at: new Date(NOW.getTime() - 1).toISOString() });
    expect(isLivePending(expired, NOW)).toBe(false);
    expect(pendingReserveUsd([expired, row({ status: "claimed" }), row({ status: "closed" })], b, NOW)).toBe(0);
  });
});

const raise = (id: string, from: number, to: number) => ({ exec_class: "meta_ads.update_ad_set_budget", body: { ad_set_id: id, daily_budget_usd: to, expected_current_daily_budget_usd: from }, adds_usd: to - from, dwell_key: `obj:meta:${id}` });
const enable = (id: string, b: number) => ({ exec_class: "meta_ads.set_status", body: { object_id: id, status: "ACTIVE" }, adds_usd: b, dwell_key: `obj:meta:${id}` });
const copy = (id: string, b: number) => ({ exec_class: "meta_ads.duplicate_ad_set", body: { source_ad_set_id: id, daily_budget_usd: b }, adds_usd: b, dwell_key: `dup:${id}` });
const newAd = (id: string) => ({ exec_class: "meta_ads.create_ad", body: { ad_set_id: id }, adds_usd: 0, dwell_key: `creative:${id}` });
const retargetSet = () => ({ exec_class: "meta_ads.create_ad_set", body: { campaign_id: "c", daily_budget_usd: 30 }, adds_usd: 0, dwell_key: "rt:create" });
const googleRaise = (id: string, from: number, to: number) => ({ exec_class: "google_ads.update_campaign_budget", body: { campaign_id: id, daily_budget_usd: to, expected_current_daily_budget_usd: from }, adds_usd: to - from, dwell_key: `obj:google:${id}` });

describe("B3: the pace step spends nothing into a pending test's room", () => {
  it("Upcar-shaped: the cap is full of Zavi's holds and a hold upkeep just freed $600; a $525 test waits, so raises, switch-ons, copies and a new ad set wait too; a new ad (no budget) still goes", async () => {
    const room: PendingRoom = { reserve_usd: 525, daily_usd: 25, left_usd: 600, days_left: 21, margin: 1, channels: ["tiktok_ads"] };
    const orders = [raise("as1", 100, 200), enable("as2", 40), copy("as3", 50), retargetSet(), newAd("as4")];
    const r = await keepPendingTestRoom(orders, async () => room);
    expect(r.orders.map((o) => o.dwell_key)).toEqual(["creative:as4"]);
    expect(r.kept_room).toBe(true);
    expect(r.note).toContain("kept free for the pending TikTok test");
  });

  it("only what fits beside the test goes: $75 free buys a $3/day raise (21 days), not a $40 switch-on", async () => {
    const room: PendingRoom = { reserve_usd: 525, daily_usd: 25, left_usd: 600, days_left: 21, margin: 1, channels: ["tiktok_ads"] };
    const r = await keepPendingTestRoom([enable("as2", 40), raise("as1", 10, 13)], async () => room);
    expect(r.orders.map((o) => o.dwell_key)).toEqual(["obj:meta:as1"]);
  });

  it("SaaS Google-only: $2,000 left, a $525 Reddit test waits; a +$20/day raise ($420) fits, a +$60/day one ($1,260) does not", () => {
    const { kept, dropped } = fitOrdersToRoom([googleRaise("g1", 50, 70), googleRaise("g2", 100, 160)], 2000 - 525, 21, 1);
    expect(kept.map((o) => o.dwell_key)).toEqual(["obj:google:g1"]);
    expect(dropped.map((o) => o.dwell_key)).toEqual(["obj:google:g2"]);
  });

  it("no live pending test: every order goes through unchanged", async () => {
    const orders = [raise("as1", 100, 200), enable("as2", 40)];
    const r = await keepPendingTestRoom(orders, async () => null);
    expect(r).toEqual({ orders, note: null, kept_room: false });
  });

  it("pending tests that cannot be read: no order that adds daily spend this hour (fail closed)", async () => {
    const r = await keepPendingTestRoom([raise("as1", 100, 200), newAd("as4")], async () => {
      throw new Error("db down");
    });
    expect(r.orders.map((o) => o.dwell_key)).toEqual(["creative:as4"]);
    expect(r.kept_room).toBe(true);
  });

  it("cuts never come through here: an order that adds nothing is never held back", () => {
    const cut = { exec_class: "meta_ads.update_ad_set_budget", body: { daily_budget_usd: 50, expected_current_daily_budget_usd: 100 }, adds_usd: 0 };
    const pause = { exec_class: "meta_ads.set_status", body: { status: "PAUSED" }, adds_usd: 0 };
    expect(fitOrdersToRoom([cut, pause], -1000, 21, 1).kept).toEqual([cut, pause]);
  });

  it("loadPendingRoom reads the live budget only when a live pending test exists", async () => {
    expect(await loadPendingRoom(T, NOW)).toBeNull();
    db.rows.push({ ...row(), tenant_id: T });
    budget.value = { left_usd: 600, days_left: 21, margin: 1.25 };
    expect(await loadPendingRoom(T, NOW)).toEqual({ reserve_usd: 820.32, daily_usd: 31.25, left_usd: 600, days_left: 21, margin: 1.25, channels: ["tiktok_ads"] });
    db.failReads = true;
    await expect(loadPendingRoom(T, NOW)).rejects.toThrow("db down");
  });
});

describe("B3 for cgo: spare daily capacity", () => {
  const room = (over: Partial<PendingRoom> = {}): PendingRoom => ({ reserve_usd: 525, daily_usd: 25, left_usd: 5000, days_left: 21, margin: 1, channels: ["tiktok_ads"], ...over });

  it("sets the live pending tests' daily budgets aside; no pending test leaves it; unreadable is 0; no budget stays null", async () => {
    expect(await spareAfterPendingTests(100, T, NOW, async () => room({ daily_usd: 35 }))).toBe(65);
    expect(await spareAfterPendingTests(20, T, NOW, async () => room())).toBe(0);
    expect(await spareAfterPendingTests(100, T, NOW, async () => null)).toBe(100);
    expect(await spareAfterPendingTests(100, T, NOW, async () => { throw new Error("down"); })).toBe(0);
    expect(await spareAfterPendingTests(null, T, NOW, async () => room())).toBeNull();
  });

  it("a forecast-based spare never exceeds what fits in left_usd beside the tests' holds: $600 left, $525 kept = $75 over 21 days", async () => {
    expect(await spareAfterPendingTests(100, T, NOW, async () => room({ left_usd: 600 }))).toBe(3.57);
    expect(await spareAfterPendingTests(100, T, NOW, async () => room({ left_usd: 400 }))).toBe(0);
  });
});
