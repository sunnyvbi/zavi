import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/shopify/app-home framing", () => {
  it("is reachable signed-out as a data-free shell framed only by Shopify", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/shopify/app-home?shop=zavi-test-store.myshopify.com"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors https://admin.shopify.com https://*.myshopify.com");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("x-middleware-request-x-zavi-shopify-app-home")).toBe("1");
  });

  it("does not let a forged shop query change the fixed Shopify frame allowlist", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/shopify/app-home?shop=attacker-store.myshopify.com"));
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors https://admin.shopify.com https://*.myshopify.com");
    const bare = await middleware(new NextRequest("http://localhost:3000/shopify/app-home"));
    expect(bare.headers.get("Content-Security-Policy")).toBe("frame-ancestors https://admin.shopify.com https://*.myshopify.com");
  });

  it("allows only Shopify Admin to frame an explicit development fixture preview", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/shopify/app-home?fixture=paid"));

    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors https://admin.shopify.com https://*.myshopify.com");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });
});
