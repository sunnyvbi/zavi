// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { check, useServiceHealth, __resetServiceHealthForTests, RECOVERED_SHOW_MS } from "./serviceHealth";

const ok = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
const down = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
const offline = (async () => {
  throw new TypeError("Failed to fetch");
}) as unknown as typeof fetch;

beforeEach(() => __resetServiceHealthForTests());
afterEach(() => {
  vi.useRealTimers();
});

describe("service health", () => {
  it("stays up while checks pass", async () => {
    expect(await check(ok)).toBe("up");
  });

  it("one failed check does not flash a banner; two do", async () => {
    expect(await check(down)).toBe("up");
    expect(await check(offline)).toBe("down");
  });

  it("goes recovered when it comes back, then up", async () => {
    vi.useFakeTimers();
    await check(down);
    await check(down);
    expect(await check(ok)).toBe("recovered");
    vi.advanceTimersByTime(RECOVERED_SHOW_MS + 1);
    expect(await check(ok)).toBe("up");
  });

  it("a pass resets the failure count", async () => {
    await check(down);
    await check(ok);
    expect(await check(down)).toBe("up");
  });

  it("a renewed outage right after recovery stays down (stale recovery timer is cleared)", async () => {
    vi.useFakeTimers();
    await check(down);
    await check(down);
    expect(await check(ok)).toBe("recovered");
    await check(down);
    expect(await check(down)).toBe("down");
    vi.advanceTimersByTime(RECOVERED_SHOW_MS + 1);
    expect(await check(down)).toBe("down");
  });

  it("reopening the page after an outage seen in an earlier mount never shows 'back' or 'down'", async () => {
    vi.useFakeTimers();
    const bad = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", bad);
    const first = renderHook(() => useServiceHealth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(first.result.current).toBe("down");
    first.unmount();
    const good = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", good);
    const seen: string[] = [];
    const second = renderHook(() => {
      const h = useServiceHealth();
      seen.push(h);
      return h;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(seen).toEqual(["up"]);
    expect(second.result.current).toBe("up");
    second.unmount();
    vi.unstubAllGlobals();
  });
});
