import { describe, it, expect, vi, beforeEach } from "vitest";

const counter = vi.hoisted(() => ({ month: null as unknown }));
vi.mock("@/services/decisions/ad-month-counter", async (orig) => {
  const real = await orig<typeof import("@/services/decisions/ad-month-counter")>();
  const { raiseFromCard } = await import("@/services/growth/ad-budget-shortfall");
  return {
    ...real,
    readMonthCount: vi.fn(async () => counter.month),
    readRaiseFit: vi.fn(async (_t: string, cls: string, body: unknown) => {
      const r = raiseFromCard(cls, body);
      if (r === null) return { kind: "unreadable", why: "card" };
      if (r === "not_a_raise" || r === "non_usd" || r.platform === "chatgpt") return { kind: "not_a_raise" };
      const m = counter.month as Awaited<ReturnType<typeof real.readMonthCount>>;
      if (!m) return { kind: "no_budget" };
      if ("unreadable" in m) return { kind: "unreadable", why: m.unreadable };
      const raise = { platform: r.platform, object_id: r.object_id, delta_daily_usd: r.new_daily_usd - r.current_daily_usd };
      return { ...real.fitDailyChange(m.count, m.view, m.live_held_daily_usd, raise.delta_daily_usd), token: m.token, raise, live_held_daily_usd: m.live_held_daily_usd, view: m.view };
    }),
  };
});
vi.mock("@/services/tenant-client", () => ({ asTenantId: (s: string) => s, tenantRpc: async () => ({ data: null, error: { message: "unused" } }), tenantClient: () => ({}) }));

import { findMoneyAvailability, findMoneyFor, findMoneyWhyOf, fitWithCounterCuts, picksMatch, pickFounderCuts, resetFindMoneyCache } from "../founder-cut-candidates";
import { countMonth } from "@/services/decisions/ad-month-counter";

const c = (id: string, daily: number, platform: "meta" | "google" = "google") => ({ o: { platform, level: "campaign", id, campaign_id: id, name: id, daily_budget_usd: daily } as never, why: "worse", ratio: 3, median: 10 });
const view = (o: Record<string, unknown> = {}) => ({ id: "b-1", status: "active", monthly_usd: 27000, month_cap_usd: 27000, spent_usd: 18000, held_usd: 0, creator_held_usd: 0, creator_spent_usd: 0, left_usd: 9000, daily_limit_usd: null, next_month_start: "2026-11-01", days_left: 8, days_in_month: 31, margin: 1.1, started_on: "2026-08-01", created_at: "2026-08-01T00:00:00Z", stopped_at: null, month_start: "2026-10-01", ...o });
const month = (projected: number, v = view(), live_held = 0) => ({ token: "tok", view: v, live_held_daily_usd: live_held, count: countMonth("b-1", v as never, { spent_usd: 18000, creator_usd: 0, month_cap_usd: 27000, days_left: 8, running_daily_usd: 0, projected_usd: projected, over: false, daily: [], cannot_lower: [] } as never, 0) });
const RAISE = { id: "aaaaaaaa-0000-4000-8000-000000000001", decision_class: "google_ads.update_campaign_budget_review", body: { campaign_id: "raise-obj", daily_budget_usd: 150, expected_current_daily_budget_usd: 120, rationale: "x", over_cap: false } };

beforeEach(() => {
  counter.month = month(27000);
});

describe("pickFounderCuts", () => {
  it("up to 4 options, worst first, each one step at most and never under the $5 floor; room is from - to a day (counter room)", () => {
    const p = pickFounderCuts([c("a", 100), c("b", 50), c("c", 6), c("d", 40), c("e", 30)], 30, 0.2, "raise-obj");
    expect(p.map((x) => [x.object_id, x.to_usd, x.frees_daily_usd])).toEqual([["a", 80, 20], ["b", 40, 10], ["c", 5, 1], ["d", 32, 8]]);
  });
  it("never offers the raise's own object; drops a cut under $1", () => {
    expect(pickFounderCuts([c("raise-obj", 100), c("f", 5.5)], 30, 0.2, "raise-obj")).toEqual([]);
  });
  it("a need smaller than one step frees just the need", () => {
    expect(pickFounderCuts([c("a", 100)], 3.75, 0.2, "x")).toMatchObject([{ to_usd: 96.25, frees_daily_usd: 3.75 }]);
  });
});

describe("fitWithCounterCuts", () => {
  it("must-catch: cuts lower the projection only; the daily limit still counts the raise alone", async () => {
    const { fitDailyChange } = await import("@/services/decisions/ad-month-counter");
    const m = month(27000, view({ daily_limit_usd: 1000 }), 990);
    const f = fitWithCounterCuts(m as never, 30, 30);
    expect(f).toMatchObject({ kind: "over", raise_to_usd: null, daily_limit_to_usd: 1020 });
    expect(fitDailyChange(m.count as never, m.view as never, 990, 0).kind).toBe("fits");
  });
  it("enough counter room makes an over-month raise fit", () => {
    expect(fitWithCounterCuts(month(27000) as never, 30, 30).kind).toBe("fits");
    expect(fitWithCounterCuts(month(27000) as never, 30, 20)).toMatchObject({ kind: "over" });
  });
});

describe("findMoneyFor", () => {
  const deps = (cands: ReturnType<typeof c>[], step = 0.2, currency: Record<string, string> = { meta: "USD", google: "USD" }) => ({ candidates: vi.fn(async () => ({ cands: cands as never, step })), currency: vi.fn(async (_t: string, p: "meta" | "google") => currency[p]) });

  it("over the month: need = ceil(over / days left); candidates exclude the raise's own object", async () => {
    const d = deps([c("raise-obj", 200), c("a", 100), c("b", 50)]);
    const r = await findMoneyFor("t-1", RAISE, { deps: d });
    expect(r).toMatchObject({ kind: "candidates", need_daily_usd: 30, budget_choice: { kind: "over", raise_to_usd: 27300 } });
    expect(r.candidates.map((x) => x.object_id)).toEqual(["a", "b"]);
  });

  it("must-catch: an unreadable month shows can't check and no candidates (the judge is never asked)", async () => {
    counter.month = { unreadable: "meta spend could not be read on the last check" };
    const d = deps([c("a", 100)]);
    const r = await findMoneyFor("t-1", { ...RAISE, id: "aaaaaaaa-0000-4000-8000-000000000002" }, { deps: d });
    expect(r).toMatchObject({ kind: "unreadable", candidates: [], budget_choice: { kind: "unreadable" } });
    expect(d.candidates).not.toHaveBeenCalled();
  });

  it("must-catch: blocked only by the daily limit gets no candidates (cuts do not lower the daily hold total)", async () => {
    counter.month = month(26000, view({ daily_limit_usd: 1000 }), 990);
    const d = deps([c("a", 100)]);
    const r = await findMoneyFor("t-1", { ...RAISE, id: "aaaaaaaa-0000-4000-8000-000000000003" }, { deps: d });
    expect(r).toMatchObject({ kind: "none", why: "daily_limit_only", candidates: [] });
    expect(d.candidates).not.toHaveBeenCalled();
  });

  it("over only on what is already set aside: no candidates", async () => {
    counter.month = month(20000, view({ held_usd: 8900 }));
    const r = await findMoneyFor("t-1", { ...RAISE, id: "aaaaaaaa-0000-4000-8000-000000000004" }, { deps: deps([c("a", 100)]) });
    expect(r).toMatchObject({ kind: "none", why: "set_aside" });
  });

  it("a platform whose account is not USD offers nothing; none left is non_usd", async () => {
    const r = await findMoneyFor("t-1", { ...RAISE, id: "aaaaaaaa-0000-4000-8000-000000000005" }, { deps: deps([c("m", 100, "meta")], 0.2, { meta: "INR", google: "USD" }) });
    expect(r).toMatchObject({ kind: "none", why: "non_usd" });
  });

  it("a judge read error is unreadable, never throws", async () => {
    const r = await findMoneyFor("t-1", { ...RAISE, id: "aaaaaaaa-0000-4000-8000-000000000006" }, { deps: { candidates: async () => Promise.reject(new Error("meta down")) } });
    expect(r).toMatchObject({ kind: "unreadable", candidates: [] });
  });

  it("cached is reused for a minute; fresh always reads", async () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000007";
    const d = deps([c("a", 100)]);
    await findMoneyFor("t-1", { ...RAISE, id }, { deps: d });
    await findMoneyFor("t-1", { ...RAISE, id }, { deps: d, cached: true });
    expect(d.candidates).toHaveBeenCalledTimes(1);
    await findMoneyFor("t-1", { ...RAISE, id }, { deps: d });
    expect(d.candidates).toHaveBeenCalledTimes(2);
  });
});

describe("picksMatch", () => {
  const fresh = pickFounderCuts([c("a", 100), c("b", 50)], 30, 0.2, "x");
  it("each pick is a fresh candidate at the same amount; a moved amount, an unknown or a repeated object is null", () => {
    expect(picksMatch([{ platform: "google", object_id: "b", to_usd: 40 }], fresh)?.map((x) => x.object_id)).toEqual(["b"]);
    expect(picksMatch([{ platform: "google", object_id: "b", to_usd: 39 }], fresh)).toBeNull();
    expect(picksMatch([{ platform: "meta", object_id: "b", to_usd: 40 }], fresh)).toBeNull();
    expect(picksMatch([{ platform: "google", object_id: "a", to_usd: 80 }, { platform: "google", object_id: "a", to_usd: 80 }], fresh)).toBeNull();
  });
});

describe("findMoneyAvailability (the card's find_money)", () => {
  beforeEach(() => resetFindMoneyCache());
  const d = (cands: ReturnType<typeof c>[]) => ({ candidates: async () => ({ cands: cands as never, step: 0.2 }), currency: async () => "USD" });
  it("must-catch upcar shape (2026-10-23): over on what is set aside, cuts free only projection room -> none", async () => {
    counter.month = month(27500, view({ spent_usd: 19678, held_usd: 10368 }));
    expect((await findMoneyAvailability("t-1", RAISE, { deps: d([c("a", 100), c("b", 50)]) })).find_money).toBe("none");
  });
  it("must-catch (Codex F1): a $10/day need and one $20 object at a 20% step (frees $4) -> none, not_enough", async () => {
    const raise10 = { ...RAISE, id: "aaaaaaaa-0000-4000-8000-000000000010", body: { ...RAISE.body, daily_budget_usd: 130 } };
    counter.month = month(27000);
    expect(await findMoneyFor("t-1", raise10, { deps: d([c("a", 20)]) })).toMatchObject({ kind: "none", why: "not_enough", candidates: [] });
    resetFindMoneyCache();
    expect((await findMoneyAvailability("t-1", raise10, { deps: d([c("a", 20)]) })).find_money).toBe("none");
    resetFindMoneyCache();
    expect((await findMoneyAvailability("t-1", raise10, { deps: d([c("a", 20), c("b", 30)]) })).find_money).toBe("available");
  });
  it("candidates that together make the room -> available", async () => {
    counter.month = month(27000);
    expect((await findMoneyAvailability("t-1", RAISE, { deps: d([c("a", 100), c("b", 50)]) })).find_money).toBe("available");
  });
  it("must-catch (Codex F5): a currency read that fails -> unreadable, never none", async () => {
    counter.month = month(27000);
    const failing = { candidates: async () => ({ cands: [c("a", 100), c("b", 50)] as never, step: 0.2 }), currency: async () => Promise.reject(new Error("google 500")) };
    expect(await findMoneyFor("t-1", { ...RAISE, id: "aaaaaaaa-0000-4000-8000-000000000011" }, { deps: failing })).toMatchObject({ kind: "unreadable", candidates: [], budget_choice: { kind: "unreadable" } });
    resetFindMoneyCache();
    expect((await findMoneyAvailability("t-1", RAISE, { deps: failing })).find_money).toBe("unreadable");
  });
  it("must-catch (Codex re-check F1): Meta read failed and Google has no candidates -> unreadable, never none; enough from the read platform is still available", async () => {
    counter.month = month(27000);
    const metaDown = (cands: ReturnType<typeof c>[]) => ({ candidates: async () => ({ cands: cands as never, step: 0.2, incomplete: true }), currency: async () => "USD" });
    expect(await findMoneyFor("t-1", { ...RAISE, id: "aaaaaaaa-0000-4000-8000-000000000012" }, { deps: metaDown([]) })).toMatchObject({ kind: "unreadable", candidates: [] });
    resetFindMoneyCache();
    expect((await findMoneyAvailability("t-1", RAISE, { deps: metaDown([]) })).find_money).toBe("unreadable");
    resetFindMoneyCache();
    expect((await findMoneyAvailability("t-1", RAISE, { deps: metaDown([c("a", 100), c("b", 50)]) })).find_money).toBe("available");
  });
  it("a judge that throws (e.g. its experiment read failed) -> unreadable", async () => {
    counter.month = month(27000);
    expect((await findMoneyAvailability("t-1", RAISE, { deps: { candidates: async () => Promise.reject(new Error("Experiment controls are unavailable or incomplete.")) } })).find_money).toBe("unreadable");
  });
  it("a read error -> unreadable", async () => {
    counter.month = month(27000);
    expect((await findMoneyAvailability("t-1", RAISE, { deps: { candidates: async () => Promise.reject(new Error("meta down")) } })).find_money).toBe("unreadable");
    resetFindMoneyCache();
    counter.month = { unreadable: "google was last read 2026-10-20" };
    expect((await findMoneyAvailability("t-1", RAISE, { deps: d([c("a", 100)]) })).find_money).toBe("unreadable");
  });
});

describe("find_money_why (Codex F2)", () => {
  beforeEach(() => resetFindMoneyCache());
  const d = (cands: ReturnType<typeof c>[], cur = "USD") => ({ candidates: async () => ({ cands: cands as never, step: 0.2 }), currency: async () => cur });
  it("must-catch: only a set-aside block says set_aside; no clearly worse ad, too little and non-USD say so", async () => {
    counter.month = month(27500, view({ spent_usd: 19678, held_usd: 10368 }));
    expect(await findMoneyAvailability("t-1", RAISE, { deps: d([c("a", 100)]) })).toEqual({ find_money: "none", find_money_why: "set_aside" });
    resetFindMoneyCache();
    counter.month = month(27000);
    expect(await findMoneyAvailability("t-1", RAISE, { deps: d([]) })).toEqual({ find_money: "none", find_money_why: "no_candidates" });
    resetFindMoneyCache();
    expect(await findMoneyAvailability("t-1", RAISE, { deps: d([c("a", 20)]) })).toEqual({ find_money: "none", find_money_why: "not_enough" });
    resetFindMoneyCache();
    expect(await findMoneyAvailability("t-1", RAISE, { deps: d([c("a", 100)], "INR") })).toEqual({ find_money: "none", find_money_why: "non_usd" });
    resetFindMoneyCache();
    expect(await findMoneyAvailability("t-1", RAISE, { deps: d([c("a", 100), c("b", 50)]) })).toEqual({ find_money: "available", find_money_why: null });
    expect(findMoneyWhyOf("daily_limit_only")).toBe("no_candidates");
  });
});

describe("set_aside only when existing holds push it over (Codex re-check F3)", () => {
  beforeEach(() => resetFindMoneyCache());
  const d = { candidates: async () => ({ cands: [c("a", 100), c("b", 50)] as never, step: 0.2 }), currency: async () => "USD" };
  it("must-catch: a $1,000 cap, $900 spent, no holds, a $200 hold for this raise -> spent, not set_aside", async () => {
    const v = view({ monthly_usd: 1000, month_cap_usd: 1000, spent_usd: 900, held_usd: 0, creator_held_usd: 0, left_usd: 100, margin: 1 });
    counter.month = { token: "tok", view: v, live_held_daily_usd: 0, count: countMonth("b-1", v as never, { spent_usd: 900, creator_usd: 0, month_cap_usd: 1000, days_left: 8, running_daily_usd: 0, projected_usd: 900, over: false, daily: [], cannot_lower: [] } as never, 0) };
    const raise25 = { ...RAISE, id: "aaaaaaaa-0000-4000-8000-000000000013", body: { ...RAISE.body, daily_budget_usd: 145 } };
    expect(await findMoneyFor("t-1", raise25, { deps: d })).toMatchObject({ kind: "none", why: "spent" });
    resetFindMoneyCache();
    expect(await findMoneyAvailability("t-1", raise25, { deps: d })).toEqual({ find_money: "none", find_money_why: "spent" });
  });
  it("must-catch upcar shape: spent 19,678 + 10,368 held vs 27,000 -> set_aside", async () => {
    counter.month = month(27500, view({ spent_usd: 19678, held_usd: 10368 }));
    expect(await findMoneyAvailability("t-1", RAISE, { deps: d })).toEqual({ find_money: "none", find_money_why: "set_aside" });
  });
});
