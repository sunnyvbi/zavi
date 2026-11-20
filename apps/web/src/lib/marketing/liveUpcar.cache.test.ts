import { describe, it, expect, vi } from "vitest";

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    cache: <A extends unknown[], R>(fn: (...a: A) => R) => {
      const m = new Map<string, R>();
      return (...a: A) => {
        const k = JSON.stringify(a);
        if (!m.has(k)) m.set(k, fn(...a));
        return m.get(k)!;
      };
    },
  };
});

import { getLiveUpcar } from "./liveUpcar";

describe("getLiveUpcar", () => {
  it("is memoized per arguments and passes its timeout to fetch", async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.n++;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ run: { slug: "upcar", listed: true }, locked: true, days: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const [a, b] = await Promise.all([getLiveUpcar("upcar"), getLiveUpcar("upcar", false)]);
    expect(a).toBe(b);
    expect(calls.n).toBe(1);
    expect(await getLiveUpcar("nope-404-slug-x")).not.toBeUndefined();
    vi.unstubAllGlobals();
  });
  it("a backend that never answers ends as null (unavailable), not a hang", async () => {
    vi.stubGlobal("fetch", (_u: string, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))));
    expect(await getLiveUpcar("upcar-hang", false, 20)).toBeNull();
    vi.unstubAllGlobals();
  });
});
