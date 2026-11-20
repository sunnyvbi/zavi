// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { READINESS_POLL_MS, useAppReadiness } from "./useAppReadiness";

let seq = 0;
const freshSandbox = () => `https://5173-sbx${++seq}${Math.random().toString(36).slice(2, 8)}.e2b.app`;
const answer = (status: number, body?: unknown) => ({ ok: status < 400, status, json: async () => body });

async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  apiFetch.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useAppReadiness — sandbox previews", () => {
  it("a 5xx or a network error keeps polling (waking), it never frames early", async () => {
    const url = freshSandbox();
    apiFetch
      .mockResolvedValueOnce(answer(502))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(answer(200, { state: "ready" }));
    const { result } = renderHook(() => useAppReadiness(url));
    await tick();
    expect(result.current.state).toBe("checking");
    await tick(READINESS_POLL_MS);
    expect(result.current.state).toBe("checking");
    await tick(READINESS_POLL_MS);
    expect(result.current.state).toBe("ready");
  });

  it("a 400 (the server does not know this host) still fails open", async () => {
    const url = freshSandbox();
    apiFetch.mockResolvedValue(answer(400, { error: { code: "bad_url" } }));
    const { result } = renderHook(() => useAppReadiness(url));
    await tick();
    expect(result.current.state).toBe("ready");
  });

  it("ready is not cached for a sandbox origin: a remount probes again", async () => {
    const url = freshSandbox();
    apiFetch.mockResolvedValue(answer(200, { state: "ready" }));
    const first = renderHook(() => useAppReadiness(url));
    await tick();
    expect(first.result.current.state).toBe("ready");
    first.unmount();
    apiFetch.mockResolvedValue(answer(200, { state: "waking" }));
    const second = renderHook(() => useAppReadiness(url));
    await tick();
    expect(second.result.current.state).toBe("checking");
  });
});
