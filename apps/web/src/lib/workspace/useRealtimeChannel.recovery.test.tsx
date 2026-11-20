// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const mock = vi.hoisted(() => ({
  channel: vi.fn(),
  removeChannel: vi.fn(),
  realtime: { accessTokenValue: "token-1" as string | null },
  ready: { promise: Promise.resolve(), resolve: () => {} },
}));
vi.mock("@/lib/realtimeAuth", () => ({
  getBrowserSupabaseSingleton: () => mock,
  realtimeAuthReady: () => mock.ready.promise,
}));
import { auditRealtimeChannels, useRealtimeChannel } from "./useRealtimeChannel";

type FakeChannel = {
  on(name: string, filter: unknown, callback: (payload: { new: unknown }) => void): FakeChannel;
  subscribe: Mock<[callback: (value: string) => void], FakeChannel>;
  status(value: string): void;
  emit(row: unknown): void;
};

function channel() {
  let status: (value: string) => void = () => {};
  let event: (payload: { new: unknown }) => void = () => {};
  const result: FakeChannel = {
    on: vi.fn((_name: string, _filter: unknown, callback: typeof event) => { event = callback; return result; }),
    subscribe: vi.fn((callback: typeof status) => { status = callback; return result; }),
    status: (value: string) => status(value),
    emit: (row: unknown) => event({ new: row }),
  };
  return result;
}

const channelAt = (i: number) => mock.channel.mock.results[i].value as FakeChannel;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function gateAuth() {
  let resolve!: () => void;
  mock.ready.promise = new Promise<void>((r) => { resolve = r; });
  mock.ready.resolve = resolve;
}

beforeEach(() => {
  vi.useFakeTimers();
  mock.channel.mockReset().mockImplementation(channel);
  mock.removeChannel.mockReset().mockImplementation((c: FakeChannel) => c.status("CLOSED"));
  mock.realtime.accessTokenValue = "token-1";
  mock.ready.promise = Promise.resolve();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("realtime channel joins only with the session token", () => {
  it("does not subscribe until the socket holds the token", async () => {
    gateAuth();
    renderHook(() => useRealtimeChannel({ table: "thread_event", scopeKey: "agent_slug:op", onInsert: vi.fn() }));
    await flush();
    expect(mock.channel).toHaveBeenCalledTimes(1);
    expect(channelAt(0).subscribe).not.toHaveBeenCalled();
    mock.ready.resolve();
    await flush();
    expect(channelAt(0).subscribe).toHaveBeenCalledTimes(1);
  });

  it("never subscribes a channel whose last consumer left before the token arrived", async () => {
    gateAuth();
    const h = renderHook(() => useRealtimeChannel({ table: "t", scopeKey: "s", onInsert: vi.fn() }));
    h.unmount();
    mock.ready.resolve();
    await flush();
    expect(channelAt(0).subscribe).not.toHaveBeenCalled();
    expect(mock.removeChannel).toHaveBeenCalledTimes(1);
    expect(auditRealtimeChannels().count).toBe(0);
  });

  it("rejoins on a fresh channel when the token changed during the join", async () => {
    const joined = vi.fn();
    renderHook(() => useRealtimeChannel({ table: "t", scopeKey: "s", onInsert: vi.fn(), onSubscribed: joined }));
    await flush();
    mock.realtime.accessTokenValue = "token-2";
    act(() => channelAt(0).status("SUBSCRIBED"));
    expect(joined).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(0));
    await flush();
    expect(mock.removeChannel).toHaveBeenCalledWith(channelAt(0));
    expect(channelAt(1).subscribe).toHaveBeenCalledTimes(1);
    act(() => channelAt(1).status("SUBSCRIBED"));
    expect(joined).toHaveBeenCalledTimes(1);
  });
});

describe("shared realtime recovery", () => {
  it("shares one channel, tells every consumer about the join, and cleans up each consumer", async () => {
    const first = vi.fn(), second = vi.fn(), late = vi.fn(), row = vi.fn();
    const base = { table: "agent_run_stream_drafts", scopeKey: "run:r", event: "*" as const, onInsert: row };
    const a = renderHook(() => useRealtimeChannel({ ...base, onSubscribed: first }));
    const b = renderHook(() => useRealtimeChannel({ ...base, onSubscribed: second }));
    await flush();
    expect(mock.channel).toHaveBeenCalledTimes(1);
    act(() => channelAt(0).status("SUBSCRIBED"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    const c = renderHook(() => useRealtimeChannel({ ...base, onSubscribed: late }));
    expect(late).toHaveBeenCalledTimes(1);
    act(() => channelAt(0).emit({ seq: 2 }));
    expect(row).toHaveBeenCalledTimes(3);
    a.unmount();
    c.unmount();
    expect(mock.removeChannel).not.toHaveBeenCalled();
    b.unmount();
    expect(mock.removeChannel).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(60_000));
    expect(mock.channel).toHaveBeenCalledTimes(1);
    expect(auditRealtimeChannels().count).toBe(0);
  });

  it("replaces a closed channel with a new one instead of re-subscribing the dead object", async () => {
    const row = vi.fn(), joined = vi.fn();
    renderHook(() => useRealtimeChannel({ table: "t", scopeKey: "s", onInsert: row, onSubscribed: joined }));
    await flush();
    const old = channelAt(0);
    act(() => old.status("SUBSCRIBED"));
    act(() => old.status("CLOSED"));
    act(() => vi.advanceTimersByTime(2000));
    await flush();
    expect(old.subscribe).toHaveBeenCalledTimes(1);
    const fresh = channelAt(1);
    expect(fresh.subscribe).toHaveBeenCalledTimes(1);
    act(() => fresh.status("SUBSCRIBED"));
    expect(joined).toHaveBeenCalledTimes(2);
    act(() => fresh.emit({ id: 1 }));
    expect(row).toHaveBeenCalledTimes(1);
  });

  it("leaves an errored channel to the library's own rejoin, and replaces it only if that fails", async () => {
    renderHook(() => useRealtimeChannel({ table: "t", scopeKey: "s", onInsert: vi.fn() }));
    await flush();
    act(() => channelAt(0).status("CHANNEL_ERROR"));
    act(() => channelAt(0).status("SUBSCRIBED"));
    act(() => vi.advanceTimersByTime(30_000));
    expect(mock.channel).toHaveBeenCalledTimes(1);

    act(() => channelAt(0).status("TIMED_OUT"));
    act(() => vi.advanceTimersByTime(2000));
    act(() => vi.runOnlyPendingTimers());
    await flush();
    expect(mock.channel).toHaveBeenCalledTimes(2);
    expect(channelAt(1).subscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying with a capped backoff while someone is listening", async () => {
    renderHook(() => useRealtimeChannel({ table: "t", scopeKey: "s", onInsert: vi.fn() }));
    await flush();
    for (let i = 0; i < 6; i++) {
      act(() => channelAt(i).status("CLOSED"));
      act(() => vi.advanceTimersByTime(30_000));
      await flush();
    }
    expect(mock.channel).toHaveBeenCalledTimes(7);
  });

  it("does not revive an old channel when the same run is remounted", async () => {
    const opts = { table: "drafts", scopeKey: "run:r", onInsert: vi.fn() };
    const first = renderHook(() => useRealtimeChannel(opts));
    await flush();
    const old = channelAt(0);
    act(() => old.status("CLOSED"));
    first.unmount();
    renderHook(() => useRealtimeChannel(opts));
    await flush();
    act(() => vi.advanceTimersByTime(30_000));
    expect(old.subscribe).toHaveBeenCalledTimes(1);
    expect(mock.channel).toHaveBeenCalledTimes(2);
    expect(channelAt(1).subscribe).toHaveBeenCalledTimes(1);
  });
});
