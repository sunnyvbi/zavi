
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

const REVIEWER_URLS = [
  "/legal/data-deletion",
  "/integrations/google-ads",
  "/privacy",
  "/terms",
  "/shopify/pricing",
];

describe("app-review URLs are reachable signed-out", () => {
  it.each(REVIEWER_URLS)("does not auth-wall %s", async (path) => {
    const res = await middleware(new NextRequest(`http://localhost:3000${path}`));
    const location = res.headers.get("location");
    expect(location, `${path} redirected to ${location}`).toBeNull();
    expect(res.status).toBe(200);
  });
});

const USE_CASE_URLS = ["/use-cases", "/use-cases/saas", "/use-cases/restaurants", "/use-cases/law-firms"];

describe("the connector finish page is reachable signed-out", () => {
  it("does not auth-wall /connectors/finish, whose fragment holds the sign-in code a redirect would lose", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/connectors/finish"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("leaves other connector paths behind sign-in", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/connectors/finish-other"));
    expect(res.headers.get("location")).toContain("/login");
    const sibling = await middleware(new NextRequest("http://localhost:3000/connectors/other"));
    expect(sibling.headers.get("location")).toContain("/login");
  });
});

describe("use-case marketing pages are reachable signed-out", () => {
  it.each(USE_CASE_URLS)("does not auth-wall %s", async (path) => {
    const res = await middleware(new NextRequest(`http://localhost:3000${path}`));
    expect(res.headers.get("location"), `${path} redirected`).toBeNull();
    expect(res.status).toBe(200);
  });
});

describe("the creator landing is reachable signed-out", () => {
  it("does not auth-wall /creators", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/creators"));
    expect(res.headers.get("location"), "/creators redirected").toBeNull();
    expect(res.status).toBe(200);
  });

  it("keeps deeper /creators paths behind sign-in (exact path, not a prefix)", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/creators/ada/packages"));
    expect(res.headers.get("location")).toContain("/login");
  });
});

describe("the tutorials page is reachable signed-out", () => {
  it("does not auth-wall /tutorials", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/tutorials"));
    expect(res.headers.get("location"), "/tutorials redirected").toBeNull();
    expect(res.status).toBe(200);
  });
});

describe("control — default-deny still holds", () => {
  it("redirects a signed-out visitor away from a product surface", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/workspace"));
    expect(res.headers.get("location")).toContain("/login");
  });
});

const COMPARE_URLS = ["/compare/zavi-vs-lovable", "/compare/zavi-vs-meta-muse", "/compare/zavi-vs-grok"];

describe("comparison pages are reachable signed-out", () => {
  it.each(COMPARE_URLS)("does not auth-wall %s", async (path) => {
    const res = await middleware(new NextRequest(`http://localhost:3000${path}`));
    expect(res.headers.get("location"), `${path} redirected`).toBeNull();
    expect(res.status).toBe(200);
  });
});

describe("the blog is reachable signed-out", () => {
  it.each(["/blog", "/blog/free-website-score-checker", "/blog/can-ai-run-my-facebook-ads"])("does not auth-wall %s", async (path) => {
    const res = await middleware(new NextRequest(`http://localhost:3000${path}`));
    expect(res.headers.get("location"), `${path} redirected`).toBeNull();
    expect(res.status).toBe(200);
  });

  it("does not open look-alike paths (/blogger stays behind sign-in)", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/blogger"));
    expect(res.headers.get("location")).toContain("/login");
  });
});
