import { describe, it, expect, afterEach, vi } from "vitest";
import { oauth2AuthCode } from "../oauth2-authcode";

vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn(async () => "rt-current") }));

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
afterEach(() => {
  vi.restoreAllMocks();
});

function make(over: Partial<Parameters<typeof oauth2AuthCode>[0]> = {}) {
  return oauth2AuthCode({
    slug: "t_ads",
    authorizeUrl: "https://v.example/authorize",
    tokenUrl: "https://v.example/token",
    scopes: ["a", "b"],
    clientAuth: "body",
    creds: () => ({ id: "cid", secret: "csec" }),
    accessTokenKey: "t_ads.access_token",
    refreshTokenKey: "t_ads.refresh_token",
    defaultTtlSec: 3600,
    identify: async () => ({ team_id: "acct-1", team_name: "Acct" }),
    ...over,
  });
}

describe("authorizeUrl", () => {
  it("emits client_id, response_type, redirect_uri, state, scope", () => {
    const u = new URL(make().authorizeUrl("st", "https://api.zaviagent.com/cb"));
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("redirect_uri")).toBe("https://api.zaviagent.com/cb");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("scope")).toBe("a b");
  });
  it("honours a comma scope separator (Pinterest) and omits scope when empty (Spotify)", () => {
    expect(new URL(make({ scopeSeparator: "," }).authorizeUrl("s", "https://x/cb")).searchParams.get("scope")).toBe("a,b");
    expect(new URL(make({ scopes: [] }).authorizeUrl("s", "https://x/cb")).searchParams.has("scope")).toBe(false);
  });
  it("appends extraAuthorizeParams (Microsoft response_mode)", () => {
    const u = new URL(make({ extraAuthorizeParams: { response_mode: "query" } }).authorizeUrl("s", "https://x/cb"));
    expect(u.searchParams.get("response_mode")).toBe("query");
  });
});

describe("exchangeCode — client auth placement", () => {
  it("clientAuth=body puts client_id/secret IN THE FORM (LinkedIn, Snapchat, Microsoft)", async () => {
    let body = "", auth: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      body = String(init.body); auth = (init.headers as Record<string, string>).Authorization;
      return ok({ access_token: "at", refresh_token: "rt", expires_in: 100 });
    }));
    await make().exchangeCode("CODE", "https://x/cb");
    const p = new URLSearchParams(body);
    expect(p.get("client_id")).toBe("cid");
    expect(p.get("client_secret")).toBe("csec");
    expect(p.get("grant_type")).toBe("authorization_code");
    expect(p.get("code")).toBe("CODE");
    expect(auth).toBeUndefined();
  });
  it("clientAuth=basic puts them in a Basic header and NOT the form (Spotify, Pinterest)", async () => {
    let body = "", auth = "";
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      body = String(init.body); auth = (init.headers as Record<string, string>).Authorization;
      return ok({ access_token: "at", refresh_token: "rt" });
    }));
    await make({ clientAuth: "basic" }).exchangeCode("CODE", "https://x/cb");
    expect(auth).toBe(`Basic ${Buffer.from("cid:csec").toString("base64")}`);
    expect(new URLSearchParams(body).has("client_secret")).toBe(false);
  });
  it("sends extraExchangeParams (Pinterest continuous_refresh)", async () => {
    let body = "";
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => { body = String(init.body); return ok({ access_token: "at", refresh_token: "rt" }); }));
    await make({ extraExchangeParams: { continuous_refresh: "true" } }).exchangeCode("c", "https://x/cb");
    expect(new URLSearchParams(body).get("continuous_refresh")).toBe("true");
  });
  it("REFUSES a response without a refresh token — the connection would silently die", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ access_token: "at", expires_in: 100 })));
    await expect(make().exchangeCode("c", "https://x/cb")).rejects.toThrow(/refresh_token/);
  });
  it("persists refresh_token_expires_in as an ISO date (LinkedIn's fixed 1y grant)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ access_token: "at", refresh_token: "rt", expires_in: 100, refresh_token_expires_in: 3600 })));
    const r = await make().exchangeCode("c", "https://x/cb");
    expect(r.secrets["t_ads.refresh_expires_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("uses defaultTtlSec when the vendor omits expires_in, and merges identify extraSecrets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ access_token: "at", refresh_token: "rt" })));
    const r = await make({ defaultTtlSec: 777, identify: async () => ({ team_id: "a", team_name: "A", extraSecrets: { "t_ads.extra": "x" } }) })
      .exchangeCode("c", "https://x/cb");
    expect(r.expiresInSec).toBe(777);
    expect(r.secrets["t_ads.extra"]).toBe("x");
  });
});

describe("refreshToken", () => {
  it("keeps the current refresh token when none is returned, persists a rotated one when it is", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ access_token: "at2", expires_in: 50 })));
    let r = await make().refreshToken("tenant");
    expect(r.secrets["t_ads.refresh_token"]).toBe("rt-current");
    vi.stubGlobal("fetch", vi.fn(async () => ok({ access_token: "at3", refresh_token: "rt-new" })));
    r = await make().refreshToken("tenant");
    expect(r.secrets["t_ads.refresh_token"]).toBe("rt-new");
  });
  it("sends extraRefreshParams (Microsoft must re-send the scope on refresh)", async () => {
    let body = "";
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => { body = String(init.body); return ok({ access_token: "at" }); }));
    await make({ extraRefreshParams: { scope: "https://ads.microsoft.com/msads.manage" } }).refreshToken("tenant");
    expect(new URLSearchParams(body).get("scope")).toBe("https://ads.microsoft.com/msads.manage");
  });
  it("never leaks the vendor body — a failing status reports only the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"bad","secret_echo":"csec"}', { status: 400 })));
    await expect(make().refreshToken("tenant")).rejects.toThrow(/HTTP 400$/);
  });
});
