import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const h = vi.hoisted(() => ({
  states: new Map<string, { tenant_id: string; user_id: string }>(),
  sessions: { "founder-jwt": { user_id: "founder", tenant_id: "tenant-founder" }, "attacker-jwt": { user_id: "attacker", tenant_id: "tenant-attacker" } } as Record<string, { user_id: string; tenant_id: string }>,
  exchanges: [] as string[],
  upserts: [] as Array<Record<string, unknown>>,
  consumes: 0,
}));

vi.mock("@/services/connectors/core/connector-events", () => ({ recordConnectorEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: vi.fn(async () => undefined) }));
vi.mock("@/services/connectors/core/token", () => ({ handleConnectorAccountSwap: vi.fn(async () => undefined) }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn(async () => null) }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRole: vi.fn(async () => "owner"), loadTenantRoleFor: vi.fn(async () => "owner") }));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (req: { headers: Record<string, string | undefined> }, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const session = h.sessions[token];
    if (!session) {
      res.status(401).json({ error: { code: "unauthorized", message: "Sign in." } });
      return null;
    }
    return { ...session, access_token: token };
  }),
}));
vi.mock("@/services/supabase", () => {
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const key = `${args.p_provider}:${args.p_state_hash}`;
      if (fn === "mint_oauth_state") {
        h.states.set(key, { tenant_id: String(args.p_tenant_id), user_id: String(args.p_user_id) });
      } else if (fn === "consume_oauth_state") {
        h.consumes += 1;
        const row = h.states.get(key);
        h.states.delete(key);
        return { data: row ? [row] : [], error: null };
      } else if (fn === "set_connector_connection") {
        h.upserts.push(args);
      }
      return { data: null, error: null };
    },
    from: () => {
      const f: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => ((f[k] = v), q),
        gt: () => q,
        maybeSingle: async () => ({ data: h.states.get(`${f.provider}:${f.state_hash}`) ?? null, error: null }),
      };
      return q;
    },
  };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});
vi.mock("@/services/connectors/core/registry", () => {
  const make = (slug: string, bound: boolean) => ({
    slug,
    serverId: slug,
    bindCallbackToSession: bound,
    authorizeUrl: (state: string, back: string) =>
      `https://www.linkedin.com/oauth/v2/authorization?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(back)}`,
    exchangeCode: async (code: string) => {
      h.exchanges.push(code);
      return { secrets: { access_token: `token-for-${code}` }, expiresInSec: 3600, metadata: { team_id: "acct", team_name: "Acct", scopes: [] } };
    },
  });
  const all: Record<string, unknown> = { linkedin_ads: make("linkedin_ads", true), reddit_ads: make("reddit_ads", false) };
  return { isKnownConnector: (s: string) => s in all, getConnector: (s: string) => all[s] ?? null };
});

import { connectorCallback, connectorComplete, connectorStart } from "../connector";
import { mobileHandoff, mobileOpen, mobileReturnMiddleware, toAppReturn } from "../mobile-return";

const WEB = "https://www.zaviagent.com";
let server: Server;
let base: string;

beforeEach(async () => {
  h.states.clear();
  h.exchanges.length = 0;
  h.upserts.length = 0;
  h.consumes = 0;
  const app = express();
  app.use(express.json());
  app.use("/api/connectors", mobileReturnMiddleware);
  app.post("/api/connectors/mobile/handoff", mobileHandoff);
  app.get("/api/connectors/mobile/open", mobileOpen);
  app.get("/api/connectors/:connector/start", connectorStart);
  app.get("/api/connectors/:connector/callback", connectorCallback);
  app.post("/api/connectors/:connector/complete", connectorComplete);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.BACKEND_PUBLIC_URL = base;
  process.env.WEB_ORIGIN = WEB;
  process.env.MOBILE_HANDOFF_SECRET = "test-secret-at-least-32-characters-long";
});
afterEach(() => {
  server.close();
});

async function startAs(jwt: string, slug = "linkedin_ads"): Promise<{ oauthUrl: string; state: string }> {
  const r = await fetch(`${base}/api/connectors/${slug}/start`, { headers: { accept: "application/json", authorization: `Bearer ${jwt}` } });
  expect(r.status).toBe(200);
  const { oauth_url } = (await r.json()) as { oauth_url: string };
  return { oauthUrl: oauth_url, state: new URL(oauth_url).searchParams.get("state")! };
}

async function phoneBrowserCookie(jwt: string, oauthUrl: string): Promise<string> {
  const handoff = await fetch(`${base}/api/connectors/mobile/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ url: oauthUrl }),
  });
  expect(handoff.status).toBe(200);
  const { open_url } = (await handoff.json()) as { open_url: string };
  const open = await fetch(open_url, { redirect: "manual" });
  expect(open.status).toBe(302);
  return open.headers.get("set-cookie")!.split(";")[0];
}

function callback(slug: string, code: string, state: string, cookie?: string) {
  const q = new URLSearchParams({ code, state });
  return fetch(`${base}/api/connectors/${slug}/callback?${q}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
}

function appCompletes(deepLink: string, jwt?: string) {
  const u = new URL(deepLink);
  return fetch(`${base}/api/connectors/${u.searchParams.get("connector")}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify({ code: u.searchParams.get("code"), state: u.searchParams.get("state") }),
  });
}

describe("LinkedIn Ads connect started in the mobile app", () => {
  it("must catch: the callback hands code and state to the app, stores nothing itself, and the app's own token finishes it", async () => {
    const { oauthUrl, state } = await startAs("founder-jwt");
    const cookie = await phoneBrowserCookie("founder-jwt", oauthUrl);
    const cb = await callback("linkedin_ads", "founder+code/1", state, cookie);
    expect(cb.status).toBe(302);
    const deepLink = cb.headers.get("location")!;
    expect(deepLink.startsWith("zavi://connectors/finish?")).toBe(true);
    const u = new URL(deepLink);
    expect(u.searchParams.get("connector")).toBe("linkedin_ads");
    expect(u.searchParams.get("code")).toBe("founder+code/1");
    expect(u.searchParams.get("state")).toBe(state);
    expect(cb.headers.get("set-cookie")).toMatch(/zavi_mobile_return=;/);
    expect(h.exchanges).toEqual([]);
    expect(h.upserts).toEqual([]);
    expect(h.consumes).toBe(0);

    const done = await appCompletes(deepLink, "founder-jwt");
    expect(done.status).toBe(200);
    expect(h.exchanges).toEqual(["founder+code/1"]);
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0].p_tenant_id).toBe("tenant-founder");
    expect(h.upserts[0].p_secrets).toEqual({ access_token: "token-for-founder+code/1" });
  });

  it("must catch: an attacker's callback link opened on the founder's phone never binds the attacker's LinkedIn to the founder's workspace", async () => {
    const founderFlow = await startAs("founder-jwt");
    const cookie = await phoneBrowserCookie("founder-jwt", founderFlow.oauthUrl);
    const attacker = await startAs("attacker-jwt");

    const cb = await callback("linkedin_ads", "attacker-code", attacker.state, cookie);
    expect(cb.status).toBe(302);
    const deepLink = cb.headers.get("location")!;
    expect(deepLink.startsWith("zavi://connectors/finish?")).toBe(true);

    const refused = await appCompletes(deepLink, "founder-jwt");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("state_session_mismatch");
    expect(h.exchanges).toEqual([]);
    expect(h.upserts).toEqual([]);
    expect(h.consumes).toBe(0);
  });

  it("must catch: the attacker cannot complete a flow the founder started, even holding its state", async () => {
    const founderFlow = await startAs("founder-jwt");
    const refused = await fetch(`${base}/api/connectors/linkedin_ads/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer attacker-jwt" },
      body: JSON.stringify({ code: "attacker-code", state: founderFlow.state }),
    });
    expect(refused.status).toBe(403);
    expect(h.exchanges).toEqual([]);
    expect(h.upserts).toEqual([]);
    expect(h.states.size).toBe(1);
  });

  it("must not catch: an app with no token gets 401 and nothing is consumed, exchanged or stored", async () => {
    const { oauthUrl, state } = await startAs("founder-jwt");
    const cookie = await phoneBrowserCookie("founder-jwt", oauthUrl);
    const deepLink = (await callback("linkedin_ads", "code-1", state, cookie)).headers.get("location")!;
    const r = await appCompletes(deepLink);
    expect(r.status).toBe(401);
    expect(h.consumes).toBe(0);
    expect(h.exchanges).toEqual([]);
    expect(h.upserts).toEqual([]);
  });

  it("must not catch: a replayed deep link after a finished connect is refused and stores nothing more", async () => {
    const { oauthUrl, state } = await startAs("founder-jwt");
    const cookie = await phoneBrowserCookie("founder-jwt", oauthUrl);
    const deepLink = (await callback("linkedin_ads", "code-1", state, cookie)).headers.get("location")!;
    expect((await appCompletes(deepLink, "founder-jwt")).status).toBe(200);
    const again = await appCompletes(deepLink, "founder-jwt");
    expect(again.status).toBe(403);
    expect(h.exchanges).toEqual(["code-1"]);
    expect(h.upserts).toHaveLength(1);
  });

  it("must not catch: without the app's cookie the browser still goes to the web finish page, code and state in the fragment only", async () => {
    const { state } = await startAs("founder-jwt");
    const cb = await callback("linkedin_ads", "code-1", state);
    const location = cb.headers.get("location")!;
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe(`${WEB}/connectors/finish`);
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("code")).toBe("code-1");
    expect(h.exchanges).toEqual([]);
  });

  it("must not catch: a connector that is not session bound still finishes on the callback and returns to the app as before", async () => {
    const { oauthUrl, state } = await startAs("founder-jwt", "reddit_ads");
    const cookie = await phoneBrowserCookie("founder-jwt", oauthUrl);
    const cb = await callback("reddit_ads", "reddit-code", state, cookie);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toMatch(/^zavi:\/\/connectors\/done\?.*reddit_ads=connected/);
    expect(h.exchanges).toEqual(["reddit-code"]);
    expect(h.upserts).toHaveLength(1);
  });

  it("must not catch: only the web app's own finish page maps to the app", () => {
    expect(toAppReturn(`${WEB}/connectors/finish#connector=linkedin_ads&code=c&state=s`, WEB)).toBe("zavi://connectors/finish?connector=linkedin_ads&code=c&state=s");
    expect(toAppReturn("https://evil.example/connectors/finish#connector=linkedin_ads&code=c&state=s", WEB)).toBeNull();
    expect(toAppReturn(`${WEB}/connectors/finished#code=c`, WEB)).toBeNull();
    expect(toAppReturn(`${WEB}/connectors/finish?code=c`, WEB)).toBeNull();
  });
});
