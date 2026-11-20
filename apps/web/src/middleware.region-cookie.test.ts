
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

const req = (headers: Record<string, string>) =>
  new NextRequest("http://localhost:3000/pricing", { headers: { "x-forwarded-host": "www.zaviagent.com", ...headers } });

describe("zavi_region cookie", () => {
  it("marks an EU/UK viewer", async () => {
    const res = await middleware(req({ "cloudfront-viewer-country": "DE" }));
    expect(res.cookies.get("zavi_region")?.value).toBe("eu");
    const uk = await middleware(req({ "cloudfront-viewer-country": "GB" }));
    expect(uk.cookies.get("zavi_region")?.value).toBe("eu");
  });

  it("marks everyone else", async () => {
    const res = await middleware(req({ "cloudfront-viewer-country": "US" }));
    expect(res.cookies.get("zavi_region")?.value).toBe("other");
  });

  it("sets nothing without the header, so the browser treats the region as unknown", async () => {
    const res = await middleware(req({}));
    expect(res.cookies.get("zavi_region")).toBeUndefined();
  });

  it("clears an older answer when the header is missing, so the region falls back to unknown", async () => {
    const res = await middleware(req({ cookie: "zavi_region=other" }));
    const c = res.cookies.get("zavi_region");
    expect(c?.value).toBe("");
    expect(c?.maxAge).toBe(0);
  });

  it("stores the viewer country for the growth check", async () => {
    const res = await middleware(req({ "cloudfront-viewer-country": "in" }));
    expect(res.cookies.get("zavi_country")?.value).toBe("IN");
    const same = await middleware(req({ "cloudfront-viewer-country": "IN", cookie: "zavi_country=IN" }));
    expect(same.cookies.get("zavi_country")).toBeUndefined();
    const none = await middleware(req({ "cloudfront-viewer-country": "XX" }));
    expect(none.cookies.get("zavi_country")).toBeUndefined();
  });

  it("clears an older country when the header is missing, so the check does not use a stale one", async () => {
    const res = await middleware(req({ cookie: "zavi_country=IN" }));
    const c = res.cookies.get("zavi_country");
    expect(c?.value).toBe("");
    expect(c?.maxAge).toBe(0);
  });

  it("does not rewrite a cookie that already matches", async () => {
    const res = await middleware(req({ "cloudfront-viewer-country": "FR", cookie: "zavi_region=eu" }));
    expect(res.cookies.get("zavi_region")).toBeUndefined();
  });
});
