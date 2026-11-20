// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID = "22222222-2222-4222-8222-222222222222";

const server = vi.hoisted(() => ({
  session: "",
  memberOf: new Set<string>(),
  calls: [] as string[],
  cardReads: [] as Array<{ tenant: string; rail: string; id: string }>,
}));

vi.mock("next/headers", () => ({ cookies: () => ({}) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not_found");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/supabase", () => ({
  createServerSupabase: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u-founder" } } }) } }),
  createBrowserSupabase: () => ({ auth: { signOut: async () => ({ error: null }) } }),
}));
vi.mock("@/lib/tenant", () => ({ fetchActiveTenant: async () => ({ id: server.session, displayName: "x" }) }));
vi.mock("@/lib/active-tenant-client", () => ({
  getActiveTenantId: async () => server.session,
  clearActiveTenantCache: () => {
    server.calls.push("clear-cache");
  },
}));
vi.mock("@/lib/browser-tenant", () => ({ writeStoredTenant: async () => undefined }));
vi.mock("@/lib/ensure-tenant-claim", () => ({
  refreshSessionUntilClaim: async (_sb: unknown, tenantId: string) => {
    server.calls.push(`refresh:${tenantId}`);
    return server.session === tenantId;
  },
}));
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, init?: { body?: string }) => {
    server.calls.push(`fetch:${path}`);
    if (path === "/api/v1/tenants/switch") {
      const wanted = JSON.parse(init?.body ?? "{}").tenant_id as string;
      if (!server.memberOf.has(wanted)) return new Response(JSON.stringify({ error: "not_member" }), { status: 403 });
      server.session = wanted;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  },
}));
vi.mock("@/components/email/EmailCampaignCard", () => ({
  EmailCampaignCard: ({ rail, id }: { rail: string; id: string }) => {
    server.cardReads.push({ tenant: server.session, rail, id });
    return <div data-testid="email-card" data-rail={rail} data-id={id} />;
  },
}));

import EmailCardPage from "./page";

const replace = vi.fn();
function openLink(company: string | null) {
  const qs = company ? `?company=${company}` : "";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: `https://www.zaviagent.com/workspace/email-cards/decisions/${ID}${qs}`, pathname: `/workspace/email-cards/decisions/${ID}`, search: qs, hash: "", replace },
  });
  return EmailCardPage({ params: Promise.resolve({ rail: "decisions", id: ID }), searchParams: Promise.resolve(company ? { company } : {}) });
}

async function followReload() {
  await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
  const next = new URL(String(replace.mock.calls[0][0]), "https://www.zaviagent.com");
  cleanup();
  const company = next.searchParams.get("company");
  return { next, page: await openLink(company) };
}

beforeEach(() => {
  server.session = TENANT_A;
  server.memberOf = new Set([TENANT_A]);
  server.calls.length = 0;
  server.cardReads.length = 0;
  replace.mockReset();
  vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
});
afterEach(cleanup);

describe("an email card link for another of the founder's workspaces", () => {
  it("switches to the link's workspace through the membership-checked switch, refreshes the session, then loads the card there", async () => {
    server.memberOf.add(TENANT_B);
    render(await openLink(TENANT_B));
    expect(screen.queryByTestId("email-card")).toBeNull();
    expect(server.cardReads).toEqual([]);
    const { next, page } = await followReload();
    expect(server.calls).toEqual(["fetch:/api/v1/tenants/switch", `refresh:${TENANT_B}`, "clear-cache"]);
    expect(next.pathname).toBe(`/workspace/email-cards/decisions/${ID}`);
    expect(next.searchParams.has("company")).toBe(false);
    render(page);
    expect(screen.getByTestId("email-card").dataset.id).toBe(ID);
    expect(server.cardReads).toEqual([{ tenant: TENANT_B, rail: "decisions", id: ID }]);
  });

  it("a workspace the founder is not in: the server refuses the switch, the session stays put, and the other tenant's card is never read", async () => {
    render(await openLink(TENANT_B));
    expect(screen.queryByTestId("email-card")).toBeNull();
    const { next, page } = await followReload();
    expect(server.calls).toEqual(["fetch:/api/v1/tenants/switch"]);
    expect(server.session).toBe(TENANT_A);
    expect(next.searchParams.has("company")).toBe(false);
    render(page);
    expect(server.cardReads.every((r) => r.tenant === TENANT_A)).toBe(true);
    expect(server.cardReads.some((r) => r.tenant === TENANT_B)).toBe(false);
  });

  it("a link for the workspace already active, or an old link with none, loads the card with no switch", async () => {
    render(await openLink(TENANT_A));
    expect(screen.getByTestId("email-card").dataset.id).toBe(ID);
    cleanup();
    render(await openLink(null));
    expect(screen.getByTestId("email-card").dataset.id).toBe(ID);
    expect(server.calls.filter((c) => c.includes("switch"))).toEqual([]);
    expect(server.cardReads.map((r) => r.tenant)).toEqual([TENANT_A, TENANT_A]);
  });

  it("signed out, the link's workspace survives the login redirect", async () => {
    const mod = await import("@/lib/supabase");
    const spy = vi.spyOn(mod, "createServerSupabase").mockReturnValue({ auth: { getUser: async () => ({ data: { user: null } }) } } as never);
    await expect(openLink(TENANT_B)).rejects.toThrow(`redirect:/login?next=${encodeURIComponent(`/workspace/email-cards/decisions/${ID}?company=${TENANT_B}`)}`);
    spy.mockRestore();
  });
});
