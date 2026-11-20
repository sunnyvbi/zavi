import { describe, it, expect, vi, beforeEach } from "vitest";

const logReviewMock = vi.fn();
vi.mock("@/services/logging/log-review", () => ({
  logReview: (...a: unknown[]) => logReviewMock(...a),
}));

import { runPreEmitHarness } from "@/services/agents/reasoning-harness";

const base = {
  tenant_id: "t-1",
  agent_slug: "growth-lead",
  run_id: "run-1",
} as const;

beforeEach(() => {
  logReviewMock.mockReset();
});

describe("runPreEmitHarness — prose surface (P0.3 grounding shadow)", () => {
  it("claim-bearing agent + ungrounded absence claim on memory → logs a prose_shadow signal, body unchanged", async () => {
    const text = "The campaign has been deleted and is no longer active.";
    const evidence = [{ name: "memory__search" }] as unknown[];
    const r = await runPreEmitHarness({
      ...base,
      agent_slug: "research",
      surface: "prose",
      body: text,
      evidence,
    });
    expect(r.body).toBe(text);
    expect(logReviewMock).toHaveBeenCalledTimes(1);
    const arg = logReviewMock.mock.calls[0][0];
    expect(arg.feature).toBe("reasoning_harness");
    expect(arg.event).toBe("prose_shadow");
    expect(JSON.stringify(arg)).not.toContain("has been deleted");
  });

  it("non-claim-bearing agent → prose shadow does not run (no log)", async () => {
    const r = await runPreEmitHarness({
      ...base,
      agent_slug: "engineer",
      surface: "prose",
      body: "The record has been deleted.",
      evidence: [{ name: "memory__search" }] as unknown[],
    });
    expect(logReviewMock).not.toHaveBeenCalled();
    expect(r.body).toBe("The record has been deleted.");
  });

  it("clean prose (no ungrounded claim) → no log", async () => {
    const r = await runPreEmitHarness({
      ...base,
      agent_slug: "research",
      surface: "prose",
      body: "Here is a summary of the funnel metrics you asked about.",
      evidence: [],
    });
    expect(logReviewMock).not.toHaveBeenCalled();
    expect(r.body).toContain("summary of the funnel");
  });
});
