import { describe, it, expect } from "vitest";
import { classifyStuckReview } from "../dead-letter";
import { parseMarketFitVerdict } from "../verdict-text";
import { MAX_REVIEW_ATTEMPTS, REVIEW_STALE_MS } from "../constants";

const base = {
  pending_decision_id: "p1",
  tenant_id: "t1",
  status: "pending" as const,
  attempts: 0,
  review_run_id: "run_1" as string | null,
};

describe("classifyStuckReview — dead-letter (P1-3)", () => {
  it("waits while the run is still in flight under the stale ceiling", () => {
    expect(classifyStuckReview({ row: base, runState: "in_flight", ageMs: 60_000 })).toBe("wait");
  });

  it("retries a terminated run with attempts under the cap", () => {
    expect(classifyStuckReview({ row: base, runState: "terminal", ageMs: 60_000 })).toBe("retry");
  });

  it("retries when the run is ABSENT (enqueue never happened)", () => {
    expect(
      classifyStuckReview({ row: { ...base, review_run_id: null }, runState: "absent", ageMs: 1000 }),
    ).toBe("retry");
  });

  it("FAILS (surfaces notice) once attempts hit the cap", () => {
    expect(
      classifyStuckReview({ row: { ...base, attempts: MAX_REVIEW_ATTEMPTS }, runState: "terminal", ageMs: 60_000 }),
    ).toBe("fail");
  });

  it("stops waiting once an in-flight run blows the hard stale ceiling", () => {
    expect(
      classifyStuckReview({ row: base, runState: "in_flight", ageMs: REVIEW_STALE_MS + 1 }),
    ).toBe("retry");
  });

  it("a pending row at the attempts cap fails (surfaces the notice)", () => {
    expect(
      classifyStuckReview({
        row: { ...base, status: "pending", attempts: MAX_REVIEW_ATTEMPTS },
        runState: "terminal",
        ageMs: 999_999,
      }),
    ).toBe("fail");
  });
});

describe("parseMarketFitVerdict", () => {
  it("parses APPROVE with a reason", () => {
    expect(parseMarketFitVerdict("blah\nMarketFitVerdict: APPROVE\nReason: served + liquid\nmore")).toEqual({
      verdict: "approve",
      reason: "served + liquid",
    });
  });

  it("parses BOUNCE (case-insensitive) with a bounce reason", () => {
    expect(parseMarketFitVerdict("marketfitverdict = bounce\nBounce reason = not served")).toEqual({
      verdict: "bounce",
      reason: "not served",
    });
  });

  it("returns null when no verdict token present", () => {
    expect(parseMarketFitVerdict("I think this looks fine, ship it.")).toBeNull();
    expect(parseMarketFitVerdict(null)).toBeNull();
    expect(parseMarketFitVerdict("")).toBeNull();
  });

  it("bounds the reason to 500 chars", () => {
    const r = parseMarketFitVerdict(`MarketFitVerdict: APPROVE\nReason: ${"x".repeat(2000)}`);
    expect(r!.reason.length).toBe(500);
  });
});
