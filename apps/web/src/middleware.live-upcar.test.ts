
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

describe("/live/upcar is public", () => {
  it.each(["/live/upcar", "/live/upcar-test", "/live/upcar/review/2026-10-03?t=abc", "/live/upcar-test/review/2026-09-28?t=abc"])("does not auth-wall %s", async (path) => {
    const res = await go(path);
    expect(res.headers.get("location"), `${path} redirected`).toBeNull();
    expect(res.status).toBe(200);
  });
});

describe("paths outside /live/ stay gated (unknown runs 404 in the page itself)", () => {
  it.each(["/live", "/liver", "/workspace"])("redirects a signed-out visitor away from %s", async (path) => {
    const res = await go(path);
    expect(res.headers.get("location")).toContain("/login");
  });
});
