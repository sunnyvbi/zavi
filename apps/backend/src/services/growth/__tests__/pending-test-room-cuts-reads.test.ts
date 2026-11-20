import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  pending: [] as Array<Record<string, unknown>>,
  budget: null as null | Record<string, unknown>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock("../pending-tests", async (orig) => ({
  ...(await orig<typeof import("../pending-tests")>()),
  readPendingTests: async () => m.pending,
}));
vi.mock("@/services/decisions/ad-budget", async (orig) => ({
  ...(await orig<typeof import("@/services/decisions/ad-budget")>()),
  readActiveAdBudget: async () => m.budget,
}));
vi.mock("@/services/tenant-client", () => {
  class Q {
    private rows: Array<Record<string, unknown>>;
    private from = 0;
    private to = Infinity;
    private lim = Infinity;
    constructor(table: string) {
      this.rows = [...(m.tables[table] ?? [])];
    }
    select() {
      return this;
    }
    eq(k: string, v: unknown) {
      this.rows = this.rows.filter((r) => r[k] === v);
      return this;
    }
    in(k: string, vs: unknown[]) {
      this.rows = this.rows.filter((r) => vs.includes(r[k]));
      return this;
    }
    not() {
      return this;
    }
    gte(k: string, v: string) {
      this.rows = this.rows.filter((r) => typeof r[k] === "string" && (r[k] as string) >= v);
      return this;
    }
    or(expr: string) {
      const terms = expr.match(/[^,(]+(\([^)]*\))?/g) ?? [];
      const test = (r: Record<string, unknown>, t: string) => {
        const [k, op, ...rest] = t.split(".");
        const v = rest.join(".");
        if (op === "is" && v === "null") return r[k] === null || r[k] === undefined;
        if (op === "in") return v.replace(/[()]/g, "").split(",").includes(String(r[k]));
        if (op === "gte") return typeof r[k] === "string" && (r[k] as string) >= v;
        throw new Error(`fake or(): ${t}`);
      };
      this.rows = this.rows.filter((r) => terms.some((t) => test(r, t)));
      return this;
    }
    order(k: string) {
      this.rows.sort((a, b) => String(a[k]).localeCompare(String(b[k])));
      return this;
    }
    range(from: number, to: number) {
      this.from = from;
      this.to = to;
      return this;
    }
    limit(n: number) {
      this.lim = n;
      return this;
    }
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      const end = Math.min(this.to + 1, this.from + this.lim, this.from + 1000);
      return Promise.resolve({ data: this.rows.slice(this.from, end), error: null }).then(res, rej);
    }
  }
  return { asTenantId: (t: string) => t, tenantClient: () => ({ from: (t: string) => new Q(t) }) };
});

import { MAKE_ROOM_FREES_KEY, MAKE_ROOM_REVISION_KEY, MAKE_ROOM_TEST_KEY, holdKeyOf, makeRoomCutLive, readInflightMakeRoom, readObjectHolds } from "../pending-test-room-cuts";
import { orderDefinitelyFailed } from "../ad-spend-controller";
import { evaluateUnattended, type AdObjectFacts, type UnattendedFacts } from "../unattended-policy";

const T = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-10-12T12:00:00Z");
const TEST = "9b0c2d4e-1f3a-4b5c-8d7e-6f5a4b3c2d1e";

const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: TEST,
  tenant_id: T,
  channel_slug: "tiktok_ads",
  status: "pending",
  daily_budget_usd: 100,
  hold_usd: 2000,
  revision: 1,
  action_id: null,
  created_at: "2026-10-10T00:00:00Z",
  expires_at: "2026-10-17T00:00:00Z",
  ...over,
});
const budget = (left_usd: number) => ({ id: "b1", left_usd, days_left: 20, margin: 1 });
const cutPayload = (over: Record<string, unknown> = {}) => ({
  ad_set_id: "123456789012345",
  daily_budget_usd: 320,
  expected_current_daily_budget_usd: 400,
  over_cap: false,
  rationale: "",
  [MAKE_ROOM_TEST_KEY]: TEST,
  [MAKE_ROOM_REVISION_KEY]: 1,
  [MAKE_ROOM_FREES_KEY]: 1600,
  ...over,
});

beforeEach(() => {
  m.pending = [];
  m.budget = null;
  m.tables = {};
});

describe("F1: a make-room cut runs only for the test it was planned for", () => {
  it("planned for a $2,000 hold, still live, same revision, still short: valid", async () => {
    m.pending = [pendingRow()];
    m.budget = budget(100);
    await expect(makeRoomCutLive(T, cutPayload(), NOW)).resolves.toBe(true);
  });

  it("must not catch: the test was replaced by a $100 one (same id, revision 2): stale", async () => {
    m.pending = [pendingRow({ revision: 2, daily_budget_usd: 5, hold_usd: 100 })];
    m.budget = budget(100);
    await expect(makeRoomCutLive(T, cutPayload(), NOW)).resolves.toBe(false);
  });

  it("must not catch: same revision but no longer short by what the cut frees: stale", async () => {
    m.pending = [pendingRow()];
    m.budget = budget(2000);
    await expect(makeRoomCutLive(T, cutPayload(), NOW)).resolves.toBe(false);
  });

  it("a payload without the revision is stale", async () => {
    m.pending = [pendingRow()];
    m.budget = budget(100);
    const p = cutPayload();
    delete (p as Record<string, unknown>)[MAKE_ROOM_REVISION_KEY];
    await expect(makeRoomCutLive(T, p, NOW)).resolves.toBe(false);
  });

  it("the gate refuses a stale (or unverifiable) make-room cut even on a settled ad set; a valid one passes", () => {
    const settled: AdObjectFacts = { id: "123456789012345", conversionObjective: true, objective: "OFFSITE_CONVERSIONS", learning: false, daysSinceEdit: 30, lockDays: 7, spend7dUsd: 400, conversions7d: 5, targetCpaUsd: null, conversionEvent: "PURCHASE", conversionEventFiring: true };
    const action = { kind: "ad" as const, exec_class: "meta_ads.update_ad_set_budget", payload: cutPayload(), source: { table: "channel_actions" as const, id: "k", run_id: null } };
    const facts = (makeRoomCut: boolean | null): UnattendedFacts => ({ refsResolved: true, openAdvice: "clear", goal: { present: false }, objects: [settled], trackingOk: true, founderSetBudget: false, makeRoomCut });
    expect(evaluateUnattended(action, facts(false))).toMatchObject({ verdict: "deny", reasons: ["make_room_test_changed"] });
    expect(evaluateUnattended(action, facts(null))).toMatchObject({ verdict: "deny", reasons: ["make_room_unverified"] });
    expect(evaluateUnattended(action, facts(true)).verdict).toBe("allow");
  });
});

describe("F3: the hold mirror reads every page", () => {
  it("1,500 hold rows on one object: all of them count, not the first 1,000", async () => {
    m.tables.ad_budget_reservations = Array.from({ length: 1500 }, (_, i) => ({
      id: String(i).padStart(5, "0"),
      budget_id: "b1",
      platform: "meta",
      object_id: "big",
      status: "committed",
      op: "create",
      idem_key: `k${i}`,
      daily_delta_usd: 1,
      paused: false,
      pause_due: false,
    }));
    const holds = await readObjectHolds(T, "b1");
    expect(holds.get(holdKeyOf("meta", "big"))).toEqual({ held_daily_usd: 1500, base_usd: 0 });
  });

  it("a hold in flight on page two keeps the object out (the sync skips it)", async () => {
    m.tables.ad_budget_reservations = Array.from({ length: 1001 }, (_, i) => ({
      id: String(i).padStart(5, "0"),
      budget_id: "b1",
      platform: "meta",
      object_id: "busy",
      status: i === 1000 ? "reserved" : "committed",
      op: "raise",
      idem_key: `k${i}`,
      daily_delta_usd: 1,
      paused: false,
      pause_due: false,
    }));
    const holds = await readObjectHolds(T, "b1");
    expect(holds.has(holdKeyOf("meta", "busy"))).toBe(false);
  });

  it("must catch: a raise-only object is left out, whatever Zavi's change history says", async () => {
    m.tables.ad_budget_reservations = [{ id: "1", budget_id: "b1", platform: "google", object_id: "77", status: "committed", op: "raise", idem_key: "r1", daily_delta_usd: 50, paused: false, pause_due: false }];
    m.tables.ad_object_changes = [{ id: "c1", platform: "google", object_id: "77", source: "zavi", change_kind: "budget", before_daily_usd: 150 }];
    const holds = await readObjectHolds(T, "b1");
    expect(holds.has(holdKeyOf("google", "77"))).toBe(false);
  });

  it("must catch: a rebased object (one live:... rebase row) is left out", async () => {
    m.tables.ad_budget_reservations = [{ id: "1", budget_id: "b1", platform: "meta", object_id: "88", status: "committed", op: "rebase", idem_key: "live:meta:88:2026-10-12:80:1", daily_delta_usd: 80, paused: false, pause_due: false }];
    const holds = await readObjectHolds(T, "b1");
    expect(holds.has(holdKeyOf("meta", "88"))).toBe(false);
  });

  it("an object Zavi created and later raised: base 0 (the create row is a lineage leaf), whole hold counts", async () => {
    m.tables.ad_budget_reservations = [
      { id: "1", budget_id: "b1", platform: "meta", object_id: "99", status: "committed", op: "create", idem_key: "c1", daily_delta_usd: 100, paused: false, pause_due: false },
      { id: "2", budget_id: "b1", platform: "meta", object_id: "99", status: "committed", op: "raise", idem_key: "r1", daily_delta_usd: 50, paused: false, pause_due: false },
    ];
    m.tables.ad_object_changes = [{ id: "c1", platform: "meta", object_id: "99", source: "zavi", change_kind: "budget", before_daily_usd: 100 }];
    const holds = await readObjectHolds(T, "b1");
    expect(holds.get(holdKeyOf("meta", "99"))).toEqual({ held_daily_usd: 150, base_usd: 0 });
  });
});

const cutCard = (id: string, frees: number, over: { revision?: number; exec_status?: string | null; status?: string; error?: string; proposed_at?: string; executed_at?: string | null } = {}) => ({
  id,
  proposed_at: over.proposed_at ?? "2026-10-12T11:41:00Z",
  executed_at: over.executed_at ?? null,
  order_key: `key-${id}`,
  "body->>cgo_order_origin": "ad_spend_controller",
  [`exec_payload->>${MAKE_ROOM_TEST_KEY}`]: TEST,
  exec_payload: { [MAKE_ROOM_TEST_KEY]: TEST, [MAKE_ROOM_REVISION_KEY]: over.revision ?? 1, [MAKE_ROOM_FREES_KEY]: frees },
  exec_status: over.exec_status === undefined ? "queued" : over.exec_status,
  status: over.status ?? "acted",
  exec_result: over.error ? { error: over.error } : null,
});

describe("N2/F1: two cuts sized for one shortfall: never both, and never neither", () => {
  const A = () => cutCard("A", 400, { proposed_at: "2026-10-12T11:41:01Z" });
  const B = () => cutCard("B", 400, { proposed_at: "2026-10-12T11:41:02Z" });
  const judge = (self: string) => makeRoomCutLive(T, cutPayload({ [MAKE_ROOM_FREES_KEY]: 400 }), NOW, self);

  it("$800 short: both fit, both pass", async () => {
    m.pending = [pendingRow()];
    m.budget = budget(1200);
    m.tables.channel_actions = [A(), B()];
    await expect(judge("A")).resolves.toBe(true);
    await expect(judge("key-B")).resolves.toBe(true);
  });

  it("must catch: new room shrank the shortfall to $500: exactly the first filed passes, whichever executor checks first", async () => {
    m.pending = [pendingRow()];
    m.budget = budget(2000);
    for (const order of [["A", "B"], ["B", "A"]]) {
      m.tables.channel_actions = [A(), B()];
      const verdicts: Record<string, boolean> = {};
      for (const who of order) verdicts[who] = await judge(who);
      expect(verdicts).toEqual({ A: true, B: false });
    }
  });

  it("the controller's submit (card not filed yet) counts every cut already filed", async () => {
    m.pending = [pendingRow()];
    m.budget = budget(2000);
    m.tables.channel_actions = [A()];
    await expect(judge("key-not-filed-yet")).resolves.toBe(false);
  });

  it("must catch: the refused sibling leaves no cut dwell, so its object is planned again next hour", () => {
    const refused = { body: { cgo_dwell_key: "cut:meta:b" }, exec_status: "failed", status: "pending", exec_result: { error: "cgo_not_authorized: Autopilot may not make this kind of change on its own (make_room_test_changed). Nothing in the account changed." } };
    expect(orderDefinitelyFailed(refused)).toBe(true);
    expect(orderDefinitelyFailed({ ...refused, exec_result: { error: "cgo_not_authorized: Autopilot may not make this kind of change on its own (class_not_on_unattended_list)." } })).toBe(false);
  });
});

describe("N3: in-flight room counts only cuts for the test's current revision", () => {
  it("a queued cut for revision 1 does not hold back planning for revision 2", async () => {
    m.tables.channel_actions = [cutCard("old", 1600, { revision: 1 }), cutCard("new", 100, { revision: 2 })];
    await expect(readInflightMakeRoom(T, [{ id: TEST, revision: 2 }], NOW)).resolves.toEqual({ usd: 100, count: 1 });
  });
});

describe("F2: in-flight room lasts until the cut has run and been read", () => {
  it("must catch: a cut filed 5h ago and still queued keeps its room", async () => {
    m.tables.channel_actions = [cutCard("Q", 400, { proposed_at: "2026-10-12T07:00:00Z", exec_status: "queued" })];
    expect(await readInflightMakeRoom(T, [{ id: TEST, revision: 1 }], NOW)).toEqual({ usd: 400, count: 1 });
  });

  it("must catch: a cut filed 5h ago that ran 1h ago keeps its room", async () => {
    m.tables.channel_actions = [cutCard("R", 400, { proposed_at: "2026-10-12T07:00:00Z", exec_status: "executed", executed_at: "2026-10-12T11:00:00Z" })];
    expect(await readInflightMakeRoom(T, [{ id: TEST, revision: 1 }], NOW)).toEqual({ usd: 400, count: 1 });
  });

  it("must catch: a cut that ran 6h ago keeps its room (reconciles may have failed since, so its hold may still be up)", async () => {
    m.tables.channel_actions = [cutCard("P", 400, { proposed_at: "2026-10-12T05:00:00Z", exec_status: "executed", executed_at: "2026-10-12T06:00:00Z" })];
    expect(await readInflightMakeRoom(T, [{ id: TEST, revision: 1 }], NOW)).toEqual({ usd: 400, count: 1 });
  });

  it("a cut that ran more than a day ago no longer counts", async () => {
    m.tables.channel_actions = [cutCard("S", 400, { proposed_at: "2026-10-11T09:00:00Z", exec_status: "executed", executed_at: "2026-10-11T10:00:00Z" })];
    expect(await readInflightMakeRoom(T, [{ id: TEST, revision: 1 }], NOW)).toEqual({ usd: 0, count: 0 });
  });

  it("must catch: a cut whose run may have landed (interrupted, no executed_at) filed 6h ago keeps its room", async () => {
    m.tables.channel_actions = [{ ...cutCard("I", 400, { proposed_at: "2026-10-12T06:00:00Z", exec_status: "failed" }), exec_result: { interrupted: true } }];
    expect(await readInflightMakeRoom(T, [{ id: TEST, revision: 1 }], NOW)).toEqual({ usd: 400, count: 1 });
  });

  it("must catch: a card the founder marked done without Zavi running it stops reserving room after a day", async () => {
    m.tables.channel_actions = [cutCard("D", 400, { proposed_at: "2026-10-11T09:00:00Z", exec_status: null, status: "acted" })];
    expect(await readInflightMakeRoom(T, [{ id: TEST, revision: 1 }], NOW)).toEqual({ usd: 0, count: 0 });
  });

  it("a card still waiting for approval keeps its room however old", async () => {
    m.tables.channel_actions = [cutCard("W", 400, { proposed_at: "2026-10-10T09:00:00Z", exec_status: null, status: "pending" })];
    expect(await readInflightMakeRoom(T, [{ id: TEST, revision: 1 }], NOW)).toEqual({ usd: 400, count: 1 });
  });

  it("must catch: a card filed 3 days ago, claimed for a run 2h ago and interrupted, keeps its room", async () => {
    m.tables.channel_actions = [{ ...cutCard("L", 400, { proposed_at: "2026-10-09T09:00:00Z", exec_status: "failed" }), exec_claimed_at: "2026-10-12T10:00:00Z", exec_result: { lease_expired: true } }];
    expect(await readInflightMakeRoom(T, [{ id: TEST, revision: 1 }], NOW)).toEqual({ usd: 400, count: 1 });
  });

  it("must catch: a card filed 3 days ago that the founder marked done 2h ago keeps its room for now", async () => {
    m.tables.channel_actions = [{ ...cutCard("M", 400, { proposed_at: "2026-10-09T09:00:00Z", exec_status: null, status: "acted" }), status_at: "2026-10-12T10:00:00Z" }];
    expect(await readInflightMakeRoom(T, [{ id: TEST, revision: 1 }], NOW)).toEqual({ usd: 400, count: 1 });
  });
});
