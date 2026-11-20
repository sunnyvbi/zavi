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

function signedIn(tenant: string | null) {
  mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } }, error: null });
  mockProfile.mockResolvedValue({ data: { active_tenant_id: tenant, beta_invited_at: "2026-01-01T00:00:00Z" }, error: null });
}

function signupRedirect(res: Response) {
  const loc = res.headers.get("location");
  expect(loc).not.toBeNull();
  const url = new URL(loc as string);
  return { path: url.pathname, signup: url.searchParams.get("signup") };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  delete process.env.CLOSED_BETA_ENABLED;
  mockGetUser.mockReset();
  mockProfile.mockReset();
});

describe("middleware /signup for a signed-in account", () => {
  it("carries direct signup tags inside login's next, ready for password, code and OAuth return", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await run("/signup?utm_source=email&utm_medium=email&utm_campaign=launch2&gclid=secret");
    const login = new URL(res.headers.get("location")!);
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("next")).toBe("/start?utm_source=email&utm_medium=email&utm_campaign=launch2");
  });

  it.each(["//evil.example", "https://evil.example", "/%2fexample.com", "/\\evil.example"])("never carries an unsafe signup next: %s", async (next) => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await run(`/signup?utm_source=x&next=${encodeURIComponent(next)}`);
    expect(new URL(res.headers.get("location")!).searchParams.get("next")).toBe("/start?utm_source=x");
  });

  it.each(["/creator", "/oauth/consent?req=abc", "/workspace?tab=files"])("preserves an unrelated safe signup next: %s", async (next) => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await run(`/signup?utm_source=x&next=${encodeURIComponent(next)}`);
    expect(new URL(res.headers.get("location")!).searchParams.get("next")).toBe(next);
  });

  it("retains the chosen signup destination's campaign and fragment", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const next = "/start?step=idea&utm_source=email#form";
    const res = await run(`/signup?utm_source=x&utm_content=creator_alex&next=${encodeURIComponent(next)}`);
    expect(new URL(res.headers.get("location")!).searchParams.get("next")).toBe(next);
  });

  it("an onboarded founder on /signup is redirected to the sign-up page, not passed through to a 404", async () => {
    signedIn("t-1");
    const res = await run("/signup");
    expect(signupRedirect(res)).toEqual({ path: "/login", signup: "1" });
  });

  it("the onboarded founder's next hop, /login?signup=1, goes to /workspace", async () => {
    signedIn("t-1");
    const res = await run("/login?signup=1");
    expect(new URL(res.headers.get("location") as string).pathname).toBe("/workspace");
  });

  it("a signed-in account with no company on /signup reaches the sign-up page, where the client decides creator vs founder", async () => {
    signedIn(null);
    const res = await run("/signup");
    expect(signupRedirect(res)).toEqual({ path: "/login", signup: "1" });
  });

  it("a signed-in account with no company whose profile read fails still reaches the sign-up page", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } }, error: null });
    mockProfile.mockRejectedValue(new Error("profiles locked"));
    const res = await run("/signup");
    expect(signupRedirect(res)).toEqual({ path: "/login", signup: "1" });
  });

  it("signed out keeps the same /signup redirect", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await run("/signup");
    expect(signupRedirect(res)).toEqual({ path: "/login", signup: "1" });
  });

  it("a signed-in account with no company on /login is passed to the page (the page sends it on)", async () => {
    signedIn(null);
    const res = await run("/login");
    expect(res.headers.get("location")).toBeNull();
  });
});
