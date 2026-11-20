
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}));

import { middleware } from "@/middleware";
import { NextRequest } from "next/server";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
});

const req = (url: string, forwardedHost: string) =>
  new NextRequest(url, { headers: { "x-forwarded-host": forwardedHost } });

describe("retired segment subdomains 301 to www", () => {
  it.each(["marketplaces", "solo", "growth", "saas", "startup"])(
    "%s.zaviagent.com 301s to www, keeping path and query",
    async (sub) => {
      const res = await middleware(
        req("http://localhost:3000/pricing?utm_source=x", `${sub}.zaviagent.com`),
      );
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(
        "https://www.zaviagent.com/pricing?utm_source=x",
      );
    },
  );

  it("the bare root redirects too", async () => {
    const res = await middleware(req("http://localhost:3000/", "marketplaces.zaviagent.com"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://www.zaviagent.com/");
  });

  it("www is not redirected", async () => {
    const res = await middleware(req("http://localhost:3000/", "www.zaviagent.com"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a preview host whose first label is a retired name is not redirected", async () => {
    const res = await middleware(req("http://localhost:3000/", "growth.d1abc.amplifyapp.com"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("a double-slash path stays on www", async () => {
    const res = await middleware(req("http://localhost:3000//evil.com/x", "solo.zaviagent.com"));
    expect(res.status).toBe(301);
    expect(new URL(res.headers.get("location")!).origin).toBe("https://www.zaviagent.com");
  });
});
