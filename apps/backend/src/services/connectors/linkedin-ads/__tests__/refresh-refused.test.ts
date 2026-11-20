import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  expiresAt: null as string | null,
  access: "at-live",
  marks: [] as Array<{ tenant: string; fn: string; args: Record<string, unknown> }>,
  persisted: [] as unknown[],
  tokenAnswer: (() => new Response("{}", { status: 500 })) as () => Response | Promise<Response>,
  apiAnswer: (() => new Response("{}", { status: 500 })) as (token: string) => Response,
  calls: [] as string[],
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        update: () => q,
        maybeSingle: async () => ({ data: { token_expires_at: s.expiresAt, team_id: null }, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
      };
      return q;
    },
    rpc: async (_fn: string, args: unknown) => {
      s.persisted.push(args);
      return { error: null };
    },
  }),
}));
vi.mock("@/services/secrets/vault", () => ({
  getSecret: async (_t: string, key: string) => (key === "linkedin_ads.refresh_token" ? "rt-stored" : s.access),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: async (tenant: string, fn: string, args: Record<string, unknown>) => {
    s.marks.push({ tenant, fn, args });
    return { data: null, error: null };
  },
  tenantClient: () => ({
    from: () => {
      const q: any = { select: () => q, eq: () => q, order: () => q, in: () => q, range: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: null, error: null }) };
      return q;
    },
  }),
  globalClient: () => ({
    from: () => {
      const q: any = { select: () => q, eq: () => q, in: () => q, range: async () => ({ data: [], error: null }) };
      return q;
    },
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (e: Record<string, unknown>) => { s.events.push(e); } }));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({ linkedinCampaign: vi.fn() }));
vi.mock("@/services/connectors/core/registry", async () => {
  const { linkedinAdsConnector } = await import("../oauth");
  return { getConnector: (slug: string) => (slug === "linkedin_ads" ? linkedinAdsConnector : undefined) };
});

import { listLinkedInAdAccounts, listLinkedInCampaigns } from "../client";
import { classifyAdReadError, isRetryableAdReadKind } from "@/services/connectors/core/read-error-kind";
import { build, type LinkedinAdsPayload } from "@/routes/agents/dashboards/linkedin-ads";
import { ExpectedToolError } from "@/services/tools/types";

const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const RECONNECT = "LinkedIn Ads needs to be reconnected. Reconnect it from Connectors in the left menu.";
const REVOKED_MARK = { p_slug: "linkedin_ads", p_secrets: {}, p_expires_at: "1970-01-01T00:00:00.000Z" };
let seq = 0;

const body = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error & { code?: string });
const dashboard = (tenantId: string) =>
  build({
    tenantId,
    rangeDays: 30,
    refresh: true,
    meteredRefresh: false,
    sb: { from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) }; return q; } },
  } as unknown as Parameters<typeof build>[0]) as Promise<LinkedinAdsPayload>;

beforeEach(() => {
  seq += 1;
  s.access = `at-${seq}`;
  s.expiresAt = new Date(Date.now() - 60_000).toISOString();
  s.marks = [];
  s.persisted = [];
  s.calls = [];
  s.events = [];
  process.env.LINKEDIN_ADS_CLIENT_ID = "cid";
  process.env.LINKEDIN_ADS_CLIENT_SECRET = "csecret";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      s.calls.push(u.startsWith(TOKEN_URL) ? "token" : "api");
      if (u.startsWith(TOKEN_URL)) return s.tokenAnswer();
      const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
      return s.apiAnswer(auth.replace("Bearer ", ""));
    }),
  );
});

afterEach(() => {
  delete process.env.PRAXIS_VARIANTS_LAB;
  vi.unstubAllGlobals();
});

describe("a LinkedIn Ads refresh token that LinkedIn refuses", () => {
  it("invalid_grant on the near-expiry refresh: every read says reconnect and the connection is marked for reconnecting, with no Marketing API call", async () => {
    s.tokenAnswer = () => body(400, { error: "invalid_grant", error_description: "The provided authorization grant is invalid, expired or revoked" });
    const e = await failure(listLinkedInAdAccounts(`t-grant-${seq}`));
    expect(e).toBeInstanceOf(ExpectedToolError);
    expect(e).toMatchObject({ code: "linkedin_ads_token_revoked", message: RECONNECT });
    expect(classifyAdReadError(e)).toBe("auth");
    expect(s.marks).toEqual([{ tenant: `t-grant-${seq}`, fn: "refresh_connector_secrets", args: REVOKED_MARK }]);
    expect(s.calls).toEqual(["token"]);
    expect(s.persisted).toEqual([]);
  });

  it("the dashboard shows the reconnect error code, not a generic read failure", async () => {
    s.tokenAnswer = () => body(400, { error: "invalid_grant" });
    const p = await dashboard(`t-dash-grant-${seq}`);
    expect(p.connected).toBe(true);
    expect(p.error_code).toBe("linkedin_ads_token_revoked");
    expect(s.marks.map((m) => m.args)).toContainEqual(REVOKED_MARK);
  });

  it.each([
    ["a 401 carrying invalid_grant", () => body(401, { error: "invalid_grant" })],
    ["a 200 carrying invalid_grant", () => body(200, { error: "invalid_grant" })],
    ["an expired_token code", () => body(400, { error: "expired_token" })],
    ["a revoked_token code", () => body(400, { error: "revoked_token" })],
    ["invalid_request saying the refresh token expired", () => body(400, { error: "invalid_request", error_description: "The refresh token has expired" })],
    ["invalid_request saying the refresh token was revoked", () => body(400, { error: "invalid_request", error_description: "This refresh_token was revoked by the member" })],
  ])("%s means the founder must reconnect", async (_label, answer) => {
    s.tokenAnswer = answer;
    expect(await failure(listLinkedInCampaigns(`t-dead-${seq}`, "7"))).toMatchObject({ code: "linkedin_ads_token_revoked" });
    expect(s.marks).toHaveLength(1);
    expect(s.events).toEqual([]);
  });

  it("a Marketing API 401 whose forced refresh is refused marks the connection and makes no second API call", async () => {
    s.expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    s.apiAnswer = () => new Response("{}", { status: 401 });
    s.tokenAnswer = () => body(400, { error: "invalid_grant" });
    const e = await failure(listLinkedInAdAccounts(`t-api401-${seq}`));
    expect(e).toMatchObject({ code: "linkedin_ads_token_revoked", meta: { refresh_refused: true } });
    expect(s.marks.map((m) => m.args)).toEqual([REVOKED_MARK]);
    expect(s.calls).toEqual(["api", "token"]);
  });
});

describe("a LinkedIn Ads refresh that fails for a passing reason", () => {
  it("a 503 stays a retryable could-not-read and never marks the connection", async () => {
    s.tokenAnswer = () => body(503, { error: "temporarily_unavailable" });
    const e = await failure(listLinkedInAdAccounts(`t-503-${seq}`));
    expect(e?.code).not.toBe("linkedin_ads_token_revoked");
    expect(isRetryableAdReadKind(classifyAdReadError(e))).toBe(true);
    expect(s.marks).toEqual([]);
    const p = await dashboard(`t-dash-503-${seq}`);
    expect(p.error_code).toBe("linkedin_ads_http_error");
    expect(s.marks).toEqual([]);
  });

  it("a network failure on the token endpoint never marks the connection", async () => {
    s.tokenAnswer = () => {
      throw new TypeError("fetch failed");
    };
    const e = await failure(listLinkedInAdAccounts(`t-net-${seq}`));
    expect(e?.code).not.toBe("linkedin_ads_token_revoked");
    expect(s.marks).toEqual([]);
  });

  describe.each([
    ["a 500", () => body(500, {}), "linkedin_ads_http_error", "vendor_error", 500],
    ["a 503", () => body(503, { error: "temporarily_unavailable" }), "linkedin_ads_http_error", "vendor_error", 503],
    ["a 408", () => body(408, {}), "linkedin_ads_http_error", "timeout", 408],
    ["a 429", () => body(429, {}), "linkedin_ads_http_error", "rate_limited", 429],
    ["a 503 whose body says invalid_grant", () => body(503, { error: "invalid_grant" }), "linkedin_ads_http_error", "vendor_error", 503],
    ["a 503 whose body says the refresh token expired", () => body(503, { error: "server_error", error_description: "refresh token expired" }), "linkedin_ads_http_error", "vendor_error", 503],
    ["a 429 whose body says invalid_grant", () => body(429, { error: "invalid_grant" }), "linkedin_ads_http_error", "rate_limited", 429],
    ["a network failure", () => { throw new TypeError("fetch failed"); }, "linkedin_ads_http_error", "vendor_error", undefined],
    ["an answer that is not JSON", () => new Response("<html>gateway</html>", { status: 200 }), "linkedin_ads_http_error", "vendor_error", undefined],
  ])("LinkedIn down during a refresh: %s", (_label, answer, code, kind, status) => {
    const expectOutage = (e: (Error & { code?: string; meta?: Record<string, unknown> }) | null) => {
      expect(e).toBeInstanceOf(ExpectedToolError);
      expect(e?.code).toBe(code);
      expect(e?.message).not.toMatch(/reconnect/i);
      expect(e?.message).toMatch(/try again/i);
      expect(classifyAdReadError(e)).toBe(kind);
      expect(isRetryableAdReadKind(classifyAdReadError(e))).toBe(true);
      expect(e?.meta?.http_status).toBe(status);
      expect(s.marks).toEqual([]);
    };

    it("a Marketing API 401 whose forced refresh hits it keeps the connection, no reconnect words, no second API call", async () => {
      s.expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
      s.apiAnswer = () => new Response("{}", { status: 401 });
      s.tokenAnswer = answer;
      expectOutage((await failure(listLinkedInAdAccounts(`t-out-api-${seq}`))) as never);
      expect(s.calls).toEqual(["api", "token"]);
    });

    it("the near-expiry refresh hitting it keeps the connection, no reconnect words, no API call", async () => {
      s.tokenAnswer = answer;
      expectOutage((await failure(listLinkedInAdAccounts(`t-out-near-${seq}`))) as never);
      expect(s.calls).toEqual(["token"]);
    });

    it("the dashboard after a forced refresh hits it never carries the reconnect code", async () => {
      s.expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
      s.apiAnswer = () => new Response("{}", { status: 401 });
      s.tokenAnswer = answer;
      const p = await dashboard(`t-out-dash-${seq}`);
      expect(p.error_code).toBe(status === 429 ? "linkedin_ads_rate_limited" : code);
      expect(s.marks).toEqual([]);
    });
  });

  describe.each([
    ["invalid_client on a 401 (a bad client secret)", 401, { error: "invalid_client" }, "invalid_client"],
    ["invalid_client on a 400", 400, { error: "invalid_client", error_description: "Client authentication failed; refresh token not checked as expired" }, "invalid_client"],
    ["a bare 401 with no code", 401, null, null],
    ["a bare 400 with no code", 400, null, null],
    ["invalid_request for a missing parameter", 400, { error: "invalid_request", error_description: "A required parameter \"client_id\" is missing" }, "invalid_request"],
    ["unsupported_grant_type", 400, { error: "unsupported_grant_type" }, "unsupported_grant_type"],
    ["unauthorized_client", 400, { error: "unauthorized_client" }, "unauthorized_client"],
    ["a 403", 403, { error: "access_denied" }, "access_denied"],
  ])("%s is Zavi's fault, not the founder's", (_label, status, json, code) => {
    const answer = () => (json ? body(status as number, json) : new Response("", { status: status as number }));

    it("never marks the connection, never says reconnect, classes as no login problem, and logs for Zavi with no secret", async () => {
      s.tokenAnswer = answer;
      const e = await failure(listLinkedInAdAccounts(`t-fault-${seq}`));
      expect(e).toBeInstanceOf(ExpectedToolError);
      expect(e?.code).toBe("linkedin_ads_zavi_fault");
      expect(e?.message).not.toMatch(/reconnect/i);
      expect(classifyAdReadError(e)).toBe("unknown");
      expect(isRetryableAdReadKind(classifyAdReadError(e))).toBe(false);
      expect(s.marks).toEqual([]);
      expect(s.calls).toEqual(["token"]);
      expect(s.events).toEqual([expect.objectContaining({ level: "error", code: "linkedin_ads.refresh_zavi_fault", tenant_id: `t-fault-${seq}`, meta: { http_status: status, oauth_error: code } })]);
      expect(JSON.stringify(s.events)).not.toMatch(/csecret|rt-stored/);
    });

    it("the dashboard shows a read problem, never the reconnect code", async () => {
      s.tokenAnswer = answer;
      const p = await dashboard(`t-dash-fault-${seq}`);
      expect(p.error_code).toBe("linkedin_ads_zavi_fault");
      expect(s.marks).toEqual([]);
    });

    it("a Marketing API 401 whose forced refresh fails this way does not tell the founder to reconnect either, and makes no second API call", async () => {
      s.expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
      s.apiAnswer = () => new Response("{}", { status: 401 });
      s.tokenAnswer = answer;
      const e = await failure(listLinkedInAdAccounts(`t-fault-api-${seq}`));
      expect(e?.code).toBe("linkedin_ads_zavi_fault");
      expect(s.marks).toEqual([]);
      expect(s.calls).toEqual(["api", "token"]);
    });
  });

  it.each([[429], [408]])("a %i stays a passing could-not-read, never Zavi's fault and never a mark", async (status) => {
    s.tokenAnswer = () => body(status, {});
    const e = await failure(listLinkedInAdAccounts(`t-busy-${seq}`));
    expect(e?.code).not.toBe("linkedin_ads_token_revoked");
    expect(e?.code).not.toBe("linkedin_ads_zavi_fault");
    expect(isRetryableAdReadKind(classifyAdReadError(e))).toBe(true);
    expect(s.marks).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it("the variants lab refusal on a forced refresh keeps its own words instead of blaming LinkedIn", async () => {
    process.env.PRAXIS_VARIANTS_LAB = "1";
    s.expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    s.apiAnswer = () => new Response("{}", { status: 401 });
    const e = await failure(listLinkedInAdAccounts(`t-lab-forced-${seq}`));
    expect(e?.message).toMatch(/variants lab/);
    expect(s.marks).toEqual([]);
  });

  it("the variants lab refuses to refresh without calling LinkedIn and without marking the connection", async () => {
    process.env.PRAXIS_VARIANTS_LAB = "1";
    s.tokenAnswer = () => body(400, { error: "invalid_grant" });
    const e = await failure(listLinkedInAdAccounts(`t-lab-${seq}`));
    expect(e?.message).toMatch(/variants lab/);
    expect(s.calls).toEqual([]);
    expect(s.marks).toEqual([]);
  });

  it("a successful refresh persists the new token and serves the read", async () => {
    s.tokenAnswer = () => body(200, { access_token: `at-new-${seq}`, expires_in: 5_184_000 });
    s.apiAnswer = (token) => (token === `at-new-${seq}` || token === s.access ? body(200, { elements: [{ id: 7, name: "Own", currency: "USD", status: "ACTIVE" }] }) : new Response("{}", { status: 401 }));
    expect(await listLinkedInAdAccounts(`t-ok-${seq}`)).toEqual([{ id: "7", name: "Own", currency: "USD", status: "ACTIVE" }]);
    expect(s.persisted).toHaveLength(1);
    expect(s.marks).toEqual([]);
  });
});
