import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  states: new Map<string, { tenant_id: string; user_id: string; expires_at: number }>(),
  session: { user_id: "user-X", tenant_id: "tenant-A" },
  exchanges: [] as string[],
  upserts: [] as Array<Record<string, unknown>>,
  synced: [] as Array<[string, string]>,
  released: [] as string[],
  reclaimed: [] as string[],
  reclaimFails: false,
  priorTeam: null as string | null,
  exchangeTeam: "acct-1",
  swaps: [] as string[],
  steps: [] as string[],
  exchangeFails: null as string | null,
  setFails: null as string | null,
  readFails: false,
  beforeConsume: null as null | (() => void),
}));

vi.mock("@/services/connectors/core/connector-events", () => ({ recordConnectorEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/active-tenant", () => ({
  syncActiveTenant: vi.fn(async (u: string, t: string) => {
    h.synced.push([u, t]);
  }),
}));
vi.mock("@/services/connectors/core/token", () => ({ handleConnectorAccountSwap: vi.fn(async (t: string) => { h.swaps.push(t); }) }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn(async () => null) }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRole: vi.fn(async () => "owner"), loadTenantRoleFor: vi.fn(async () => "owner") }));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ ...h.session, access_token: "jwt" })),
}));
vi.mock("@/services/supabase", () => {
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "mint_oauth_state") {
        h.states.set(`${args.p_provider}:${args.p_state_hash}`, {
          tenant_id: String(args.p_tenant_id),
          user_id: String(args.p_user_id),
          expires_at: Date.now() + Number(args.p_ttl_seconds) * 1000,
        });
        return { data: null, error: null };
      }
      if (fn === "consume_oauth_state") {
        h.steps.push("consume");
        h.beforeConsume?.();
        const key = `${args.p_provider}:${args.p_state_hash}`;
        const row = h.states.get(key);
        h.states.delete(key);
        if (!row || row.expires_at <= Date.now()) return { data: [], error: null };
        return { data: [{ tenant_id: row.tenant_id, user_id: row.user_id }], error: null };
      }
      if (fn === "set_connector_connection") {
        if (h.setFails) return { data: null, error: { message: h.setFails } };
        h.steps.push("save");
        h.upserts.push(args);
        return { data: null, error: null };
      }
      if (fn === "disconnect_connector") return { data: null, error: null };
      return { data: null, error: null };
    },
    from: (table: string) => {
      const f: Record<string, unknown> = {};
      let notExpiredAt = -Infinity;
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => ((f[k] = v), q),
        gt: (_k: string, v: string) => ((notExpiredAt = Date.parse(v)), q),
        maybeSingle: async () => {
          if (table === "connector_metadata") return { data: h.priorTeam === null ? null : { team_id: h.priorTeam }, error: null };
          if (table !== "oauth_states") return { data: null, error: null };
          h.steps.push("peek");
          if (h.readFails) return { data: null, error: { message: "db password in here" } };
          const row = h.states.get(`${f.provider}:${f.state_hash}`);
          return { data: row && row.expires_at > notExpiredAt ? { tenant_id: row.tenant_id, user_id: row.user_id } : null, error: null };
        },
      };
      return q;
    },
  };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});
vi.mock("@/services/connectors/core/registry", () => {
  const connector = {
    slug: "linkedin_ads",
    serverId: "linkedin_ads",
    bindCallbackToSession: true,
    authorizeUrl: (state: string) => `https://www.linkedin.com/oauth/v2/authorization?state=${encodeURIComponent(state)}`,
    exchangeCode: async (code: string) => {
      h.steps.push("exchange");
      h.exchanges.push(code);
      if (h.exchangeFails) throw new Error(h.exchangeFails);
      return { secrets: { access_token: `token-for-${code}` }, expiresInSec: 3600, metadata: { team_id: h.exchangeTeam, team_name: "Acme", scopes: [] } };
    },
    onConnect: async (tenant: string) => {
      h.steps.push("reclaim");
      h.reclaimed.push(tenant);
      if (h.reclaimFails) throw new Error("claim rpc down");
    },
    onDisconnect: async (tenant: string) => {
      h.released.push(tenant);
    },
  };
  return {
    isKnownConnector: (slug: string) => slug === "linkedin_ads",
    getConnector: (slug: string) => (slug === "linkedin_ads" ? connector : null),
  };
});

import { connectorStart, connectorCallback, connectorComplete, connectorDisconnect } from "../connector";

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

async function startAs(user: string, tenant: string, returnTo?: string): Promise<string> {
  h.session = { user_id: user, tenant_id: tenant };
  const r = mockRes();
  await connectorStart(
    { params: { connector: "linkedin_ads" }, query: returnTo ? { return_to: returnTo } : {}, headers: { accept: "application/json" } } as unknown as Request,
    r,
  );
  expect(r.statusCode).toBe(200);
  return new URL(r.body.oauth_url).searchParams.get("state")!;
}

async function callback(code: string, state: string): Promise<Res> {
  const r = mockRes();
  await connectorCallback({ params: { connector: "linkedin_ads" }, query: { code, state }, headers: {} } as unknown as Request, r);
  return r;
}

function fragmentOf(location: string): URLSearchParams {
  const url = new URL(location);
  return new URLSearchParams(url.hash.slice(1));
}

async function completeAs(user: string, tenant: string, code: string, state: string): Promise<Res> {
  h.session = { user_id: user, tenant_id: tenant };
  const r = mockRes();
  await connectorComplete(
    { params: { connector: "linkedin_ads" }, body: { code, state }, headers: { authorization: "Bearer jwt" } } as unknown as Request,
    r,
  );
  return r;
}

beforeEach(() => {
  h.states.clear();
  h.exchanges.length = 0;
  h.upserts.length = 0;
  h.synced.length = 0;
  h.released.length = 0;
  h.reclaimed.length = 0;
  h.reclaimFails = false;
  h.priorTeam = null;
  h.exchangeTeam = "acct-1";
  h.swaps.length = 0;
  h.steps.length = 0;
  h.exchangeFails = null;
  h.setFails = null;
  h.readFails = false;
  h.beforeConsume = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LinkedIn Ads OAuth callback is bound to the session that started it", () => {
  it("never stores a token on the unauthenticated callback; it hands code and state to the web app in the fragment only", async () => {
    const state = await startAs("user-X", "tenant-A");
    const r = await callback("code-1", state);
    expect(r.statusCode).toBe(302);
    const url = new URL(r.location!);
    expect(`${url.origin}${url.pathname}`).toBe("http://localhost:3040/connectors/finish");
    expect(url.search).toBe("");
    const frag = fragmentOf(r.location!);
    expect(frag.get("connector")).toBe("linkedin_ads");
    expect(frag.get("code")).toBe("code-1");
    expect(frag.get("state")).toBe(state);
    expect(h.exchanges).toEqual([]);
    expect(h.upserts).toEqual([]);
    expect(h.states.size).toBe(1);
  });

  it("stores the token for the starting tenant when the same signed-in user completes", async () => {
    const state = await startAs("user-X", "tenant-A", "/workspace?tab=channels&channel=linkedin_ads");
    const frag = fragmentOf((await callback("code-1", state)).location!);
    const r = await completeAs("user-X", "tenant-A", frag.get("code")!, frag.get("state")!);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true, redirect: "/workspace?tab=channels&channel=linkedin_ads&linkedin_ads=connected" });
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0].p_tenant_id).toBe("tenant-A");
    expect(h.upserts[0].p_secrets).toEqual({ access_token: "token-for-code-1" });
    expect(h.synced).toEqual([["user-X", "tenant-A"]]);
  });

  it.each([
    ["the channel page", "/workspace?tab=channels&channel=linkedin_ads", "/workspace?tab=channels&channel=linkedin_ads&linkedin_ads=connected"],
    ["the Connectors page", undefined, "/workspace?tab=settings&linkedin_ads=connected"],
  ])("must catch: a finish page served on www while WEB_ORIGIN names the apex still lands back on %s with the connected flag", async (_label, returnTo, landing) => {
    const prior = process.env.WEB_ORIGIN;
    process.env.WEB_ORIGIN = "https://zaviagent.com,https://www.zaviagent.com";
    try {
      const state = await startAs("user-X", "tenant-A", returnTo);
      const finish = new URL((await callback("code-1", state)).location!);
      expect(finish.origin).toBe("https://zaviagent.com");
      const frag = fragmentOf(finish.href);
      const r = await completeAs("user-X", "tenant-A", frag.get("code")!, frag.get("state")!);
      expect(r.statusCode).toBe(200);
      const finishOrigin = "https://www.zaviagent.com";
      const target = new URL(r.body.redirect, finishOrigin);
      expect(target.origin).toBe(finishOrigin);
      expect(`${target.pathname}${target.search}${target.hash}`).toBe(landing);
      expect(h.upserts).toHaveLength(1);
    } finally {
      process.env.WEB_ORIGIN = prior;
    }
  });

  it("refuses a victim who opens the attacker's link: the victim's LinkedIn token never lands in the attacker's workspace", async () => {
    const attackerState = await startAs("attacker", "tenant-attacker");
    const frag = fragmentOf((await callback("victim-code", attackerState)).location!);
    const r = await completeAs("victim", "tenant-victim", frag.get("code")!, frag.get("state")!);
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("state_session_mismatch");
    expect(h.exchanges).toEqual([]);
    expect(h.upserts).toEqual([]);
    expect(h.synced).toEqual([]);
  });

  it("refuses another member of the same workspace completing a flow they did not start", async () => {
    const state = await startAs("user-X", "tenant-A");
    const r = await completeAs("user-Y", "tenant-A", "code-1", state);
    expect(r.statusCode).toBe(403);
    expect(h.exchanges).toEqual([]);
    expect(h.upserts).toEqual([]);
  });

  it("refuses the same user completing into a different active workspace than the one they started in", async () => {
    const state = await startAs("user-X", "tenant-A");
    const r = await completeAs("user-X", "tenant-B", "code-1", state);
    expect(r.statusCode).toBe(403);
    expect(h.exchanges).toEqual([]);
    expect(h.upserts).toEqual([]);
  });

  it("refuses an attacker planting their own token in a victim's workspace with the attacker's code", async () => {
    await startAs("victim", "tenant-victim");
    const attackerState = await startAs("attacker", "tenant-attacker");
    const r = await completeAs("victim", "tenant-victim", "attacker-code", attackerState);
    expect(r.statusCode).toBe(403);
    expect(h.upserts).toEqual([]);
  });

  it("refuses a replayed state after a successful completion and stores nothing more", async () => {
    const state = await startAs("user-X", "tenant-A");
    expect((await completeAs("user-X", "tenant-A", "code-1", state)).statusCode).toBe(200);
    const again = await completeAs("user-X", "tenant-A", "code-2", state);
    expect(again.statusCode).toBe(403);
    expect(again.body.error.code).toBe("invalid_state");
    expect(h.exchanges).toEqual(["code-1"]);
    expect(h.upserts).toHaveLength(1);
  });

  it("must catch: a wrong session does not burn the state, so the person who started it can still finish", async () => {
    const state = await startAs("user-X", "tenant-A");
    expect((await completeAs("user-Y", "tenant-A", "code-1", state)).statusCode).toBe(403);
    expect((await completeAs("user-X", "tenant-B", "code-1", state)).statusCode).toBe(403);
    expect(h.steps).toEqual(["peek", "peek"]);
    expect(h.exchanges).toEqual([]);
    const r = await completeAs("user-X", "tenant-A", "code-1", state);
    expect(r.statusCode).toBe(200);
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0].p_tenant_id).toBe("tenant-A");
  });

  it("must not catch: the state is consumed before the code is exchanged, never after", async () => {
    const state = await startAs("user-X", "tenant-A");
    await completeAs("user-X", "tenant-A", "code-1", state);
    expect(h.steps).toEqual(["peek", "consume", "exchange", "save", "reclaim"]);
  });

  it("must not catch: two completes racing on one state make exactly one exchange, even when both passed the session check", async () => {
    const state = await startAs("user-X", "tenant-A");
    const [a, b] = await Promise.all([completeAs("user-X", "tenant-A", "code-1", state), completeAs("user-X", "tenant-A", "code-2", state)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 403]);
    expect(h.steps.filter((x) => x === "peek")).toHaveLength(2);
    expect(h.exchanges).toHaveLength(1);
    expect(h.upserts).toHaveLength(1);
  });

  it("must not catch: a state consumed between the check and the consume is refused, with no exchange", async () => {
    const state = await startAs("user-X", "tenant-A");
    h.beforeConsume = () => h.states.clear();
    const r = await completeAs("user-X", "tenant-A", "code-1", state);
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("invalid_state");
    expect(h.exchanges).toEqual([]);
  });

  it("must catch: a failed exchange tells the founder to start again in plain words, never quotes the vendor, and leaves no state to replay", async () => {
    const state = await startAs("user-X", "tenant-A");
    h.exchangeFails = "linkedin_ads token HTTP 400 secret-looking-body";
    const r = await completeAs("user-X", "tenant-A", "code-1", state);
    expect(r.statusCode).toBe(502);
    expect(r.body.error.code).toBe("connector_exchange_failed");
    expect(r.body.error.message).toBe("The sign-in did not finish, so nothing was connected. Start the connection again from your workspace.");
    expect(JSON.stringify(r.body)).not.toMatch(/secret-looking|HTTP 400/);
    expect(h.upserts).toEqual([]);

    h.exchangeFails = null;
    const replay = await completeAs("user-X", "tenant-A", "code-1", state);
    expect(replay.statusCode).toBe(403);
    expect(replay.body.error.code).toBe("invalid_state");
    expect(h.exchanges).toEqual(["code-1"]);
    expect(h.upserts).toEqual([]);

    const fresh = await startAs("user-X", "tenant-A");
    expect(fresh).not.toBe(state);
    const again = await completeAs("user-X", "tenant-A", "code-2", fresh);
    expect(again.statusCode).toBe(200);
    expect(h.upserts).toHaveLength(1);
  });

  it("a failed save says the same and quotes no database error", async () => {
    const state = await startAs("user-X", "tenant-A");
    h.setFails = "duplicate key on vault.secrets";
    const r = await completeAs("user-X", "tenant-A", "code-1", state);
    expect(r.statusCode).toBe(500);
    expect(r.body.error.code).toBe("set_connector_connection_failed");
    expect(r.body.error.message).toBe("The sign-in did not finish, so nothing was connected. Start the connection again from your workspace.");
    expect(h.states.size).toBe(0);
  });

  it("must not catch: when the state cannot be read nothing is consumed or exchanged, and no database text is sent", async () => {
    const state = await startAs("user-X", "tenant-A");
    h.readFails = true;
    const r = await completeAs("user-X", "tenant-A", "code-1", state);
    expect(r.statusCode).toBe(500);
    expect(r.body.error.message).not.toMatch(/db password/);
    expect(h.steps).toEqual(["peek"]);
    expect(h.states.size).toBe(1);
    expect(h.exchanges).toEqual([]);
  });

  it("must not catch: an unknown state is refused before any consume", async () => {
    const r = await completeAs("user-X", "tenant-A", "code-1", "never-minted");
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("invalid_state");
    expect(h.steps).toEqual(["peek"]);
  });

  it("refuses an expired state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T10:00:00Z"));
    const state = await startAs("user-X", "tenant-A");
    vi.setSystemTime(new Date("2026-10-30T10:10:01Z"));
    const r = await completeAs("user-X", "tenant-A", "code-1", state);
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("invalid_state");
    expect(h.steps).toEqual(["peek"]);
    expect(h.exchanges).toEqual([]);
    expect(h.upserts).toEqual([]);
  });

  it("refuses a complete with no code or state before touching any state", async () => {
    const state = await startAs("user-X", "tenant-A");
    const r = await completeAs("user-X", "tenant-A", "", state);
    expect(r.statusCode).toBe(400);
    expect(h.states.size).toBe(1);
  });

  it("re-claims the ad account for the reconnecting tenant only, after the tokens are saved", async () => {
    const state = await startAs("user-X", "tenant-A");
    expect((await completeAs("user-X", "tenant-A", "code-1", state)).statusCode).toBe(200);
    expect(h.reclaimed).toEqual(["tenant-A"]);
    expect(h.steps.slice(-2)).toEqual(["save", "reclaim"]);
  });

  it("a failed re-claim still finishes the connection, and a failed save never re-claims", async () => {
    h.reclaimFails = true;
    const ok = await completeAs("user-X", "tenant-A", "code-1", await startAs("user-X", "tenant-A"));
    expect(ok.statusCode).toBe(200);
    expect(ok.body.ok).toBe(true);
    h.reclaimed.length = 0;
    h.setFails = "boom";
    const failed = await completeAs("user-X", "tenant-A", "code-2", await startAs("user-X", "tenant-A"));
    expect(failed.statusCode).toBe(500);
    expect(h.reclaimed).toEqual([]);
  });

  it("a Reconnect whose account label could not be read saves the tokens and never treats it as a different account", async () => {
    h.priorTeam = "acct-1";
    h.exchangeTeam = "";
    const r = await completeAs("user-X", "tenant-A", "code-1", await startAs("user-X", "tenant-A"));
    expect(r.statusCode).toBe(200);
    expect(h.upserts).toHaveLength(1);
    expect(h.swaps).toEqual([]);
    h.exchangeTeam = "acct-2";
    await completeAs("user-X", "tenant-A", "code-2", await startAs("user-X", "tenant-A"));
    expect(h.swaps).toEqual(["tenant-A"]);
  });

  it("releases the LinkedIn account claim of the disconnecting tenant only", async () => {
    h.session = { user_id: "user-X", tenant_id: "tenant-A" };
    const r = mockRes();
    await connectorDisconnect({ params: { connector: "linkedin_ads" }, headers: {} } as unknown as Request, r);
    expect(r.statusCode).toBe(200);
    expect(h.released).toEqual(["tenant-A"]);
  });
});

describe("the real LinkedIn Ads connector opts into the session-bound callback", () => {
  it("declares bindCallbackToSession and a claim release on disconnect", async () => {
    const { linkedinAdsConnector } = await vi.importActual<typeof import("@/services/connectors/linkedin-ads/oauth")>("@/services/connectors/linkedin-ads/oauth");
    expect(linkedinAdsConnector.bindCallbackToSession).toBe(true);
    expect(typeof linkedinAdsConnector.onDisconnect).toBe("function");
    expect(typeof linkedinAdsConnector.onConnect).toBe("function");
  });
});
