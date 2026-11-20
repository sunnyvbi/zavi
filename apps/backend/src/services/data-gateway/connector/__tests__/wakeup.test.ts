import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  _deliverForTests,
  _setWakeupDepsForTests,
  _waiterCountForTests,
  ensureWakeupSubscription,
  onRevoke,
  publishRevoke,
  publishWake,
  waitForWake,
  WAKEUP_TOPIC,
} from "../wakeup";
import type { LogEventInput } from "@/services/logging/logEvent";

const T = "11111111-2222-4333-8444-555555555555";

function fakeClient(opts: { subscribeStatus?: string; sendOk?: boolean } = {}) {
  const handlers: Record<string, (m: unknown) => void> = {};
  const sends: unknown[] = [];
  const channelCalls: unknown[] = [];
  const ch = {
    on: (_type: string, filter: { event: string }, fn: (m: unknown) => void) => {
      handlers[filter.event] = fn;
      return ch;
    },
    subscribe: (cb: (s: string) => void) => {
      cb(opts.subscribeStatus ?? "SUBSCRIBED");
      return ch;
    },
    httpSend: async (event: string, payload: unknown) => {
      sends.push({ event, payload });
      return opts.sendOk === false ? { success: false, status: 500, error: "x" } : { success: true };
    },
  };
  const client = { channel: (name: string, cfg: unknown) => (channelCalls.push({ name, cfg }), ch) };
  return { client, handlers, sends, channelCalls };
}

let log: ReturnType<typeof vi.fn<[LogEventInput], Promise<void>>>;
beforeEach(() => {
  log = vi.fn<[LogEventInput], Promise<void>>(async () => undefined);
});

describe("connector wakeups", () => {
  it("joins ONE private topic per process and wakes local polls on a broadcast from another instance", async () => {
    const f = fakeClient();
    _setWakeupDepsForTests({ client: () => f.client as never, log });
    ensureWakeupSubscription();
    ensureWakeupSubscription();
    expect(f.channelCalls).toEqual([{ name: WAKEUP_TOPIC, cfg: { config: { private: true, broadcast: { self: false, ack: false } } } }]);
    const p = waitForWake(T, 10_000);
    expect(_waiterCountForTests(T)).toBe(1);
    f.handlers.wake!({ payload: { tenant_id: T } });
    expect(await p).toBe("wake");
    expect(_waiterCountForTests(T)).toBe(0);
  });
  it("another tenant's wakeup does not wake this poll; the safety timer does", async () => {
    const f = fakeClient();
    _setWakeupDepsForTests({ client: () => f.client as never, log });
    const p = waitForWake(T, 20);
    _deliverForTests("wake", "99999999-2222-4333-8444-555555555555");
    expect(await p).toBe("timeout");
  });
  it("publishWake wakes this instance at once and broadcasts the tenant id only", async () => {
    const f = fakeClient();
    _setWakeupDepsForTests({ client: () => f.client as never, log });
    const p = waitForWake(T, 10_000);
    await publishWake(T);
    expect(await p).toBe("wake");
    expect(f.sends).toEqual([{ event: "wake", payload: { tenant_id: T } }]);
  });
  it("revocations reach listeners locally and over the topic", async () => {
    const f = fakeClient();
    _setWakeupDepsForTests({ client: () => f.client as never, log });
    const seen: string[] = [];
    const off = onRevoke((t) => seen.push(t));
    await publishRevoke(T);
    f.handlers.revoke?.({ payload: { tenant_id: T } });
    ensureWakeupSubscription();
    f.handlers.revoke!({ payload: { tenant_id: T } });
    off();
    expect(seen.filter((t) => t === T).length).toBeGreaterThanOrEqual(2);
    expect(f.sends).toContainEqual({ event: "revoke", payload: { tenant_id: T } });
  });
  it("an abort ends the wait", async () => {
    _setWakeupDepsForTests({ client: () => fakeClient().client as never, log });
    let abort: () => void = () => {};
    const p = waitForWake(T, 10_000, { aborted: false, onAbort: (fn) => void (abort = fn) });
    abort();
    expect(await p).toBe("timeout");
  });
  it("a failed join or send is logged (sampled) and never throws; malformed payloads are ignored", async () => {
    const f = fakeClient({ subscribeStatus: "CHANNEL_ERROR", sendOk: false });
    _setWakeupDepsForTests({ client: () => f.client as never, log });
    ensureWakeupSubscription();
    await publishWake(T);
    await publishWake(T);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatchObject({ code: "connector_wakeup_subscribe_failed" });
    f.handlers.wake!({ payload: { tenant_id: "not-a-uuid" } });
    _setWakeupDepsForTests({ client: () => { throw new Error("no client"); }, log });
    await expect(publishWake(T)).resolves.toBeUndefined();
  });
});
