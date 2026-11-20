import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { createBrowserClient } = vi.hoisted(() => ({
  createBrowserClient: vi.fn(() => ({ id: Symbol("client") })),
}));
vi.mock("@supabase/ssr", () => ({
  createBrowserClient,
  createServerClient: vi.fn(),
}));

describe("createBrowserSupabase memoization", () => {
  beforeEach(() => {
    createBrowserClient.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
    vi.resetModules();
  });

  afterEach(() => {
    // @ts-expect-error — clean up the simulated browser global.
    delete globalThis.window;
  });

  it("returns the SAME instance across calls in the browser (one refresh actor)", async () => {
    // @ts-expect-error — simulate a browser environment.
    globalThis.window = {};
    const { createBrowserSupabase } = await import("./supabase");

    const a = createBrowserSupabase();
    const b = createBrowserSupabase();

    expect(a).toBe(b);
    expect(createBrowserClient).toHaveBeenCalledTimes(1);
  });

  it("returns a FRESH instance server-side — never memoize when window is undefined", async () => {
    const { createBrowserSupabase } = await import("./supabase");

    const a = createBrowserSupabase();
    const b = createBrowserSupabase();

    expect(a).not.toBe(b);
    expect(createBrowserClient).toHaveBeenCalledTimes(2);
  });
});
