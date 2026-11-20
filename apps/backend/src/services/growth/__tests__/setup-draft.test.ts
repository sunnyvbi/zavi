import { describe, it, expect } from "vitest";
import { setupDraftKey, setupDraftAttempt, isRefundableSetupDraft, nextSetupAttempt } from "../setup-draft";

const T = "t-1";

describe("setup draft keys", () => {
  it("attempts 1-3 are the refunded keys, under the draft prefix", () => {
    expect([1, 2, 3].map((a) => setupDraftKey(T, a))).toEqual([`cgo:draft:${T}:setup`, `cgo:draft:${T}:setup:2`, `cgo:draft:${T}:setup:3`]);
    expect(() => setupDraftKey(T, 0)).toThrow();
    expect(setupDraftAttempt(T, `cgo:draft:${T}:2026-09-24`)).toBeNull();
  });
  it("paid keys are setup keys (tracked) but never refundable", () => {
    expect(setupDraftKey(T, 4)).toBe(`cgo:draft:${T}:setup:paid:4`);
    expect(setupDraftAttempt(T, `cgo:draft:${T}:setup:paid:4`)).toBe(4);
    expect(setupDraftAttempt(T, `cgo:draft:${T}:setup:4`)).toBeNull();
    expect(setupDraftAttempt(T, `cgo:draft:${T}:setup:paid:2`)).toBeNull();
    const base = { id: "r", status: "success", agent_slug: "cgo", trigger: "a2a", enqueued_by: null };
    expect(isRefundableSetupDraft(T, { ...base, cron_dedupe_key: setupDraftKey(T, 3) })).toBe(true);
    expect(isRefundableSetupDraft(T, { ...base, cron_dedupe_key: setupDraftKey(T, 4) })).toBe(false);
    expect(isRefundableSetupDraft(T, { ...base, enqueued_by: "u1", cron_dedupe_key: setupDraftKey(T, 1) })).toBe(false);
  });
});

const run = (a: number, status: string) => ({ id: `r${a}`, status, cron_dedupe_key: setupDraftKey(T, a) });

describe("nextSetupAttempt", () => {
  it("first ask with nothing yet: attempt 1", () => expect(nextSetupAttempt(T, [], false, false, false)).toEqual({ attempt: 1 }));
  it("first ask when one exists: hand back that run, never a second", () =>
    expect(nextSetupAttempt(T, [run(1, "running")], false, false, false)).toEqual({ existing: "r1" }));
  it("retry only after a failure", () => {
    expect(nextSetupAttempt(T, [run(1, "running")], false, true, false)).toEqual({ refused: "draft_in_flight" });
    expect(nextSetupAttempt(T, [run(1, "error")], false, true, false)).toEqual({ attempt: 2 });
    expect(nextSetupAttempt(T, [run(1, "success")], true, true, false)).toEqual({ refused: "draft_done" });
    expect(nextSetupAttempt(T, [run(1, "success")], false, true, false)).toEqual({ attempt: 2 });
  });
  it("after 3 refunded tries: refused unless the page asked for a PAID try, which is tracked", () => {
    const three = [run(3, "error"), run(2, "error"), run(1, "error")];
    expect(nextSetupAttempt(T, three, false, true, false)).toEqual({ refused: "free_attempts_used" });
    expect(nextSetupAttempt(T, three, false, true, true)).toEqual({ attempt: 4, paid: true });
    expect(nextSetupAttempt(T, [run(4, "error"), ...three], false, true, true)).toEqual({ attempt: 5, paid: true });
  });
  it("a successful PAID try makes the draft done: no further retry", () =>
    expect(nextSetupAttempt(T, [run(4, "success"), run(3, "error")], true, true, true)).toEqual({ refused: "draft_done" }));
});
