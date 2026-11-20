
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

const run = (path: string) =>
  middleware(new NextRequest(`http://localhost:3000${path}`));

function signedInNoTenant() {
  mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } }, error: null });
  mockProfile.mockResolvedValue({
    data: { active_tenant_id: null, beta_invited_at: "2026-01-01T00:00:00Z" },
    error: null,
  });
}

function signedOut() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
  mockProfile.mockResolvedValue({ data: null, error: null });
}

function onboardedFounder() {
  mockGetUser.mockResolvedValue({ data: { user: { id: "u-2" } }, error: null });
  mockProfile.mockResolvedValue({
    data: { active_tenant_id: "t-1", beta_invited_at: "2026-01-01T00:00:00Z" },
    error: null,
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  delete process.env.CLOSED_BETA_ENABLED;
  mockGetUser.mockReset();
  mockProfile.mockReset();
});

const CREATOR_PATHS = [
  "/creator",
  "/creator/inbox",
  "/creator/briefs",
  "/creator/jobs",
  "/creator/jobs/4f3c2b1a-0000-4000-8000-000000000001",
  "/creator/earnings",
  "/creator/storefront",
];

describe("a signed-in creator reaches the creator area", () => {
  it.each(CREATOR_PATHS)("does not bounce %s to /start", async (path) => {
    signedInNoTenant();
    const res = await run(path);
    const location = res.headers.get("location");
    expect(location, `${path} redirected to ${location}`).toBeNull();
    expect(res.status).toBe(200);
  });

  it("never sends a company account into the creator area from /login?next=", async () => {
    onboardedFounder();
    for (const next of [
      "/creator",
      "/creator/jobs?x=1",
      "/creators/apply",
      "/workspace/../creator",
      "/creator/..%2fworkspace",
      "/creator/%",
      "/workspace%2F..%2Fcreator",
      "/creators/apply%2F..%2F..%2Fworkspace",
    ]) {
      const res = await run(`/login?next=${encodeURIComponent(next)}`);
      expect(new URL(res.headers.get("location")!).pathname, next).toBe("/workspace");
    }
    const other = await run(`/login?next=${encodeURIComponent("/tools")}`);
    expect(new URL(other.headers.get("location")!).pathname).toBe("/tools");
  });

  it("lets an onboarded founder who is also a creator through", async () => {
    onboardedFounder();
    const res = await run("/creator/jobs");
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("the /start funnel still works for a tenantless founder", () => {
  it.each([
    "/workspace",
    "/humans",
    "/library",
    "/connectors",
    "/account",
  ])("still sends a signed-in, tenantless visitor from %s to /start", async (path) => {
    signedInNoTenant();
    const res = await run(path);
    expect(res.headers.get("location")).toContain("/start");
  });

  it("still lets a tenantless founder load /start itself", async () => {
    signedInNoTenant();
    const res = await run("/start");
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("the creator area is NOT public", () => {
  it.each(CREATOR_PATHS)("auth-walls %s for a signed-out visitor", async (path) => {
    signedOut();
    const res = await run(path);
    const location = res.headers.get("location");
    expect(location, `${path} was reachable signed out`).toContain("/login");
    expect(location).toContain(encodeURIComponent(path));
  });
});

describe("the carve-out is exactly /creator, no wider", () => {
  it("does NOT exempt /creators/<anything> (the storefront is off)", async () => {
    signedInNoTenant();
    const res = await run("/creators/ada");
    expect(res.headers.get("location")).toContain("/start");
  });

  it("does NOT exempt a path that merely contains /creator", async () => {
    signedInNoTenant();
    const res = await run("/workspace/creator");
    expect(res.headers.get("location")).toContain("/start");
  });

  it("keeps /creators/<anything> auth-walled signed out too", async () => {
    signedOut();
    const res = await run("/creators/ada");
    expect(res.headers.get("location")).toContain("/login");
  });
});

describe("closed beta does not strand a creator", () => {
  it("lets a creator through while a non-invited founder is sent to /talk-to-team", async () => {
    process.env.CLOSED_BETA_ENABLED = "true";
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-3" } }, error: null });
    mockProfile.mockResolvedValue({
      data: { active_tenant_id: null, beta_invited_at: null },
      error: null,
    });

    const creator = await run("/creator/jobs");
    expect(creator.headers.get("location")).toBeNull();

    const founder = await run("/workspace");
    expect(founder.headers.get("location")).toContain("/talk-to-team");
  });
});

describe("tagged homepage sign-in return", () => {
  const tags = "utm_source=linkedin&utm_medium=social&utm_campaign=launch2";
  it("keeps the campaign when a new founder needs onboarding and drops unrelated query data", async () => {
    signedInNoTenant();
    const res = await run(`/workspace?${tags}&email=private@example.com&tab=build`);
    expect(res.headers.get("location")).toBe(`http://localhost:3000/start?${tags}`);
  });
  it("keeps an existing company on its workspace", async () => {
    onboardedFounder();
    const res = await run(`/workspace?${tags}`);
    expect(res.headers.get("location")).toBeNull();
  });
});
