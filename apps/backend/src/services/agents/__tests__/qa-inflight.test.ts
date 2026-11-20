
import { describe, it, expect } from "vitest";
import { QA_INFLIGHT_STALE_MS, qaInflightCutoffISO } from "../qa-inflight";

describe("qaInflightCutoffISO", () => {
  it("is a 2h window", () => {
    expect(QA_INFLIGHT_STALE_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("returns the ISO timestamp 2h before the given instant", () => {
    const now = Date.parse("2026-06-24T12:00:00.000Z");
    expect(qaInflightCutoffISO(now)).toBe("2026-06-24T10:00:00.000Z");
  });

  it("a row enqueued >2h ago is on the stale side of the cutoff (would NOT block)", () => {
    const now = Date.parse("2026-06-24T12:00:00.000Z");
    const cutoff = qaInflightCutoffISO(now);
    const staleEnqueuedAt = "2026-06-24T09:30:00.000Z";
    expect(staleEnqueuedAt > cutoff).toBe(false);
  });

  it("a row enqueued <2h ago is on the fresh side (still blocks)", () => {
    const now = Date.parse("2026-06-24T12:00:00.000Z");
    const cutoff = qaInflightCutoffISO(now);
    const freshEnqueuedAt = "2026-06-24T11:30:00.000Z";
    expect(freshEnqueuedAt > cutoff).toBe(true);
  });
});
