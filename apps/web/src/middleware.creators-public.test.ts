
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetUser = vi.fn();
const mockProfile = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: mockGetUser },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mockProfile }),
      }),
    }),
  }),
}));

import { middleware } from "@/middleware";
import { NextRequest } from "next/server";

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
  mockProfile.mockResolvedValue({ data: null, error: null });
});

const run = (path: string) => middleware(new NextRequest(`http://localhost:3000${path}`));

describe("a creator storefront path is no longer public", () => {
  it.each(["/creators/ada", "/creators/definitely-not-a-creator", "/creators/ada/extra"])(
    "sends a signed-out visitor on %s to /login",
    async (path) => {
      const res = await run(path);
      expect(res.headers.get("location"), `${path} was public`).toContain("/login");
    },
  );

  it("sends a signed-in visitor with no workspace on /creators/ada to /start", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } }, error: null });
    mockProfile.mockResolvedValue({ data: { active_tenant_id: null }, error: null });
    const res = await run("/creators/ada");
    expect(res.headers.get("location")).toContain("/start");
  });
});

describe("exactly three /creators paths are public", () => {
  it.each(["/creators", "/creators/login", "/creators/apply"])(
    "lets a signed-out visitor open %s",
    async (path) => {
      const res = await run(path);
      expect(res.headers.get("location"), `${path} redirected`).toBeNull();
    },
  );

  it.each(["/creators/", "/creators/login/extra", "/creators/applyx"])(
    "does not widen to %s",
    async (path) => {
      const res = await run(path);
      expect(res.headers.get("location"), `${path} was public`).toContain("/login");
    },
  );
});
