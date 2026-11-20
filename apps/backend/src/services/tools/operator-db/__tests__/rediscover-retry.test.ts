import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("@/../workers/client", () => ({ inngest: { send: (...a: unknown[]) => send(...a) } }));

import { maybeRediscoverCatalog, rediscoveryRequestedRecently, __resetRediscoverInflight } from "../discovery/retry";

const ready = {
  dialect: "mongodb",
  catalog: { tables: [{ name: "users" }] },
  hints: {},
  discovery_error: null,
  updated_at: new Date().toISOString(),
};
const staleFailed = {
  dialect: "mongodb",
  catalog: { tables: [] },
  hints: {},
  discovery_error: "ETIMEDOUT",
  updated_at: new Date(Date.now() - 20 * 60_000).toISOString(),
};
const freshFailed = { ...staleFailed, updated_at: new Date().toISOString() };

beforeEach(() => {
  vi.clearAllMocks();
  __resetRediscoverInflight();
});

describe("maybeRediscoverCatalog (enqueue model)", () => {
  it("already-ready catalog → no enqueue, returns it unchanged", async () => {
    const r = await maybeRediscoverCatalog("t1", ready as never);
    expect(send).not.toHaveBeenCalled();
    expect(r).toBe(ready);
  });

  it("stale not-ready → enqueues ONE discovery job, returns current (not healed inline)", async () => {
    const r = await maybeRediscoverCatalog("t1", staleFailed as never);
    expect(send).toHaveBeenCalledOnce();
    const arg = send.mock.calls[0][0] as { name: string; data: { tenant_id: string }; id: string };
    expect(arg.name).toBe("operator-db.discover.requested");
    expect(arg.data.tenant_id).toBe("t1");
    expect(arg.id).toMatch(/^operator-db-discover:t1:\d+$/);
    expect(r).toBe(staleFailed);
  });

  it("null catalog (never discovered) → eligible → enqueues, returns null", async () => {
    const r = await maybeRediscoverCatalog("t1", null);
    expect(send).toHaveBeenCalledOnce();
    expect(r).toBeNull();
  });

  it("fresh failure within cooldown → does NOT enqueue", async () => {
    const r = await maybeRediscoverCatalog("t1", freshFailed as never);
    expect(send).not.toHaveBeenCalled();
    expect(r).toBe(freshFailed);
  });

  it("burst of concurrent reads → enqueues only ONCE (in-process dedup)", async () => {
    const [r1, r2, r3] = await Promise.all([
      maybeRediscoverCatalog("t1", staleFailed as never),
      maybeRediscoverCatalog("t1", staleFailed as never),
      maybeRediscoverCatalog("t1", staleFailed as never),
    ]);
    expect(send).toHaveBeenCalledOnce();
    expect(r1).toBe(staleFailed);
    expect(r2).toBe(staleFailed);
    expect(r3).toBe(staleFailed);
  });

  it("different tenants each enqueue independently", async () => {
    await maybeRediscoverCatalog("t1", staleFailed as never);
    await maybeRediscoverCatalog("t2", staleFailed as never);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("enqueue failure is swallowed (best-effort) and clears the dedup marker", async () => {
    send.mockRejectedValueOnce(new Error("inngest down"));
    const r = await maybeRediscoverCatalog("t1", staleFailed as never);
    expect(r).toBe(staleFailed);
    await maybeRediscoverCatalog("t1", staleFailed as never);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("rediscoveryRequestedRecently", () => {
  it("is true right after this process enqueued a rediscovery, false for other tenants and after the window", async () => {
    __resetRediscoverInflight();
    expect(rediscoveryRequestedRecently("t1")).toBe(false);
    await maybeRediscoverCatalog("t1", staleFailed as never);
    expect(rediscoveryRequestedRecently("t1")).toBe(true);
    expect(rediscoveryRequestedRecently("t2")).toBe(false);
    expect(rediscoveryRequestedRecently("t1", Date.now() + 6 * 60 * 1000)).toBe(false);
  });
});
