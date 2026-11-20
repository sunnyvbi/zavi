import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  states: new Map<string, { tenant_id: string; user_id: string }>(),
  connections: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ user_id: "user-A", tenant_id: "t1", access_token: "jwt" })),
}));
vi.mock("@/services/connectors/github/oauth", () => ({
  githubAppInstallStartUrl: async (state: string) =>
    `https://github.com/apps/zavi/installations/new?state=${encodeURIComponent(state)}`,
  getInstallation: async () => ({ account_login: "mohit-upcar", account_type: "User" }),
  listInstallationRepos: async () => [{ id: 1, full_name: "mohit-upcar/crumb-co", private: true }],
}));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn(async () => undefined) }));
vi.mock("@/services/sandbox/repo-profiles", () => ({ seedPendingProfiles: vi.fn(async () => undefined) }));
vi.mock("@/services/sandbox/repo-access-gate", () => ({ UMBRELLA_CONNECTOR_ACCOUNT_LOGIN: "Praxis-build" }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));
vi.mock("@/services/supabase", () => {
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "mint_oauth_state") {
        h.states.set(String(args.p_state_hash), { tenant_id: String(args.p_tenant_id), user_id: String(args.p_user_id) });
        return { data: null, error: null };
      }
      if (fn === "consume_oauth_state") {
        const row = h.states.get(String(args.p_state_hash));
        h.states.delete(String(args.p_state_hash));
        return { data: row ? [row] : [], error: null };
      }
      if (fn === "set_github_connection") {
        h.connections.push(args);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    },
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null }),
      };
      return q;
    },
  };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});

import { githubStart, githubCallback } from "../github";

process.env.BACKEND_PUBLIC_URL = "http://localhost:3011";
process.env.WEB_ORIGIN = "http://localhost:3040";

type Res = Response & { statusCode: number; body: any; location: string | null };
function mockRes(): Res {
  const res: Record<string, unknown> = { statusCode: 200, body: null, location: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.redirect = (c: number, url: string) => { res.statusCode = c; res.location = url; return res; };
  return res as unknown as Res;
}

async function installFrom(returnTo: string | undefined, setup_action = "install"): Promise<Res> {
  const startRes = mockRes();
  await githubStart(
    {
      query: returnTo === undefined ? {} : { return_to: returnTo },
      headers: { accept: "application/json", authorization: "Bearer jwt" },
    } as unknown as Request,
    startRes,
  );
  expect(startRes.statusCode).toBe(200);
  const state = new URL(startRes.body.oauth_url).searchParams.get("state")!;
  const cbRes = mockRes();
  await githubCallback(
    { query: { installation_id: "164038209", setup_action, state }, headers: {} } as unknown as Request,
    cbRes,
  );
  return cbRes;
}

beforeEach(() => {
  h.states.clear();
  h.connections.length = 0;
});

describe("GitHub App install return path", () => {
  it("sends the founder back to the Build tab they connected from, even when GitHub answers in another tab", async () => {
    const res = await installFrom("/workspace?tab=build&site=0b6d4c1e-1111-4222-8333-944455556666");
    expect(res.statusCode).toBe(302);
    expect(res.location).toBe(
      "http://localhost:3040/workspace?tab=build&site=0b6d4c1e-1111-4222-8333-944455556666&github=connected&action=install",
    );
    expect(h.connections).toHaveLength(1);
  });

  it("a connect started on Integrations comes back to Integrations, hash included", async () => {
    const res = await installFrom("/workspace?tab=brain#integrations");
    expect(res.location).toBe("http://localhost:3040/workspace?tab=brain&github=connected&action=install#integrations");
  });

  it("an update of repo access on an existing install goes back the same way", async () => {
    const res = await installFrom("/workspace?tab=build", "update");
    expect(res.location).toBe("http://localhost:3040/workspace?tab=build&github=connected&action=update");
  });

  it("with no return path, or an unsafe one, lands on Settings as before", async () => {
    for (const bad of [undefined, "https://evil.com/workspace", "//evil.com", "/workspace?tab=settings", "/login?next=/x"]) {
      h.states.clear();
      const res = await installFrom(bad);
      expect(res.location).toBe("http://localhost:3040/workspace?tab=settings&github=connected&action=install");
    }
  });

  it("a replayed callback with the same state is refused, return path or not", async () => {
    const first = await installFrom("/workspace?tab=build");
    const state = new URL(first.location!).searchParams;
    expect(state.get("github")).toBe("connected");
    const startRes = mockRes();
    await githubStart({ query: { return_to: "/workspace?tab=build" }, headers: { accept: "application/json" } } as unknown as Request, startRes);
    const raw = new URL(startRes.body.oauth_url).searchParams.get("state")!;
    const ok = mockRes();
    await githubCallback({ query: { installation_id: "1", setup_action: "install", state: raw }, headers: {} } as unknown as Request, ok);
    expect(ok.statusCode).toBe(302);
    const replay = mockRes();
    await githubCallback({ query: { installation_id: "1", setup_action: "install", state: raw }, headers: {} } as unknown as Request, replay);
    expect(replay.statusCode).toBe(403);
    expect(replay.body.error.code).toBe("invalid_state");
  });
});
