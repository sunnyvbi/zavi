import { describe, it, expect, vi } from "vitest";
import { awaitResult, cancel, complete, enqueue, claimNext } from "../queue";

describe("connector queue", () => {
  it("every call is scoped to the tenant argument", async () => {
    const rpc = vi.fn(async () => ({ data: "req-1", error: null }));
    const wake = vi.fn(async () => undefined);
    await enqueue("tenant-A", { op: "describe" }, 5, 60, { rpc: rpc as never, wake });
    expect(rpc).toHaveBeenCalledWith("tenant-A", "enqueue_db_connector_request", { p_op: { op: "describe" }, p_ttl_seconds: 60, p_generation: 5 });
    expect(wake).toHaveBeenCalledWith("tenant-A");
  });
  it("a full queue is connector_busy (backpressure), other errors are unavailable", async () => {
    await expect(enqueue("t", { op: "describe" }, 5, 60, { rpc: (async () => ({ data: null, error: { code: "ZD429" } })) as never })).rejects.toMatchObject({ code: "connector_busy" });
    await expect(enqueue("t", { op: "describe" }, 5, 60, { rpc: (async () => ({ data: null, error: { code: "XX" } })) as never })).rejects.toMatchObject({ code: "connector_queue_unavailable" });
    await expect(enqueue("t", { op: "describe" }, 5, 60, { rpc: (async () => ({ data: null, error: { code: "ZD412" } })) as never })).rejects.toMatchObject({ code: "db_source_changed" });
  });
  it("awaitResult polls fast first, then slower, and returns the finished row", async () => {
    let n = 0;
    let t = 0;
    const sleeps: number[] = [];
    const rpc = vi.fn(async () => ({ data: ++n < 15 ? [] : [{ status: "done", result: { ok: 1 }, reason: null }], error: null }));
    const out = await awaitResult("t", "r", { timeoutMs: 45_000 }, { rpc: rpc as never, now: () => t, sleep: async (ms) => void (sleeps.push(ms), (t += ms)) });
    expect(out).toEqual({ status: "done", result: { ok: 1 }, reason: null });
    expect(sleeps[0]).toBe(250);
    expect(sleeps.at(-1)).toBe(500);
  });
  it("timeout cancels the request so the connector never runs it late", async () => {
    let t = 0;
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    expect(await awaitResult("t", "r", { timeoutMs: 1000 }, { rpc: rpc as never, now: () => t, sleep: async (ms) => void (t += ms) })).toBe("timeout");
    expect(rpc).toHaveBeenLastCalledWith("t", "cancel_db_connector_request", { p_request_id: "r" });
  });
  it("no connector -> null and nobody is woken", async () => {
    const wake = vi.fn(async () => undefined);
    expect(await enqueue("t", { op: "describe" }, 5, 60, { rpc: (async () => ({ data: null, error: null })) as never, wake })).toBeNull();
    expect(wake).not.toHaveBeenCalled();
  });
  it("cancel checks the RPC error, retries once, then logs; never throws", async () => {
    const log = vi.fn(async () => undefined);
    const failing = vi.fn(async () => ({ data: null, error: { message: "down" } }));
    expect(await cancel("t", "r", { rpc: failing as never, log })).toBe(false);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ code: "connector_cancel_failed", level: "error" }));
    let n = 0;
    const flaky = vi.fn(async () => (++n === 1 ? { data: null, error: { message: "blip" } } : { data: true, error: null }));
    expect(await cancel("t", "r", { rpc: flaky as never, log })).toBe(true);
  });
  it("complete maps outcomes; anything unknown is stale", async () => {
    for (const [data, want] of [["accepted", "accepted"], ["duplicate", "duplicate"], ["stale", "stale"], ["source_changed", "source_changed"], [null, "stale"]] as const) {
      expect(await complete("t", "c", "r", "e", "done", {}, null, { generation: 3, source_instance_id: null }, { rpc: (async () => ({ data, error: null })) as never })).toBe(want);
    }
    const rpc = vi.fn(async () => ({ data: "accepted", error: null }));
    await complete("t", "c", "r", "e", "done", {}, null, { generation: 3, source_instance_id: "a".repeat(32) }, { rpc: rpc as never });
    expect(rpc).toHaveBeenCalledWith("t", "complete_db_connector_request", expect.objectContaining({ p_generation: 3, p_source_instance_id: "a".repeat(32) }));
  });
  it("claimNext returns the delivery or null", async () => {
    expect(await claimNext("t", "c", { rpc: (async () => ({ data: [], error: null })) as never })).toBeNull();
    expect(await claimNext("t", "c", { rpc: (async () => ({ data: [{ id: "r", execution_token: "e", op: {} }], error: null })) as never })).toEqual({ id: "r", execution_token: "e", op: {}, generation: null });
    expect(await claimNext("t", "c", { rpc: (async () => ({ data: [{ id: "r", execution_token: "e", op: {}, generation: "9" }], error: null })) as never })).toMatchObject({ generation: 9 });
  });
});
