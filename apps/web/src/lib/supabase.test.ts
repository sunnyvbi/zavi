
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createBrowserClientMock = vi.fn(
  (_url: string, _key: string, _opts?: unknown) => ({ __instance: Symbol("browser-client") }),
);
const createServerClientMock = vi.fn(
  (_url: string, _key: string, _opts: unknown) => ({
    __instance: Symbol("server-client"),
  }),
);

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: (url: string, key: string, opts?: unknown) =>
    createBrowserClientMock(url, key, opts),
  createServerClient: (url: string, key: string, opts: unknown) =>
    createServerClientMock(url, key, opts),
}));

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  createBrowserClientMock.mockClear();
});

afterEach(() => {
  vi.resetModules();
  delete (globalThis as { window?: unknown }).window;
});

describe("createBrowserSupabase (browser singleton)", () => {
  it("returns the SAME instance across many calls in the browser", async () => {
    (globalThis as { window?: unknown }).window = {};

    const { createBrowserSupabase } = await import("./supabase");

    const a = createBrowserSupabase();
    const b = createBrowserSupabase();
    const c = createBrowserSupabase();

    expect(createBrowserClientMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("returns FRESH instances per call on the server (no shared auth state)", async () => {
    const { createBrowserSupabase } = await import("./supabase");

    const a = createBrowserSupabase();
    const b = createBrowserSupabase();

    expect(createBrowserClientMock).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
  });
});

describe("bounded requests", () => {
  type Opts = { global?: { fetch?: unknown } };

  it("the browser client passes a bounded global.fetch", async () => {
    (globalThis as { window?: unknown }).window = {};
    const { createBrowserSupabase } = await import("./supabase");
    createBrowserSupabase();
    const opts = createBrowserClientMock.mock.calls[0]?.[2] as Opts | undefined;
    expect(typeof opts?.global?.fetch).toBe("function");
  });

  it("the server client passes a bounded global.fetch", async () => {
    createServerClientMock.mockClear();
    const { createServerSupabase } = await import("./supabase");
    createServerSupabase({ get: () => undefined });
    const opts = createServerClientMock.mock.calls[0]?.[2] as Opts | undefined;
    expect(typeof opts?.global?.fetch).toBe("function");
  });
});
