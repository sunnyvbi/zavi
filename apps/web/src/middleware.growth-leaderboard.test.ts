
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

const go = (path: string) => middleware(new NextRequest(`http://localhost:3000${path}`));

describe("/growth is public", () => {
  it.each(["/growth", "/growth?category=saas&country=US&q=shop&limit=100"])("does not auth-wall %s", async (path) => {
    const res = await go(path);
    expect(res.headers.get("location"), `${path} redirected`).toBeNull();
    expect(res.status).toBe(200);
  });
});

describe("paths that merely start with /growth stay gated", () => {
  it.each(["/growthx", "/growth-xyz", "/growth/admin", "/roles"])("redirects a signed-out visitor away from %s", async (path) => {
    const res = await go(path);
    expect(res.headers.get("location")).toContain("/login");
  });
});
