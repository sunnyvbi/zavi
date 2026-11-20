import { describe, expect, it } from "vitest";
import { sameShallow } from "./stableState";

describe("sameShallow", () => {
  const counters: Record<string, unknown> = {
    active_runs: 0,
    approvals_pending: 3,
    credits_remaining: null,
    credits_enforced: true,
  };

  it("is true for a fresh copy with identical values (poll returned the same data)", () => {
    expect(sameShallow(counters, { ...counters })).toBe(true);
  });

  it("is false when any value changes, so consumers still update", () => {
    expect(sameShallow(counters, { ...counters, approvals_pending: 4 })).toBe(false);
    expect(sameShallow(counters, { ...counters, credits_remaining: 0 })).toBe(false);
    expect(sameShallow(counters, { ...counters, active_runs: 1 })).toBe(false);
  });

  it("is false when the backend adds or drops a field", () => {
    expect(sameShallow(counters, { ...counters, included_allowance: 100 })).toBe(false);
    const { credits_enforced: _dropped, ...fewer } = counters;
    expect(sameShallow(counters, fewer)).toBe(false);
  });

  it("does not treat a same-count different-key object as equal", () => {
    expect(sameShallow({ a: undefined } as Record<string, unknown>, { b: undefined })).toBe(false);
  });

  it("handles null / undefined", () => {
    expect(sameShallow(null, null)).toBe(true);
    expect(sameShallow(counters, null)).toBe(false);
    expect(sameShallow(undefined, counters)).toBe(false);
  });

  it("compares NaN as equal (Object.is)", () => {
    expect(sameShallow({ x: Number.NaN }, { x: Number.NaN })).toBe(true);
  });
});
