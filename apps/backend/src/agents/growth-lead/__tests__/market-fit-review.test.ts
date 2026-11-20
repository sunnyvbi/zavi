import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveMock = vi.fn(async () => ({ ok: true, outcome: "approved", final_decision_id: "d1" }));
vi.mock("@/services/tools/meta-ads/write/_ad-set-bid", () => ({ resolveCreateAdSetBid: async (_t: string, d: unknown) => d }));
vi.mock("@/services/meta-ads/strategist-gate/resolve-verdict", () => ({
  resolveMarketFitVerdict: (...args: unknown[]) => resolveMock(...(args as [])),
}));
vi.mock("@/services/meta-ads/strategist-gate/review-state", () => ({
  reviewStateDeps: { claimForResolve: vi.fn(), getParkedDecision: vi.fn(), findExistingFinalCreate: vi.fn(), finalizeApproved: vi.fn(), finalizeBounced: vi.fn(), recoverApproved: vi.fn(), supersedeFailureNotice: vi.fn(), releaseClaim: vi.fn() },
  findFinalCreateFor: vi.fn(async () => null),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import {
  maybeResolveMarketFitReview,
  isMarketFitReviewPayload,
} from "../market-fit-review";
import { FINAL_CREATE_CLASS } from "@/services/meta-ads/strategist-gate/constants";

function ctx(emit = vi.fn(async () => "final_1")) {
  return { tenant_id: "t1", runId: "run_review", emitDecision: emit } as never;
}
function result(text: string) {
  return { output_text: text, raw_response_text: text, parsed: null, parse_ok: false } as never;
}

describe("maybeResolveMarketFitReview — post-run branch wiring", () => {
  beforeEach(() => resolveMock.mockClear());

  it("returns false for a non-review payload (falls through to the digest path)", async () => {
    const handled = await maybeResolveMarketFitReview(ctx(), result("hi"), { fan_in_note_ids: [] });
    expect(handled).toBe(false);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("detects the review payload and invokes the resolver with the parsed verdict", async () => {
    const emit = vi.fn(async () => "final_1");
    const handled = await maybeResolveMarketFitReview(
      ctx(emit),
      result("analysis...\nMarketFitVerdict: APPROVE\nReason: served + liquid"),
      { market_fit_review: { pending_decision_id: "pending_9" } },
    );
    expect(handled).toBe(true);
    expect(resolveMock).toHaveBeenCalledTimes(1);
    const [input, deps] = resolveMock.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(input).toMatchObject({ pending_decision_id: "pending_9", tenant_id: "t1", verdict: "approve", reason: "served + liquid" });
    await (deps.emitFinalCreate as (a: { body: unknown }) => Promise<string>)({ body: { x: 1 } });
    expect(emit).toHaveBeenCalledWith(FINAL_CREATE_CLASS, { x: 1 });
  });

  it("parses a BOUNCE verdict", async () => {
    await maybeResolveMarketFitReview(
      ctx(),
      result("MarketFitVerdict: BOUNCE\nReason: PR not served"),
      { market_fit_review: { pending_decision_id: "pending_9" } },
    );
    const [input] = resolveMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input).toMatchObject({ verdict: "bounce", reason: "PR not served" });
  });

  it("is a review run (returns true) but does NOT invoke the resolver when no verdict is parseable → sweep dead-letters it", async () => {
    const handled = await maybeResolveMarketFitReview(
      ctx(),
      result("I looked at it but forgot to give a verdict."),
      { market_fit_review: { pending_decision_id: "pending_9" } },
    );
    expect(handled).toBe(true);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("isMarketFitReviewPayload discriminates", () => {
    expect(isMarketFitReviewPayload({ market_fit_review: { pending_decision_id: "x" } })).toBe(true);
    expect(isMarketFitReviewPayload({ market_fit_review: {} })).toBe(false);
    expect(isMarketFitReviewPayload({})).toBe(false);
    expect(isMarketFitReviewPayload(null)).toBe(false);
  });
});
