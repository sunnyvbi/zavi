import { describe, it, expect, vi, beforeEach } from "vitest";

const logEventMock = vi.fn();
vi.mock("../logEvent", () => ({
  logEvent: (...a: unknown[]) => logEventMock(...a),
}));

import { logReview } from "../log-review";

describe("logReview — review-log shape", () => {
  beforeEach(() => {
    logEventMock.mockReset();
  });

  it("emits source:'review' + code:'review.<feature>.<event>' with run_id + review_outcome", () => {
    logReview({
      feature: "critic",
      event: "enforced",
      outcome: "refute",
      run_id: "run-123",
      tenant_id: "tenant-A",
      meta: { decision_class: "social.publish.v2", agent_slug: "performance-marketer" },
    });
    expect(logEventMock).toHaveBeenCalledTimes(1);
    const arg = logEventMock.mock.calls[0][0];
    expect(arg.level).toBe("info");
    expect(arg.source).toBe("review");
    expect(arg.code).toBe("review.critic.enforced");
    expect(arg.run_id).toBe("run-123");
    expect(arg.tenant_id).toBe("tenant-A");
    expect(arg.meta).toMatchObject({
      review_outcome: "refute",
      decision_class: "social.publish.v2",
      agent_slug: "performance-marketer",
    });
  });

  it("sanitizes feature/event to a slug-safe set ('Critic!' → 'critic')", () => {
    logReview({ feature: "Critic!", event: "Shadow Run", outcome: "pass", run_id: "r1" });
    const arg = logEventMock.mock.calls[0][0];
    expect(arg.code).toBe("review.critic.shadowrun");
  });

  it("keeps the code segment within [a-z0-9_-] (drops slashes/dots/etc.)", () => {
    logReview({ feature: "a/b.c", event: "x_y-1", outcome: "pass", run_id: "r1" });
    const arg = logEventMock.mock.calls[0][0];
    expect(arg.code).toBe("review.abc.x_y-1");
  });

  it("sanitizes the outcome to a slug (no free text survives into review_outcome — C14)", () => {
    logReview({ feature: "f", event: "e", outcome: "Refute: claim about $500!", run_id: "r1" });
    const oc = String(logEventMock.mock.calls[0][0].meta.review_outcome);
    expect(oc).toMatch(/^[a-z0-9_-]*$/);
    expect(oc.length).toBeLessThanOrEqual(40);
  });

  it("falls back to 'unknown' for an empty/stripped segment (no malformed codes)", () => {
    logReview({ feature: "", event: "!!!", outcome: "pass", run_id: "r1" });
    expect(logEventMock.mock.calls[0][0].code).toBe("review.unknown.unknown");
  });

  it("passes review_outcome through as the promoted outcome", () => {
    logReview({ feature: "critic", event: "shadow", outcome: "revise", run_id: "r1" });
    expect(logEventMock.mock.calls[0][0].meta.review_outcome).toBe("revise");
  });

  it("maps a null tenant_id to undefined (system-context review)", () => {
    logReview({ feature: "critic", event: "shadow", outcome: "pass", run_id: "r1", tenant_id: null });
    expect(logEventMock.mock.calls[0][0].tenant_id).toBeUndefined();
  });

  it("works with no extra meta (just review_outcome)", () => {
    logReview({ feature: "critic", event: "shadow", outcome: "pass", run_id: "r1" });
    expect(logEventMock.mock.calls[0][0].meta).toEqual({ review_outcome: "pass" });
  });

  it("returns void (fire-and-forget — caller does not await)", () => {
    const out = logReview({ feature: "critic", event: "shadow", outcome: "pass", run_id: "r1" });
    expect(out).toBeUndefined();
  });
});
