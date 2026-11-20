
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  logEventMock: vi.fn(),
}));

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: mocks.logEventMock,
  LOG_META_KEYS: [],
}));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));

import { expireWaiverBatch } from "../autopilot-waiver-expire";

const ROW = (i: number) => ({
  tenant_id: `t-${i}`,
  decision_class: "send_email",
  waiver_expires_at: "2026-05-29T00:00:00Z",
});

beforeEach(() => {
  mocks.logEventMock.mockReset();
  mocks.logEventMock.mockResolvedValue(undefined);
});

describe("expireWaiverBatch", () => {
  it("empty batch → zeroed result, no I/O", async () => {
    const revoke = vi.fn();
    const r = await expireWaiverBatch([], revoke);
    expect(r).toEqual({ scanned: 0, revoked: 0, idempotent_noop: 0, failed: 0 });
    expect(revoke).not.toHaveBeenCalled();
    expect(mocks.logEventMock).not.toHaveBeenCalled();
  });

  it("happy path: every row had a waiver → all counted as revoked", async () => {
    const revoke = vi.fn(async () => ({ ok: true, had_waiver: true }));
    const r = await expireWaiverBatch([ROW(1), ROW(2), ROW(3)], revoke);
    expect(r).toEqual({ scanned: 3, revoked: 3, idempotent_noop: 0, failed: 0 });
    expect(revoke).toHaveBeenCalledTimes(3);
    expect(revoke).toHaveBeenNthCalledWith(1, "t-1", "send_email");
    expect(mocks.logEventMock).not.toHaveBeenCalled();
  });

  it("idempotent: rows whose waiver was already cleared count as noop, not failed", async () => {
    const revoke = vi.fn(async () => ({ ok: true, had_waiver: false }));
    const r = await expireWaiverBatch([ROW(1), ROW(2)], revoke);
    expect(r).toEqual({ scanned: 2, revoked: 0, idempotent_noop: 2, failed: 0 });
    expect(mocks.logEventMock).not.toHaveBeenCalled();
  });

  it("per-row failure does not block the rest of the batch + logs warn", async () => {
    const revoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, had_waiver: true })
      .mockResolvedValueOnce({ ok: false, had_waiver: false, error: "rpc boom" })
      .mockResolvedValueOnce({ ok: true, had_waiver: true });
    const r = await expireWaiverBatch([ROW(1), ROW(2), ROW(3)], revoke);
    expect(r).toEqual({ scanned: 3, revoked: 2, idempotent_noop: 0, failed: 1 });
    expect(revoke).toHaveBeenCalledTimes(3);
    expect(mocks.logEventMock).toHaveBeenCalledTimes(1);
    const logged = mocks.logEventMock.mock.calls[0][0];
    expect(logged.level).toBe("warn");
    expect(logged.code).toBe("autopilot_waiver_revoke_failed");
    expect(logged.tenant_id).toBe("t-2");
    expect(logged.message).toMatch(/rpc boom/);
  });

  it("mixed happy + noop + fail → all three counters populate independently", async () => {
    const revoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, had_waiver: true })
      .mockResolvedValueOnce({ ok: true, had_waiver: false })
      .mockResolvedValueOnce({ ok: false, had_waiver: false, error: "x" })
      .mockResolvedValueOnce({ ok: true, had_waiver: true })
      .mockResolvedValueOnce({ ok: true, had_waiver: false });
    const r = await expireWaiverBatch(
      [ROW(1), ROW(2), ROW(3), ROW(4), ROW(5)],
      revoke,
    );
    expect(r).toEqual({ scanned: 5, revoked: 2, idempotent_noop: 2, failed: 1 });
  });
});
