
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetUser = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: mockGetUser },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  }),
}));

import { middleware } from "@/middleware";
import { NextRequest } from "next/server";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
});

const run = (path: string) =>
  middleware(new NextRequest(`http://localhost:3000${path}`));

describe("/humans/apply is reachable signed-out", () => {
  it("does not auth-wall /humans/apply", async () => {
    const res = await run("/humans/apply");
    const location = res.headers.get("location");
    expect(location, `/humans/apply redirected to ${location}`).toBeNull();
    expect(res.status).toBe(200);
  });

  it("does not auth-wall a nested path under /humans/apply/", async () => {
    const res = await run("/humans/apply/status");
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });
});

describe("the rest of /human stays tenant-authed", () => {
  it.each([
    "/humans",
    "/humans/briefs",
    "/humans/briefs/brief_7f21/matches",
    "/humans/engagements/eng_4c8e21",
  ])("auth-walls %s for a signed-out visitor", async (path) => {
    const res = await run(path);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("does not treat a sibling prefix like /benchmark as public", async () => {
    const res = await run("/benchmark");
    expect(res.headers.get("location")).toContain("/login");
  });
});
