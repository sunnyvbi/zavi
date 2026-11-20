import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
const limit = vi.hoisted(() => vi.fn());
vi.mock("../supabase", () => ({
  serviceClient: () => ({
    rpc: (...a: unknown[]) => ({ abortSignal: () => rpc(...a) }),
    from: () => ({ select: () => ({ limit: () => ({ abortSignal: () => limit() }) }) }),
  }),
}));

import { checkSchemaInvariants, checkDbReachable, _resetSchemaInvariantCache } from "../dbInvariants";

beforeEach(() => {
  rpc.mockReset();
  limit.mockReset();
  _resetSchemaInvariantCache();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("health checks are bounded and honest", () => {
  it("an RPC error reports not ok with the reason", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "database request timed out after 3000ms" } });
    const r = await checkSchemaInvariants();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/timed out/);
  });

  it("a failure is re-checked after 10s, not held for 60s", async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    await checkSchemaInvariants();
    rpc.mockResolvedValueOnce({ data: true, error: null });
    vi.advanceTimersByTime(11_000);
    expect((await checkSchemaInvariants()).ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("a success is still held for 60s", async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValue({ data: true, error: null });
    await checkSchemaInvariants();
    vi.advanceTimersByTime(30_000);
    await checkSchemaInvariants();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("checkDbReachable reports up", async () => {
    limit.mockResolvedValueOnce({ data: [{ id: "t" }], error: null });
    expect(await checkDbReachable()).toEqual({ db: "up" });
  });

  it("checkDbReachable reports down on an error or a throw, never throwing", async () => {
    limit.mockResolvedValueOnce({ data: null, error: { message: "fetch failed" } });
    expect((await checkDbReachable()).db).toBe("down");
    _resetSchemaInvariantCache();
    limit.mockRejectedValueOnce(new Error("aborted"));
    expect((await checkDbReachable()).db).toBe("down");
  });
});
