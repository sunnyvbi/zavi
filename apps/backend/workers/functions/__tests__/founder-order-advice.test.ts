import { describe, expect, it, vi, beforeEach } from "vitest";

const logs = vi.hoisted(() => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/logging/logEvent", () => logs);

import { markFounderAdviceUnavailable, runFounderOrderAdvice, type FounderAdviceDeps } from "../founder-order-advice";

const row = (over: Record<string, unknown> = {}) => ({
  id: "d-1",
  tenant_id: "t-1",
  decision_class: "google_ads.update_campaign_budget_review",
  body: { campaign_id: "1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20, origin: "user_initiated_chat" },
  status: "proposed",
  ...over,
});
function deps(r: ReturnType<typeof row> | null, over: Partial<FounderAdviceDeps> = {}) {
  const writes: Array<[unknown, unknown]> = [];
  const d: FounderAdviceDeps = {
    readRow: async () => r,
    evaluate: async () => ({ verdict: "ask_founder", reasons: ["objective_metric_mismatch"] }),
    write: async (a, b) => (writes.push([a, b]), true),
    now: () => new Date("2026-10-17T00:00:00Z"),
    ...over,
  };
  return { d, writes };
}

describe("runFounderOrderAdvice", () => {
  beforeEach(() => logs.logEvent.mockClear());

  it("writes the warnings on a founder card still proposed, for its own tenant", async () => {
    const { d, writes } = deps(row());
    expect(await runFounderOrderAdvice("d-1", d)).toEqual({ written: true, warnings: 1 });
    expect(writes[0][0]).toMatchObject({ id: "d-1", tenant_id: "t-1" });
    expect(writes[0][1]).toEqual({ warnings: ["it is not set up to get conversions, so zero conversions says nothing"], at: "2026-10-17T00:00:00.000Z" });
    expect(logs.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "founder_order.advice_written", tenant_id: "t-1" }));
  });

  it("skips a row without the founder mark, a non-ad class, a decided row and a missing row", async () => {
    for (const [r, why] of [
      [row({ body: { campaign_id: "1" } }), "not_founder_ad"],
      [row({ decision_class: "tiktok_ads.set_status" }), "not_founder_ad"],
      [row({ status: "approved" }), "not_proposed"],
      [row({ status: "superseded" }), "not_proposed"],
      [null, "not_found"],
    ] as const) {
      const { d, writes } = deps(r as ReturnType<typeof row> | null);
      expect(await runFounderOrderAdvice("d-1", d)).toEqual({ skipped: why });
      expect(writes).toHaveLength(0);
    }
  });

  it("an evaluator error is logged as advice_failed, nothing is written, and it rethrows so Inngest retries", async () => {
    const { d, writes } = deps(row(), { evaluate: async () => Promise.reject(new Error("meta down")) });
    await expect(runFounderOrderAdvice("d-1", d)).rejects.toThrow("meta down");
    expect(writes).toHaveLength(0);
    expect(logs.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "founder_order.advice_failed", tenant_id: "t-1" }));
  });

  it("a retry after the card was decided meanwhile writes nothing (proposed-only)", async () => {
    let n = 0;
    const { d, writes } = deps(row(), {
      readRow: async () => (n++ === 0 ? row() : row({ status: "approved" })),
      evaluate: async () => (n === 1 ? Promise.reject(new Error("blip")) : { verdict: "ask_founder", reasons: ["learning_lock"] }),
    });
    await expect(runFounderOrderAdvice("d-1", d)).rejects.toThrow("blip");
    expect(await runFounderOrderAdvice("d-1", d)).toEqual({ skipped: "not_proposed" });
    expect(writes).toHaveLength(0);
  });

  it("a write that matched no row (decided meanwhile) reports written: false", async () => {
    const { d } = deps(row(), { write: async () => false });
    expect(await runFounderOrderAdvice("d-1", d)).toEqual({ written: false, warnings: 1 });
  });
});

describe("markFounderAdviceUnavailable (bug #7: out of retries)", () => {
  beforeEach(() => logs.logEvent.mockClear());
  const now = () => new Date("2026-10-18T04:20:00Z");
  it("must-catch: a founder card whose warnings never came says so, instead of showing no warning", async () => {
    const writes: unknown[] = [];
    expect(await markFounderAdviceUnavailable("d-1", { readRow: async () => row(), write: async (_r, a) => (writes.push(a), true), now })).toBe(true);
    expect(writes).toEqual([{ warnings: [], at: "2026-10-18T04:20:00.000Z", unavailable: true }]);
    expect(logs.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "founder_order.advice_unavailable" }));
  });
  it("must-not-touch: a decided card or a non-ad class is left alone; a write failure never throws", async () => {
    const write = vi.fn(async () => true);
    expect(await markFounderAdviceUnavailable("d-1", { readRow: async () => row({ status: "approved" }), write, now })).toBe(false);
    expect(await markFounderAdviceUnavailable("d-1", { readRow: async () => row({ decision_class: "engineer.ship-pr" }), write, now })).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(await markFounderAdviceUnavailable("d-1", { readRow: async () => row(), write: async () => { throw new Error("db down"); }, now })).toBe(false);
  });
});
