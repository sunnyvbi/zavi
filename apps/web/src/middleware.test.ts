
import { describe, it, expect, vi, beforeEach } from "vitest";

const CHUNKED = [
  { name: "sb-wmyc-auth-token.0", value: "CHUNK0", options: { path: "/" } },
  { name: "sb-wmyc-auth-token.1", value: "CHUNK1", options: { path: "/" } },
];

const state = vi.hoisted(() => ({ hang: false, throws: false, netError: false }));

vi.mock("@supabase/ssr", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createServerClient: (_url: string, _key: string, opts: any) => ({
    auth: {
      getUser: async () => {
        if (state.hang) await new Promise(() => {});
        if (state.throws) throw new Error("getUser exploded");
        if (state.netError) {
          const { AuthRetryableFetchError } = await import("@supabase/supabase-js");
          return { data: { user: null }, error: new AuthRetryableFetchError("fetch failed", 0) };
        }
        opts.cookies.setAll(CHUNKED);
        return { data: { user: null }, error: null };
      },
    },
  }),
}));

import { middleware } from "@/middleware";
import { NextRequest } from "next/server";
import { plainNext } from "@/lib/safe-next";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  state.hang = false;
  state.throws = false;
  state.netError = false;
});

describe("middleware — chunked refresh cookies (signout regression)", () => {
  it("persists ALL chunks of a refreshed session onto the response, not just the last", async () => {
    const req = new NextRequest("http://localhost:3000/login");
    const res = await middleware(req);
    expect(res.cookies.get("sb-wmyc-auth-token.0")?.value).toBe("CHUNK0");
    expect(res.cookies.get("sb-wmyc-auth-token.1")?.value).toBe("CHUNK1");
  });
});

describe("middleware — an auth timeout is not a sign-out", () => {
  const withCookie = (url: string) =>
    new NextRequest(url, {
      headers: { cookie: "sb-wmyc-auth-token.0=CHUNK0; sb-wmyc-auth-token.1=CHUNK1" },
    });

  async function runWhileHung(req: NextRequest) {
    vi.useFakeTimers();
    try {
      const p = middleware(req);
      await vi.advanceTimersByTimeAsync(6001);
      return await p;
    } finally {
      vi.useRealTimers();
    }
  }

  it("passes a cookie-bearing request through when the auth server never answers", async () => {
    state.hang = true;
    const res = await runWhileHung(withCookie("http://localhost:3000/workspace"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("still redirects an anonymous visitor (no session cookie) on a timeout", async () => {
    state.hang = true;
    const res = await runWhileHung(
      new NextRequest("http://localhost:3000/workspace"),
    );
    expect(res.headers.get("location")).toContain("/login");
  });

  it("still redirects when the auth server DOES answer and says no user", async () => {
    const res = await middleware(withCookie("http://localhost:3000/workspace"));
    expect(res.headers.get("location")).toContain("/login");
  });

  it("ignores a session cookie minted for a DIFFERENT Supabase project", async () => {
    state.hang = true;
    const req = new NextRequest("http://localhost:3000/workspace", {
      headers: { cookie: "sb-someoneelse-auth-token.0=CHUNK0" },
    });
    const res = await runWhileHung(req);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("keeps /signup on the create-account redirect during a timeout", async () => {
    state.hang = true;
    const res = await runWhileHung(withCookie("http://localhost:3000/signup"));
    expect(res.headers.get("location")).toContain("signup=1");
  });

  it("passes a cookie-bearing request through when the auth server returns a network error", async () => {
    state.netError = true;
    const res = await middleware(withCookie("http://localhost:3000/workspace"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("still redirects an anonymous visitor on a network error", async () => {
    state.netError = true;
    const res = await middleware(new NextRequest("http://localhost:3000/workspace"));
    expect(res.headers.get("location")).toContain("/login");
  });

  it("still redirects when getUser THROWS, even with a session cookie", async () => {
    state.throws = true;
    const res = await middleware(withCookie("http://localhost:3000/workspace"));
    expect(res.headers.get("location")).toContain("/login");
  });
});

describe("middleware: signed-out mute link keeps its query through login", () => {
  it("puts company and mute_alert into next, and plainNext keeps them", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/workspace?company=t1&mute_alert=net_revenue"));
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.pathname).toBe("/login");
    const next = loc.searchParams.get("next");
    expect(next).toBe("/workspace?company=t1&mute_alert=net_revenue");
    expect(plainNext(next)).toBe("/workspace?company=t1&mute_alert=net_revenue");
  });

  it("still refuses an external or protocol-relative next with the same query", () => {
    expect(plainNext("https://evil.com/workspace?company=t1&mute_alert=x")).toBeNull();
    expect(plainNext("//evil.com/workspace?mute_alert=x")).toBeNull();
    expect(plainNext("/\\evil.com/workspace?mute_alert=x")).toBeNull();
  });
});

describe("plan-ready email click attribution", () => {
  it("keeps the tagged workspace path through login and its safe-next validation", async () => {
    const path = "/workspace?tab=growth-strategy&company=t1&utm_source=email&utm_medium=zavi&utm_campaign=plan_ready";
    const res = await middleware(new NextRequest(`http://localhost:3000${path}`));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe(path);
    expect(plainNext(loc.searchParams.get("next"))).toBe(path);
  });
});
