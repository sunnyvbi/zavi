
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetUser = vi.fn();
const mockProfile = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: mockGetUser },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => mockProfile(),
        }),
      }),
    }),
  }),
}));

import { middleware } from "@/middleware";
import { NextRequest } from "next/server";

const run = (path: string) => middleware(new NextRequest(`http://localhost:3000${path}`));

function signedInNoTenant() {
  mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } }, error: null });
  mockProfile.mockResolvedValue({ data: { active_tenant_id: null, beta_invited_at: "2026-01-01T00:00:00Z" }, error: null });
}

function locationOf(res: Response): URL {
  return new URL(res.headers.get("location")!);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  delete process.env.CLOSED_BETA_ENABLED;
  mockGetUser.mockReset();
  mockProfile.mockReset();
});

describe("needs-onboarding redirect keeps an AI assistant's approval screen", () => {
  it("sends /oauth/consent to /start with the consent page as next", async () => {
    signedInNoTenant();
    const res = await run("/oauth/consent?req=eyJ.sig");
    const dest = locationOf(res);
    expect(dest.pathname).toBe("/start");
    expect(dest.searchParams.get("next")).toBe("/oauth/consent?req=eyJ.sig");
  });

  it("still drops the path and query for every other page", async () => {
    signedInNoTenant();
    const dest = locationOf(await run("/workspace?tab=growth&next=/oauth/consent?req=x"));
    expect(dest.pathname).toBe("/start");
    expect(dest.search).toBe("");
  });

  it("leaves the signed-out redirect to /login unchanged", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const dest = locationOf(await run("/oauth/consent?req=eyJ.sig"));
    expect(dest.pathname).toBe("/login");
    expect(dest.searchParams.get("next")).toBe("/oauth/consent?req=eyJ.sig");
  });
});
