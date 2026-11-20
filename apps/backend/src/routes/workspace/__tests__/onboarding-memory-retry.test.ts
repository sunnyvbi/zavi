
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ user_id: "u1", tenant_id: "t1", access_token: "tok" })),
}));
const spend = vi.fn(async () => ({ ok: true }) as { ok: boolean });
const tick = vi.fn(async (_u: string) => true);
vi.mock("@/services/onboarding/scan", () => ({
  scanSpendAllowed: () => spend(),
  tickPerUserLimit: (u: string) => tick(u),
}));
const member = vi.fn(async (..._a: unknown[]) => true);
const row = vi.fn(async (_t: string) => null as null | Record<string, unknown>);
const reset = vi.fn(async (..._a: unknown[]) => 2 as number | null);
const markFailed = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/services/onboarding/background-memory", () => ({
  MEMORY_REQUESTED_EVENT: "tenant/onboarding.memory.requested",
  isTenantMember: (...a: unknown[]) => member(...a),
  readMemoryRow: (t: string) => row(t),
  resetMemoryForRetry: (...a: unknown[]) => reset(...a),
  markMemoryFailed: (...a: unknown[]) => markFailed(...a),
}));
const send = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/../workers/client", () => ({ inngest: { send: (...a: unknown[]) => send(...a) } }));

import { onboardingMemoryRetry } from "../onboarding-memory-retry";

function call() {
  const json = vi.fn();
  const status = vi.fn();
  const r = { json, status } as unknown as Response;
  status.mockReturnValue(r);
  return onboardingMemoryRetry({ body: { tenant_id: "other" } } as unknown as Request, r).then(() => ({ json, status }));
}
const failedRow = { tenant_id: "t1", user_id: "u1", status: "failed", attempt: 1, host: "acme.com" };

beforeEach(() => {
  member.mockResolvedValue(true);
  row.mockResolvedValue(failedRow);
  reset.mockReset();
  reset.mockResolvedValue(2);
  spend.mockResolvedValue({ ok: true });
  tick.mockResolvedValue(true);
  send.mockReset();
  send.mockResolvedValue(undefined);
});

describe("onboarding memory retry", () => {
  it("202 and sends the job for the JWT tenant with the new attempt", async () => {
    const { status } = await call();
    expect(status).toHaveBeenCalledWith(202);
    expect(row).toHaveBeenCalledWith("t1");
    expect(send).toHaveBeenCalledWith({ name: "tenant/onboarding.memory.requested", data: { tenant_id: "t1", attempt: 2 } });
  });

  it("409 when there is no job row or it is not failed", async () => {
    row.mockResolvedValueOnce(null);
    expect((await call()).status).toHaveBeenCalledWith(409);
    row.mockResolvedValueOnce({ ...failedRow, status: "pending" });
    expect((await call()).status).toHaveBeenCalledWith(409);
    expect(send).not.toHaveBeenCalled();
  });

  it("409 when another retry won the reset", async () => {
    reset.mockResolvedValueOnce(null);
    expect((await call()).status).toHaveBeenCalledWith(409);
    expect(send).not.toHaveBeenCalled();
  });

  it("429 when the spend switches are off or the per-user budget is spent", async () => {
    spend.mockResolvedValueOnce({ ok: false });
    expect((await call()).status).toHaveBeenCalledWith(429);
    tick.mockResolvedValueOnce(false);
    expect((await call()).status).toHaveBeenCalledWith(429);
    expect(reset).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("403 for a non-member", async () => {
    member.mockResolvedValueOnce(false);
    expect((await call()).status).toHaveBeenCalledWith(403);
  });

  it("an enqueue failure puts the row back to failed", async () => {
    send.mockRejectedValueOnce(new Error("down"));
    const { status } = await call();
    expect(status).toHaveBeenCalledWith(500);
    expect(markFailed).toHaveBeenCalledWith("t1", expect.stringContaining("enqueue failed"));
  });
});
