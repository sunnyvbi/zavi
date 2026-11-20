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
}));

import { budgetTestStopUsd, budgetTestsFrom, extraSpendUsd, loadBudgetTestFact, monitorBudgetTests, revertChange, runningTestOn, testOver, type BudgetTest, type MonitorDeps } from "../budget-tests";
import { evaluateUnattended, heldReasonWords, type UnattendedAction } from "../unattended-policy";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AS = "120258729006520059";
const TEST_ID = "1ffe4e30-87cc-43b7-aa32-9252072beb36";
const test = { variable: "Daily budget of Rent a car, $120 to $149", budget_usd: 203, baseline: "Oct 12 to 18 at $120 a day", baseline_daily_usd: 120, success_if: "under $90 a purchase", stop_if: "Ends Oct 26 or $203 extra", stop_rule: "budget_or_deadline", readout_on: "2026-10-27" };
const card = (over: Row = {}): Row => ({ id: TEST_ID, tenant_id: T, decision_class: "cgo.dispatch-specialist", status: "acted", emitted_at: "2026-10-20T00:30:00Z", body: { dispatched_by: "cgo", target_agent_slug: "meta_ads", test }, ...over });
const run = (id: string, src: string | null): Row => ({ id, tenant_id: T, source_decision_id: src, payload: { source_decision_id: src } });
const raiseCard = (over: Row = {}): Row => ({
  id: "be941965",
  tenant_id: T,
  run_id: "run-test",
  exec_class: "meta_ads.update_ad_set_budget_review",
  exec_status: "executed",
  executed_at: "2026-10-20T05:06:41Z",
  exec_payload: { ad_set_id: AS, daily_budget_usd: 149, expected_current_daily_budget_usd: 120, over_cap: false, name: "Rent a car", currency: "USD", rationale: "test", authorized_effective_cap: { daily: 1 }, founder_chat_order: false },
  edited_body: null,
  ...over,
});
const raise = (run_id: string | null): UnattendedAction => ({
  kind: "ad",
  exec_class: "meta_ads.update_ad_set_budget_review",
  payload: { ad_set_id: AS, daily_budget_usd: 178.8, expected_current_daily_budget_usd: 149, over_cap: false },
  source: { table: "channel_actions", id: "7a8da8b6", run_id },
});

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.decisions = [card()];
  tables.agent_runs = [run("run-test", TEST_ID), run("run-email", null)];
  tables.channel_actions = [raiseCard()];
});

describe("D4 gate: cgo may not move an object while its budget test runs", () => {
  it("the mid-test raise (Oct 22) is held, named with the day the test ends", async () => {
    const fact = await loadBudgetTestFact(T, "meta", AS, "run-email", new Date("2026-10-22T16:00:00Z"));
    expect(fact.running).toEqual({ decision_id: TEST_ID, ends_on: "2026-10-27" });
    const v = evaluateUnattended(raise("run-email"), {
      refsResolved: true, openAdvice: "clear", goal: { present: false }, trackingOk: true, founderSetBudget: false, zaviRaisedRecently: false, budgetTest: fact,
      objects: [{ id: AS, conversionObjective: true, objective: null, learning: false, daysSinceEdit: 30, lockDays: 7, spend7dUsd: 100, conversions7d: 3, targetCpaUsd: null }],
    });
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("budget_test_running|2026-10-27");
    expect(heldReasonWords(v.reasons)).toContain("a budget test is running on it until Oct 27, so I don't change it mid-test");
  });

  it("not after the test ended, not once a revert card exists, not for the test's own run, not for another tenant", async () => {
    expect((await loadBudgetTestFact(T, "meta", AS, "run-email", new Date("2026-10-27T00:00:01Z"))).running).toBeNull();
    expect((await loadBudgetTestFact(T, "meta", AS, "run-test", new Date("2026-10-22T16:00:00Z"))).running).toBeNull();
    expect((await loadBudgetTestFact(OTHER, "meta", AS, "run-email", new Date("2026-10-22T16:00:00Z"))).running).toBeNull();
    tables.channel_actions.push({ id: "rv", tenant_id: T, body: { test_revert_of: TEST_ID, test_revert_object: AS } });
    expect((await loadBudgetTestFact(T, "meta", AS, "run-email", new Date("2026-10-22T16:00:00Z"))).running).toBeNull();
  });

  it("a budget card from a paid test run registered without baseline_daily_usd is held", async () => {
    const { baseline_daily_usd: _b, ...noBase } = test;
    tables.decisions = [card({ body: { dispatched_by: "cgo", test: noBase } })];
    tables.channel_actions = [];
    const fact = await loadBudgetTestFact(T, "meta", AS, "run-test", new Date("2026-10-20T01:00:00Z"));
    expect(fact).toEqual({ running: null, baselineMissing: true });
    expect(heldReasonWords(["test_baseline_missing"])[0]).toMatch(/no baseline budget/);
    tables.decisions = [card()];
    expect((await loadBudgetTestFact(T, "meta", AS, "run-test", new Date("2026-10-20T01:00:00Z"))).baselineMissing).toBe(false);
  });
});

const tests = (reverted = false): BudgetTest[] =>
  budgetTestsFrom([card() as never], [{ id: "run-test", source_decision_id: TEST_ID }], [raiseCard() as never], new Set(reverted ? [`${TEST_ID}:${AS}`] : []));
const deps = (over: Partial<MonitorDeps> = {}) => {
  const filed: Array<{ exec_class: string; body: Record<string, unknown> }> = [];
  const d: MonitorDeps = {
    readTests: async () => tests(),
    readSpend: async () => [],
    liveBudget: async () => 149,
    chatgptUpdatedAt: async () => null,
    tiktokLive: async () => null,
    file: vi.fn(async (_t: string, _test: BudgetTest, change: { exec_class: string; body: Record<string, unknown> }) => {
      filed.push(change);
      return { id: "rv-1" } as Awaited<ReturnType<MonitorDeps["file"]>>;
    }),
    hold: vi.fn(async () => true),
    tell: vi.fn(async () => true),
    log: () => undefined,
    ...over,
  };
  return { d, filed };
};

describe("D4 revert: at the end Zavi files ONE card back to the baseline for the founder", () => {
  it("at its readout day: one budget card $149 -> $120, held for the founder, and the founder is told; nothing is paused", async () => {
    const { d, filed } = deps();
    const out = await monitorBudgetTests(T, new Date("2026-10-27T01:00:00Z"), d);
    expect(out.filed).toEqual(["rv-1"]);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.exec_class).toBe("meta_ads.update_ad_set_budget_review");
    expect(filed[0]!.body).toMatchObject({ ad_set_id: AS, daily_budget_usd: 120, expected_current_daily_budget_usd: 149, over_cap: false, currency: "USD", name: "Rent a car" });
    expect(filed[0]!.body).not.toHaveProperty("authorized_effective_cap");
    expect(filed[0]!.body).not.toHaveProperty("founder_chat_order");
    expect(filed[0]!.body).not.toHaveProperty("status");
    expect(d.hold).toHaveBeenCalledWith(T, { id: "rv-1", run_id: null }, "budget_test_revert|2026-10-27|120", expect.any(Date));
    expect(heldReasonWords(["budget_test_revert|2026-10-27|120"])[0]).toBe("its budget test ended on Oct 27, so this puts it back to its $120 a day baseline; nothing changes until you approve it");
    expect(d.tell).toHaveBeenCalledTimes(1);
    expect((d.tell as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(`test_revert:${TEST_ID}:${AS}`);
    expect((d.tell as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatch(/I filed a card to put its daily budget back from \$149 to \$120 a day; nothing changes until you approve it/);
  });

  it("a test that ended more than the grace days ago files and tells nothing (stale, e.g. at first deploy)", async () => {
    const { d } = deps();
    expect((await monitorBudgetTests(T, new Date("2026-10-31T00:00:01Z"), d)).filed).toEqual([]);
    expect(d.file).not.toHaveBeenCalled();
    expect(d.tell).not.toHaveBeenCalled();
  });

  it("idempotent: a test with a revert card is never filed again", async () => {
    const { d } = deps({ readTests: async () => tests(true) });
    expect((await monitorBudgetTests(T, new Date("2026-10-28T01:00:00Z"), d)).filed).toEqual([]);
    expect(d.file).not.toHaveBeenCalled();
    expect(d.tell).not.toHaveBeenCalled();
  });

  it("before its end: nothing, unless its extra spend over the baseline used the test budget", async () => {
    const mid = new Date("2026-10-23T12:00:00Z");
    const quiet = deps({ readSpend: async () => [{ spend_date: "2026-10-20", amount_usd: 167.3 }, { spend_date: "2026-10-21", amount_usd: 159.81 }] });
    expect((await monitorBudgetTests(T, mid, quiet.d)).filed).toEqual([]);
    const spent = deps({ readSpend: async () => [1, 2, 3, 4, 5].map((n) => ({ spend_date: `2026-10-2${n - 1}`, amount_usd: 170 })) });
    expect((await monitorBudgetTests(T, mid, spent.d)).filed).toEqual(["rv-1"]);
  });

  it("a budget already back at the baseline files nothing; a test with no baseline is told, never guessed", async () => {
    const back = deps({ liveBudget: async () => 120 });
    expect((await monitorBudgetTests(T, new Date("2026-10-27T01:00:00Z"), back.d)).filed).toEqual([]);
    expect(back.d.tell).not.toHaveBeenCalled();
    const { baseline_daily_usd: _b, ...noBase } = test;
    const bare = budgetTestsFrom([card({ body: { dispatched_by: "cgo", test: noBase } }) as never], [{ id: "run-test", source_decision_id: TEST_ID }], [raiseCard() as never], new Set());
    const told = deps({ readTests: async () => bare });
    expect((await monitorBudgetTests(T, new Date("2026-10-27T01:00:00Z"), told.d)).filed).toEqual([]);
    expect(told.d.file).not.toHaveBeenCalled();
    expect((told.d.tell as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatch(/without a usable baseline budget/);
  });
});

describe("a server-envelope raise: the stop is derived from the executed raise, never a model total", () => {
  const { budget_usd: _t, ...noTotal } = test;
  const serverTest = { ...noTotal, envelope: "server" };
  const serverTests = () => budgetTestsFrom([card({ body: { dispatched_by: "cgo", target_agent_slug: "meta_ads", test: serverTest } }) as never], [{ id: "run-test", source_decision_id: TEST_ID }], [raiseCard() as never], new Set());

  it("($149 - $120) x 7 days = $203 over the baseline ends it early; less does not", async () => {
    const [t] = serverTests();
    expect(budgetTestStopUsd(t!)).toBe(203);
    const mid = new Date("2026-10-23T12:00:00Z");
    const quiet = deps({ readTests: async () => serverTests(), readSpend: async () => [{ spend_date: "2026-10-20", amount_usd: 167.3 }, { spend_date: "2026-10-21", amount_usd: 159.81 }] });
    expect((await monitorBudgetTests(T, mid, quiet.d)).filed).toEqual([]);
    const spent = deps({ readTests: async () => serverTests(), readSpend: async () => [1, 2, 3, 4, 5].map((n) => ({ spend_date: `2026-10-2${n - 1}`, amount_usd: 170 })) });
    expect((await monitorBudgetTests(T, mid, spent.d)).filed).toEqual(["rv-1"]);
    expect((spent.d.tell as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatch(/spent its planned \$203 over the old budget\. I filed a card/);
  });

  it("the founder's edit is the executed raise: the stop follows the edited daily", () => {
    const [t] = budgetTestsFrom([card({ body: { dispatched_by: "cgo", test: serverTest } }) as never], [{ id: "run-test", source_decision_id: TEST_ID }], [raiseCard({ edited_body: { ...(raiseCard().exec_payload as Row), daily_budget_usd: 130 } }) as never], new Set());
    expect(budgetTestStopUsd(t!)).toBe(70);
  });

  it("a cut has no spend stop (its end day still files the revert); a legacy total is still honoured", () => {
    const [cut] = budgetTestsFrom([card({ body: { dispatched_by: "cgo", test: serverTest } }) as never], [{ id: "run-test", source_decision_id: TEST_ID }], [raiseCard({ exec_payload: { ...(raiseCard().exec_payload as Row), daily_budget_usd: 100 } }) as never], new Set());
    expect(budgetTestStopUsd(cut!)).toBeNull();
    expect(testOver(cut!, new Date("2026-10-27T00:00:00Z"), 0)).toMatchObject({ over: true, why: "ended" });
    expect(budgetTestStopUsd(tests()[0]!)).toBe(203);
  });

  it("the baseline is the daily the executed change recorded, not the model's: no founder hold, and the revert goes back to it", async () => {
    const { baseline_daily_usd: _b, ...noBase } = serverTest;
    tables.decisions = [card({ body: { dispatched_by: "cgo", test: noBase } })];
    tables.channel_actions = [];
    expect((await loadBudgetTestFact(T, "meta", AS, "run-test", new Date("2026-10-20T01:00:00Z"))).baselineMissing).toBe(false);
    const said = budgetTestsFrom([card({ body: { dispatched_by: "cgo", test: { ...serverTest, baseline_daily_usd: 110 } } }) as never], [{ id: "run-test", source_decision_id: TEST_ID }], [raiseCard() as never], new Set());
    expect(said[0]!.baseline_daily_usd).toBe(120);
    const { d, filed } = deps({ readTests: async () => said });
    expect((await monitorBudgetTests(T, new Date("2026-10-27T01:00:00Z"), d)).filed).toEqual(["rv-1"]);
    expect(filed[0]!.body).toMatchObject({ daily_budget_usd: 120, expected_current_daily_budget_usd: 149 });
    const legacy = budgetTestsFrom([card({ body: { dispatched_by: "cgo", test: { ...test, baseline_daily_usd: 110 } } }) as never], [{ id: "run-test", source_decision_id: TEST_ID }], [raiseCard() as never], new Set());
    expect(legacy[0]!.baseline_daily_usd).toBe(110);
  });

  it("two changes from the same move: baseline and start are the first change's; each daily counts only for the days it ran", () => {
    const second = (daily: number) => raiseCard({ id: "second", executed_at: "2026-10-22T05:00:00Z", exec_payload: { ...(raiseCard().exec_payload as Row), daily_budget_usd: daily, expected_current_daily_budget_usd: 149 } });
    const of = (daily: number) => budgetTestsFrom([card({ body: { dispatched_by: "cgo", test: serverTest } }) as never], [{ id: "run-test", source_decision_id: TEST_ID }], [second(daily) as never, raiseCard() as never], new Set())[0]!;
    expect(of(170)).toMatchObject({ baseline_daily_usd: 120, launched_at: "2026-10-20T05:06:41Z", card_id: "second", ends_on: "2026-10-27" });
    expect(budgetTestStopUsd(of(170))).toBe(29 * 2 + 50 * 5);
    expect(budgetTestStopUsd(of(130))).toBe(29 * 2 + 10 * 5);
  });

  it("a server test never falls back to the model's baseline: a recorded $0 is kept, a missing prior means none", () => {
    const withPrior = (prior: unknown) =>
      budgetTestsFrom([card({ body: { dispatched_by: "cgo", test: { ...serverTest, baseline_daily_usd: 110 } } }) as never], [{ id: "run-test", source_decision_id: TEST_ID }], [raiseCard({ exec_payload: { ...(raiseCard().exec_payload as Row), expected_current_daily_budget_usd: prior } }) as never], new Set())[0]!;
    expect(withPrior(0).baseline_daily_usd).toBe(0);
    expect(budgetTestStopUsd(withPrior(0))).toBe(149 * 7);
    expect(withPrior(undefined).baseline_daily_usd).toBeNull();
    expect(budgetTestStopUsd(withPrior(undefined))).toBeNull();
  });
});

describe("pure parts", () => {
  it("extra spend counts only spend above the baseline from launch day", () => {
    expect(extraSpendUsd([{ spend_date: "2026-10-19", amount_usd: 500 }, { spend_date: "2026-10-20", amount_usd: 167.3 }, { spend_date: "2026-10-21", amount_usd: "110" }], 120, "2026-10-20")).toBe(47.3);
  });

  it("a test ends at 00:00 UTC of its readout day; a late launch moves it like the readout", () => {
    const [t] = budgetTestsFrom([card() as never], [{ id: "run-test", source_decision_id: TEST_ID }], [raiseCard() as never], new Set());
    expect(t!.ends_on).toBe("2026-10-27");
    expect(testOver(t!, new Date("2026-10-26T23:59:00Z"), 0).over).toBe(false);
    expect(testOver(t!, new Date("2026-10-27T00:00:00Z"), 0)).toMatchObject({ over: true, why: "ended" });
    const [late] = budgetTestsFrom([card() as never], [{ id: "run-test", source_decision_id: TEST_ID }], [raiseCard({ executed_at: "2026-10-23T00:00:00Z" }) as never], new Set());
    expect(late!.ends_on).toBe("2026-10-30");
    expect(runningTestOn([late!], "meta", AS, null, new Date("2026-10-29T00:00:00Z"))).not.toBeNull();
  });

  it("TikTok, Google and ChatGPT reverts carry only each executor's fields; drift fields come from a fresh read", async () => {
    const [t] = budgetTestsFrom([card() as never], [{ id: "run-test", source_decision_id: TEST_ID }], [raiseCard() as never], new Set());
    const g = revertChange({ ...t!, platform: "google", exec_class: "google_ads.update_campaign_budget", body: { campaign_id: "c1", daily_budget_usd: 60, expected_current_daily_budget_usd: 50, over_cap: false, origin: "user_initiated_chat", name: "Search" } }, 60);
    expect(g!.body).toEqual(expect.objectContaining({ campaign_id: "c1", daily_budget_usd: 120, expected_current_daily_budget_usd: 60, over_cap: false }));
    expect(g!.body).not.toHaveProperty("origin");
    const tkBody = { advertiser_id: "7001", advertiser_name: "Acme", object_id: "8001", campaign_id: "8001", level: "campaign", name: "Spring", daily_budget_usd: 150, expected_current_daily_budget_usd: 120, expected_current_status: "ACTIVE", origin: "user_initiated_chat", rationale: "x", authorized_effective_cap: { daily: 1 } };
    const tkTest = { ...t!, platform: "tiktok" as const, exec_class: "tiktok_ads.update_budget", body: tkBody };
    expect(revertChange(tkTest, 150)).toBeNull();
    const tk = revertChange(tkTest, 150, { tiktokStatus: "PAUSED" });
    expect(tk!.body).toMatchObject({ origin: "specialist", daily_budget_usd: 120, expected_current_daily_budget_usd: 150, expected_current_status: "PAUSED" });
    expect(tk!.body).not.toHaveProperty("authorized_effective_cap");
    const { tiktokBudgetBody } = await import("@/services/connectors/tiktok-ads/held-schema");
    expect(tiktokBudgetBody.safeParse(tk!.body).success).toBe(true);
    const cgTest = { ...t!, platform: "chatgpt" as const, exec_class: "chatgpt_ads.update_campaign_budget", body: { campaign_id: "cmpn_abc", name: "Q4", daily_budget_usd: 150, expected_current_daily_budget_usd: 120, origin: "agent", expected_updated_at: 1, summary: "s", rationale: "r", authorized_effective_cap: { daily: 1 } } };
    expect(revertChange(cgTest, 150)).toBeNull();
    const cg = revertChange(cgTest, 150, { chatgptUpdatedAt: 42 });
    expect(cg!.body).toMatchObject({ campaign_id: "cmpn_abc", expected_updated_at: 42, daily_budget_usd: 120 });
    expect(cg!.body).not.toHaveProperty("authorized_effective_cap");
  });

  it("a TikTok revert reads status and budget fresh at filing time; unreadable files nothing and tells the founder", async () => {
    const tkBody = { advertiser_id: "7001", advertiser_name: "Acme", object_id: "8001", campaign_id: "8001", level: "campaign", name: "Spring", daily_budget_usd: 150, expected_current_daily_budget_usd: 120, expected_current_status: "ACTIVE" };
    const tkTests = budgetTestsFrom([card() as never], [{ id: "run-test", source_decision_id: TEST_ID }], [raiseCard({ exec_class: "tiktok_ads.update_budget", exec_payload: tkBody }) as never], new Set());
    const ok = deps({ readTests: async () => tkTests, tiktokLive: async () => ({ status: "PAUSED", budget: 150 }) });
    expect((await monitorBudgetTests(T, new Date("2026-10-27T01:00:00Z"), ok.d)).filed).toEqual(["rv-1"]);
    expect(ok.filed[0]!.body).toMatchObject({ expected_current_status: "PAUSED", expected_current_daily_budget_usd: 150, daily_budget_usd: 120 });
    const blind = deps({ readTests: async () => tkTests, tiktokLive: async () => null });
    expect((await monitorBudgetTests(T, new Date("2026-10-27T01:00:00Z"), blind.d)).filed).toEqual([]);
    expect((blind.d.tell as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatch(/could not file the change/);
  });

  it("an open card kept instead of the revert: the founder is still told (same revert waiting, or another card to decide)", async () => {
    const same = deps({ file: vi.fn(async () => ({ id: "open-1", kept: { same: true } })) });
    expect((await monitorBudgetTests(T, new Date("2026-10-27T01:00:00Z"), same.d)).filed).toEqual([]);
    expect(same.d.hold).not.toHaveBeenCalled();
    expect((same.d.tell as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatch(/already waiting for you/);
    const other = deps({ file: vi.fn(async () => ({ id: "open-2", kept: { same: false } })) });
    await monitorBudgetTests(T, new Date("2026-10-27T01:00:00Z"), other.d);
    expect((other.d.tell as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatch(/Another open card about it is waiting/);
  });

  it("an unusable baseline_daily_usd keeps the test visible: the gate still sees it running, the own run is held, the end tells the founder", async () => {
    for (const bad of [0, -5, "120"]) {
      tables.decisions = [card({ body: { dispatched_by: "cgo", test: { ...test, baseline_daily_usd: bad } } })];
      expect((await loadBudgetTestFact(T, "meta", AS, "run-email", new Date("2026-10-22T16:00:00Z"))).running, String(bad)).not.toBeNull();
      expect((await loadBudgetTestFact(T, "meta", AS, "run-test", new Date("2026-10-20T01:00:00Z"))).baselineMissing, String(bad)).toBe(true);
    }
    const tests = budgetTestsFrom([card({ body: { dispatched_by: "cgo", test: { ...test, baseline_daily_usd: 0 } } }) as never], [{ id: "run-test", source_decision_id: TEST_ID }], [raiseCard() as never], new Set());
    expect(tests[0]!.baselineInvalid).toBe(true);
    const told = deps({ readTests: async () => tests });
    expect((await monitorBudgetTests(T, new Date("2026-10-27T01:00:00Z"), told.d)).filed).toEqual([]);
    expect((told.d.tell as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatch(/without a usable baseline budget/);
  });

  it("a test present but unreadable holds the run's budget change as budget_test_unknown", async () => {
    tables.decisions = [card({ body: { dispatched_by: "cgo", test: { variable: "x" } } })];
    const fact = await loadBudgetTestFact(T, "meta", AS, "run-test", new Date("2026-10-20T01:00:00Z"));
    expect(fact.testUnreadable).toBe(true);
    const { budgetTestReasons } = await import("../budget-test-shape");
    expect(budgetTestReasons(fact)).toContain("budget_test_unknown");
  });
});
