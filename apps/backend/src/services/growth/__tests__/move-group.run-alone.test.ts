
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db = { decisions: [] as Row[], channel_actions: [] as Row[], agent_runs: [] as Row[] };

function query(table: keyof typeof db) {
  const filters: Array<(r: Row) => boolean> = [];
  const get = (r: Row, col: string): unknown => {
    const m = /^(\w+)->>(\w+)$/.exec(col);
    return m ? (r[m[1]] as Row | null)?.[m[2]] : r[col];
  };
  const rows = () => (db[table] as Row[]).filter((r) => filters.every((f) => f(r)));
  const self = {
    select: () => self,
    eq: (col: string, val: unknown) => (filters.push((r) => get(r, col) === val), self),
    in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(get(r, col))), self),
    neq: (col: string, val: unknown) => (filters.push((r) => get(r, col) !== val), self),
    gte: () => self,
    limit: () => self,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null }),
  };
  return self;
}

vi.mock("@/services/decisions/ad-budget-choice-flag", () => ({ adBudgetChoiceEnabled: async () => false }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({ from: (t: keyof typeof db) => query(t) }),
}));

import { checkPairedLeg, leaveMoveGroup, legDailyAdd, pairedDispatchHold, runAloneConfirm, runAloneMessage, type LiveReader } from "../move-group";

const T = "tenant-1";
const ROOT = "run-root";
const founder = (extra: Row) => ({ founder_chat_order: true, origin: "user_initiated_chat", move_group: ROOT, ...extra });
const SWITCH_ON = founder({ object_id: "900", level: "adset", status: "ACTIVE", verified_name: "Host Areas (copy)" });
const PAUSE_A = founder({ object_id: "901", level: "adset", status: "PAUSED", verified_name: "Regular Leads" });
const PAUSE_B = founder({ object_id: "902", level: "adset", status: "PAUSED", verified_name: "Regular Leads (copy)" });
const RAISE = founder({ ad_set_id: "111", daily_budget_usd: 50, expected_current_daily_budget_usd: 40, verified_name: "Search A" });
const CLS = "meta_ads.set_status_review";

const decision = (id: string, cls: string, body: Row, status: string): Row => ({ id, tenant_id: T, decision_class: cls, body, status, agent_run_id: ROOT });
const live = (over: Partial<LiveReader> = {}): LiveReader => ({
  googleCampaign: async () => ({ daily_usd: 10, status: "PAUSED" }),
  googleAdGroupStatus: async () => "PAUSED",
  googleAdStatus: async () => "PAUSED",
  metaObject: async () => ({ daily: 60, status: "PAUSED", currency: "USD" }),
  ...over,
});

beforeEach(() => {
  db.decisions = [decision("on", CLS, SWITCH_ON, "proposed"), decision("pa", CLS, PAUSE_A, "proposed"), decision("pb", CLS, PAUSE_B, "proposed")];
  db.channel_actions = [];
  db.agent_runs = [];
});

describe("the confirm a person sees instead of a refusal", () => {
  it("must-catch: the live incident reads +$60/day with 2 pauses still open", async () => {
    const leg = { id: "on", exec_class: CLS, body: SWITCH_ON };
    const v = await checkPairedLeg(T, leg);
    expect(v).toMatchObject({ kind: "wait", why: "cut_untapped" });
    if (v.kind !== "wait") throw new Error("expected a wait");
    const c = await runAloneConfirm(T, leg, v, live());
    expect(c).toMatchObject({ daily_add: 60, currency: "USD", open_legs: 2, why: "cut_untapped" });
    expect(c.message).toBe(
      "This turns on “Host Areas (copy)”: +$60/day. The 2 pauses in this move are still open, so your daily spend goes up by $60 until you approve them.",
    );
  });

  it("a raise reads its own amount from the body (new minus current)", async () => {
    expect(await legDailyAdd(T, { id: "r", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE }, live())).toEqual({ daily: 10, currency: null });
  });

  it("an amount it could not read is said, never guessed", async () => {
    const d = await legDailyAdd(T, { id: "on", exec_class: CLS, body: SWITCH_ON }, live({ metaObject: async () => Promise.reject(new Error("down")) }));
    expect(d.daily).toBeNull();
    const m = runAloneMessage({ exec_class: CLS, body: SWITCH_ON, daily: null, currency: null, why: "unreadable", legs: [] });
    expect(m).toContain("Zavi could not read how much it adds per day.");
    expect(m).toContain("cannot say what else would change");
    expect(m).not.toMatch(/\$|still open/);
  });

  it("an unknown amount never says spend definitely goes up", () => {
    const m = runAloneMessage({ exec_class: "google_ads.replace_geo_targets_review", body: { campaign_id: "1" }, daily: null, currency: null, why: "cut_untapped", legs: [{ exec_class: CLS, body: { status: "PAUSED" } }] });
    expect(m).toContain("may add spend");
    expect(m).toContain("may go up");
    expect(m).not.toMatch(/ adds spend|goes up/);
  });

  it("an unreadable or unknown move gives no open count", async () => {
    const leg = { id: "on", exec_class: CLS, body: SWITCH_ON };
    expect((await runAloneConfirm(T, leg, { kind: "wait", why: "unreadable", legs: [] }, live())).open_legs).toBeNull();
    expect((await runAloneConfirm(T, leg, { kind: "wait", why: "order_unknown", legs: [] }, live())).open_legs).toBeNull();
  });
});

describe("Run it alone: the leg leaves its move and nothing holds it after", () => {
  it("must-catch: the stripped body passes the approve check and the executor while the pauses are still untapped", async () => {
    const body = leaveMoveGroup(SWITCH_ON, "owner-1", "2026-10-20T12:00:00.000Z");
    expect(body.move_group).toBeUndefined();
    expect(body.run_alone).toEqual({ move_group_left: ROOT, by: "owner-1", at: "2026-10-20T12:00:00.000Z" });
    db.decisions[0].body = body;
    const leg = { id: "on", exec_class: CLS, body };
    expect(await checkPairedLeg(T, leg)).toEqual({ kind: "go" });
    expect(await pairedDispatchHold(T, leg, live())).toBeNull();
  });

  it("must-not-touch: the pauses of that move still approve, and the leg no longer counts in the move", async () => {
    db.decisions[0].body = leaveMoveGroup(SWITCH_ON, "owner-1", "2026-10-20T12:00:00.000Z");
    expect(await checkPairedLeg(T, { id: "pa", exec_class: CLS, body: PAUSE_A })).toEqual({ kind: "go" });
    db.decisions.push(decision("r2", "meta_ads.update_ad_set_budget_review", RAISE, "proposed"));
    expect(await checkPairedLeg(T, { id: "r2", exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE })).toMatchObject({ kind: "wait", why: "cut_untapped" });
  });
});

describe("runAloneMessage edge words", () => {
  it("an object already on adds nothing, and the words do not say spend goes up", () => {
    const m = runAloneMessage({ exec_class: CLS, body: SWITCH_ON, daily: 0, currency: "USD", why: "cut_untapped", legs: [{ exec_class: CLS, body: PAUSE_A }] });
    expect(m).toBe("This turns on “Host Areas (copy)”. It is already running, so it adds nothing per day. The pause in this move is still open.");
  });

  it("one budget cut still applying, a raise of $10", () => {
    const cut = founder({ campaign_id: "222", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 });
    const m = runAloneMessage({ exec_class: "meta_ads.update_ad_set_budget_review", body: RAISE, daily: 10, currency: null, why: "cut_applying", legs: [{ exec_class: "google_ads.update_campaign_budget_review", body: cut }] });
    expect(m).toBe("This raises “Search A”: +$10/day. The cut in this move is still being applied, so your daily spend goes up by $10 until it is done.");
  });
});

describe("the confirm names the object the way a person reads it", () => {
  it("must-catch: the live name loses the Zavi prefix and the internal id", () => {
    const body = { ...SWITCH_ON, verified_name: "Zavi · Host Recommended Areas (copy) · zvf101c3e846" };
    const m = runAloneMessage({ exec_class: CLS, body, daily: 60, currency: "USD", why: "cut_untapped", legs: [{ exec_class: CLS, body: PAUSE_A }, { exec_class: CLS, body: PAUSE_B }] });
    expect(m.startsWith("This turns on “Host Recommended Areas (copy)”: +$60/day.")).toBe(true);
    expect(m).not.toMatch(/Zavi ·|zvf101c3e846/);
  });
});
