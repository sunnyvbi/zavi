
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CookieMethodsServer } from "@supabase/ssr";

const sb = vi.hoisted(() => ({
  refresh: true,
  user: null as null | { id: string },
  tenant: null as null | string,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, opts: { cookies: CookieMethodsServer }) => ({
    auth: {
      getUser: async () => {
        if (sb.refresh) {
          await opts.cookies.setAll?.(
            [
              { name: "sb-wmyc-auth-token.0", value: "chunk-0-of-someones-session", options: { path: "/", maxAge: 3600 } },
              { name: "sb-wmyc-auth-token.1", value: "chunk-1-of-someones-session", options: { path: "/", maxAge: 3600 } },
            ],
            { "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0", Expires: "0", Pragma: "no-cache" },
          );
        }
        return { data: { user: sb.user }, error: null };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { active_tenant_id: sb.tenant, beta_invited_at: "2026-01-01" },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

import { NextRequest, NextResponse } from "next/server";
import { middleware, noStoreIfSettingCookies } from "@/middleware";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  sb.refresh = true;
  sb.user = { id: "11111111-1111-1111-1111-111111111111" };
  sb.tenant = null;
});

const req = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: { "x-forwarded-host": "www.zaviagent.com", cookie: "sb-wmyc-auth-token=old", ...headers },
  });

function expectNotShareable(res: NextResponse) {
  const cc = res.headers.get("cache-control") ?? "";
  expect(cc).toContain("private");
  expect(cc).toContain("no-store");
  expect(cc).not.toMatch(/s-maxage|public/);
  expect(res.headers.get("cdn-cache-control")).toBe("no-store");
}

describe("middleware: a response carrying an auth Set-Cookie is never shared-cacheable", () => {
  const passThrough = ["/start?step=idea", "/start", "/login", "/creators/apply", "/reset-password", "/privacy", "/api/anything"];
  for (const path of passThrough) {
    it(`pass-through ${path} (signed in, no company yet)`, async () => {
      const res = await middleware(req(path));
      expect(res.headers.get("location")).toBeNull();
      expect(res.cookies.get("sb-wmyc-auth-token.0")?.value).toBe("chunk-0-of-someones-session");
      expectNotShareable(res);
    });
  }

  it("the redirect that carries the refreshed session (onboarded user on /login)", async () => {
    sb.tenant = "22222222-2222-2222-2222-222222222222";
    const res = await middleware(req("/login"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/workspace");
    expect(res.cookies.get("sb-wmyc-auth-token.1")?.value).toBe("chunk-1-of-someones-session");
    expectNotShareable(res);
  });

  it("the redirect to /login for a signed-out visitor whose cookies were cleared", async () => {
    sb.user = null;
    const res = await middleware(req("/workspace"));
    expect(res.headers.get("location")).toContain("/login?next=");
    expectNotShareable(res);
  });

  it("a response that sets only the region cookie (anonymous visitor)", async () => {
    sb.refresh = false;
    sb.user = null;
    const res = await middleware(
      new NextRequest("http://localhost:3000/start", {
        headers: { "x-forwarded-host": "www.zaviagent.com", "cloudfront-viewer-country": "DE" },
      }),
    );
    expect(res.cookies.get("zavi_region")?.value).toBe("eu");
    expectNotShareable(res);
  });

  it("leaves a response that sets no cookie alone", async () => {
    sb.refresh = false;
    sb.user = null;
    const res = await middleware(
      new NextRequest("http://localhost:3000/start", { headers: { "x-forwarded-host": "www.zaviagent.com" } }),
    );
    expect(res.cookies.getAll()).toEqual([]);
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("noStoreIfSettingCookies", () => {
  it("marks a cookie-setting response private and no-store", () => {
    const res = NextResponse.next();
    res.cookies.set("anything", "x");
    expectNotShareable(noStoreIfSettingCookies(res));
  });

  it("marks a cookie-clearing response too (an empty value is still a Set-Cookie)", () => {
    const res = NextResponse.redirect("http://localhost:3000/login");
    res.cookies.set("sb-wmyc-auth-token", "", { maxAge: 0 });
    expectNotShareable(noStoreIfSettingCookies(res));
  });
});
