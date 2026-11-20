import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

function query(tid: string, table: string) {
  let rows = (tables[table] ?? []).filter((r) => r.tenant_id === tid);
  const at = (r: Row, c: string) => {
    const [col, key] = c.split("->>");
    const v = r[col!];
    return key ? (v as Record<string, unknown> | null)?.[key] : v;
  };
  const b = {
    select: () => b,
    eq(c: string, v: unknown) {
      rows = rows.filter((r) => at(r, c) === v);
      return b;
    },
    in(c: string, vs: unknown[]) {
      rows = rows.filter((r) => vs.includes(at(r, c)));
      return b;
    },
    gte(c: string, v: string) {
      rows = rows.filter((r) => String(at(r, c) ?? "") >= v);
      return b;
    },
    or(expr: string) {
      const ids = [...expr.matchAll(/([\w>-]+)\.(eq|gte)\.([^,)]+)/g)].map((m) => [m[1]!, m[2]!, m[3]!] as const);
      rows = rows.filter((r) => ids.some(([c, op, v]) => (op === "eq" ? at(r, c) === v : String(at(r, c) ?? "") >= v)));
      return b;
    },
    not: () => b,
    is: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    then(res: (v: { data: Row[] | null; error: null }) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(res);
    },
  };
  return b;
}

vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({ from: (t: string) => query(tid, t) }),
  tenantRpc: async () => ({ data: null, error: { message: "no rpc in this test" } }),
}));
vi.mock("../channel-autorun", async (orig) => ({ ...(await orig<typeof import("../channel-autorun")>()), readEffectiveAutorun: async () => true }));
vi.mock("@/services/tools/meta-ads/_client", () => ({
  fbGet: async () => {
    throw new Error("no Meta in this test");
  },
}));

import { evaluateUnattended, heldReasonWords, loadUnattendedFacts, type UnattendedAction, type UnattendedFacts } from "../unattended-policy";
import { blockingFounderEvent, founderSetBudgetReason, founderSetBudgetWords } from "../founder-set-budget";

const T = "11111111-1111-4111-8111-111111111111";
const AS = "120258729006520059";
const NOW = new Date("2026-10-22T16:00:00Z");
const move = (from: number, to: number): UnattendedAction => ({
  kind: "ad",
  exec_class: "meta_ads.update_ad_set_budget_review",
  payload: { ad_set_id: AS, daily_budget_usd: to, expected_current_daily_budget_usd: from, over_cap: false, name: "Rent a car" },
  source: { table: "channel_actions", id: "act-new", run_id: null },
});
const raise = move(149, 178.8);
const cut = move(149, 120);
const approvedZaviRaise = (over: Row = {}): Row => ({
  id: "be941965",
  tenant_id: T,
  exec_class: "meta_ads.update_ad_set_budget_review",
  exec_status: "executed",
  executed_at: "2026-10-20T05:06:41Z",
  proposed_at: "2026-10-19T22:00:00Z",
  approved_by: "user-owner",
  approved_by_source: null,
  edited_body: null,
  exec_payload: { ad_set_id: AS, daily_budget_usd: 149, expected_current_daily_budget_usd: 120 },
  ...over,
});
const outsideEdit = (occurred_at: string): Row => ({ tenant_id: T, platform: "meta", object_id: AS, source: "outside", change_kind: "budget", occurred_at });
const settled: NonNullable<UnattendedFacts["objects"]>[number] = { id: AS, conversionObjective: true, objective: null, learning: false, daysSinceEdit: 30, lockDays: 7, spend7dUsd: 100, conversions7d: 3, targetCpaUsd: null };

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.tenant_users = [{ tenant_id: T, user_id: "user-owner", role: "owner" }];
});

describe("D2: an owner's approval of a Zavi-proposed card holds only the opposite direction", () => {
  it("a same-direction raise is not held; a cut is, and the line names the approval and its date", async () => {
    tables.channel_actions = [approvedZaviRaise()];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).founderSetBudget).toBe(false);
    const f = await loadUnattendedFacts(T, cut, { now: NOW });
    expect(f.founderSetBudget).toBe(true);
    expect(f.founderSetBudgetEvent).toMatchObject({ source: "approved", direction: "up" });
    const v = evaluateUnattended(cut, { ...f, objects: [settled], goal: { present: false }, openAdvice: "clear", refsResolved: true, trackingOk: true });
    expect(v.verdict).toBe("ask_founder");
    expect(heldReasonWords(v.reasons)).toContain("you approved raising its budget on Oct 20, so I don't cut it on my own");
  });

  it("an approved Zavi cut holds a raise, not a further cut", async () => {
    tables.channel_actions = [approvedZaviRaise({ exec_payload: { ad_set_id: AS, daily_budget_usd: 100, expected_current_daily_budget_usd: 149 } })];
    expect((await loadUnattendedFacts(T, move(100, 120), { now: NOW })).founderSetBudget).toBe(true);
    expect((await loadUnattendedFacts(T, move(100, 90), { now: NOW })).founderSetBudget).toBe(false);
  });
});

describe("D2: founder-started and founder-edited cards hold every move", () => {
  it("a card whose amount the founder edited before approving holds even a same-direction raise", async () => {
    tables.channel_actions = [approvedZaviRaise({ edited_body: { ad_set_id: AS, daily_budget_usd: 140, expected_current_daily_budget_usd: 120 } })];
    const f = await loadUnattendedFacts(T, raise, { now: NOW });
    expect(f.founderSetBudget).toBe(true);
    expect(f.founderSetBudgetEvent?.source).toBe("edited");
  });

  it("an edit that kept the amount is a plain approval", async () => {
    tables.channel_actions = [approvedZaviRaise({ edited_body: { ad_set_id: AS, daily_budget_usd: 149, expected_current_daily_budget_usd: 120, name: "renamed" } })];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).founderSetBudget).toBe(false);
  });

  it("a founder chat order holds a same-direction raise, and the line says chat", async () => {
    tables.channel_actions = [approvedZaviRaise({ exec_payload: { ad_set_id: AS, daily_budget_usd: 149, expected_current_daily_budget_usd: 120, founder_chat_order: true } })];
    const f = await loadUnattendedFacts(T, raise, { now: NOW });
    expect(f.founderSetBudget).toBe(true);
    expect(f.founderSetBudgetEvent).toMatchObject({ source: "ordered", via: "chat" });
    const v = evaluateUnattended(raise, { ...f, objects: [settled], goal: { present: false }, openAdvice: "clear", refsResolved: true, trackingOk: true });
    expect(heldReasonWords(v.reasons)).toContain("you set its budget in chat on Oct 20");
  });

  it("a user-initiated origin on the decisions rail counts as the founder's own", async () => {
    tables.decisions = [
      { tenant_id: T, decision_class: "meta_ads.update_ad_set_budget", status: "acted", approved_by: "user-owner", approved_by_source: null, approved_at: "2026-10-18T00:00:00Z", body: { ad_set_id: AS, daily_budget_usd: 149, expected_current_daily_budget_usd: 120, origin: "user_initiated_ledger" } },
    ];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).founderSetBudgetEvent).toMatchObject({ source: "ordered", via: "zavi" });
  });
});

describe("D2: an outside edit, and which event is newest", () => {
  it("an outside edit holds every move, named with its date", async () => {
    tables.ad_object_changes = [outsideEdit("2026-10-11T18:00:00Z")];
    const f = await loadUnattendedFacts(T, raise, { now: NOW });
    expect(f.founderSetBudget).toBe(true);
    const v = evaluateUnattended(raise, { ...f, objects: [settled], goal: { present: false }, openAdvice: "clear", refsResolved: true, trackingOk: true });
    expect(heldReasonWords(v.reasons)).toContain("you changed its budget in Ads Manager on Oct 11");
  });

  it("the incident: an Oct 11 outside edit, then the Oct 20 approved Zavi raise: a raise goes on, a cut is held on the approval", async () => {
    tables.ad_object_changes = [outsideEdit("2026-10-11T18:00:00Z")];
    tables.channel_actions = [approvedZaviRaise()];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).founderSetBudget).toBe(false);
    expect((await loadUnattendedFacts(T, cut, { now: NOW })).founderSetBudgetEvent).toMatchObject({ source: "approved", at: "2026-10-20T05:06:41Z" });
  });

  it("a later re-claim of an older landed card never outranks a newer outside edit (dated by executed_at)", async () => {
    tables.ad_object_changes = [outsideEdit("2026-10-21T09:00:00Z")];
    tables.channel_actions = [approvedZaviRaise({ exec_claimed_at: "2026-10-22T10:00:00Z" })];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).founderSetBudgetEvent?.source).toBe("outside");
  });

  it("an outside edit after the approval holds again", async () => {
    tables.ad_object_changes = [outsideEdit("2026-10-21T09:00:00Z")];
    tables.channel_actions = [approvedZaviRaise()];
    expect((await loadUnattendedFacts(T, raise, { now: NOW })).founderSetBudgetEvent?.source).toBe("outside");
  });
});

describe("pure rules", () => {
  it("an approval whose direction or the move's direction is unknown holds (fail closed)", () => {
    expect(blockingFounderEvent([{ source: "approved", at: "2026-10-20T00:00:00Z", direction: null }], "up")).not.toBeNull();
    expect(blockingFounderEvent([{ source: "approved", at: "2026-10-20T00:00:00Z", direction: "up" }], undefined)).not.toBeNull();
    expect(blockingFounderEvent([], "up")).toBeNull();
  });

  it("every source has words, and the plain code keeps the old line", () => {
    for (const source of ["outside", "ordered", "edited", "approved"] as const) {
      const w = founderSetBudgetWords(founderSetBudgetReason({ source, at: "2026-10-11T00:00:00Z", direction: "up", via: "chat" }, "google"));
      expect(w, source).toMatch(/Oct 11/);
      expect(w, source).not.toMatch(/—/);
    }
    expect(founderSetBudgetWords("founder_set_budget")).toBe("you set its budget yourself in the last 30 days");
    expect(founderSetBudgetWords("learning_lock")).toBeNull();
  });
});
