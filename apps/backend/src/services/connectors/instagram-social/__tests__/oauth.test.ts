
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({ getSecret: vi.fn() }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: m.getSecret }));

import {
  instagramSocialAuthorizeUrl,
  instagramSocialExchangeCode,
  instagramSocialRefreshToken,
} from "../oauth";

const ENV = ["INSTAGRAM_SOCIAL_CLIENT_ID", "INSTAGRAM_SOCIAL_CLIENT_SECRET"] as const;
const prev: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) prev[k] = process.env[k];
  process.env.INSTAGRAM_SOCIAL_CLIENT_ID = "igid";
  process.env.INSTAGRAM_SOCIAL_CLIENT_SECRET = "igsecret";
  m.getSecret.mockReset();
});
afterEach(() => {
  for (const k of ENV) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  vi.unstubAllGlobals();
});

type Call = { url: string; init?: RequestInit };
function stub(routes: Record<string, { status?: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const key = Object.keys(routes).find((k) => String(url).includes(k));
      if (!key) throw new Error(`unexpected ${url}`);
      const r = routes[key];
      const status = r.status ?? 200;
      return { ok: status < 400, status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    }),
  );
  return calls;
}

describe("instagramSocialAuthorizeUrl", () => {
  it("targets instagram.com with COMMA-separated business scopes and echoes state/redirect", () => {
    const u = new URL(instagramSocialAuthorizeUrl("st-1", "http://localhost:3001/api/connectors/instagram_social/callback"));
    expect(u.origin + u.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("igid");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_content_publish");
    expect(u.searchParams.get("state")).toBe("st-1");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3001/api/connectors/instagram_social/callback");
  });

  it("throws a configuration error when the Instagram app credentials are absent", () => {
    delete process.env.INSTAGRAM_SOCIAL_CLIENT_ID;
    expect(() => instagramSocialAuthorizeUrl("s", "http://x/cb")).toThrow(/INSTAGRAM_SOCIAL_CLIENT_ID/);
  });
});

describe("instagramSocialExchangeCode", () => {
  const happy = {
    "api.instagram.com/oauth/access_token": {
      body: { access_token: "short", user_id: 17841400000, permissions: ["instagram_business_basic", "instagram_business_content_publish"] },
    },
    "graph.instagram.com/access_token": { body: { access_token: "long60", token_type: "bearer", expires_in: 5183944 } },
    "/me?fields=user_id,username": { body: { id: "17841400000", user_id: "17841499999", username: "zavi.growth" } },
  };

  it("exchanges the code, swaps to a LONG-lived token, stores the professional user_id + username", async () => {
    const calls = stub(happy);
    const r = await instagramSocialExchangeCode("code-1", "http://localhost:3001/cb");

    const tok = calls.find((c) => c.url.includes("api.instagram.com/oauth/access_token"))!;
    expect(tok.init?.method).toBe("POST");
    const form = new URLSearchParams(String(tok.init?.body));
    expect(form.get("client_id")).toBe("igid");
    expect(form.get("client_secret")).toBe("igsecret");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe("http://localhost:3001/cb");
    expect(form.get("code")).toBe("code-1");

    const ll = new URL(calls.find((c) => c.url.includes("graph.instagram.com/access_token"))!.url);
    expect(ll.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(ll.searchParams.get("client_secret")).toBe("igsecret");
    expect(ll.searchParams.get("access_token")).toBe("short");

    const me = calls.find((c) => c.url.includes("/me?"))!;
    expect((me.init?.headers as Record<string, string>).Authorization).toBe("Bearer long60");

    expect(r.secrets["instagram_social.access_token"]).toBe("long60");
    expect(r.secrets["instagram_social.user_id"]).toBe("17841499999");
    expect(r.secrets["instagram_social.username"]).toBe("zavi.growth");
    expect(r.expiresInSec).toBe(5183944);
    expect(r.metadata.team_id).toBe("17841499999");
    expect(r.metadata.team_name).toBe("@zavi.growth");
    expect(r.metadata.scopes).toEqual(["instagram_business_basic", "instagram_business_content_publish"]);
  });

  it("surfaces Instagram's error body when the code exchange is refused", async () => {
    stub({ ...happy, "api.instagram.com/oauth/access_token": { status: 400, body: { error_type: "OAuthException", code: 400, error_message: "Invalid authorization code" } } });
    await expect(instagramSocialExchangeCode("bad", "http://x/cb")).rejects.toThrow(/Invalid authorization code/);
  });

  it("refuses when the long-lived swap fails (never persists the 1h token)", async () => {
    stub({ ...happy, "graph.instagram.com/access_token": { status: 400, body: { error: { message: "Invalid platform app" } } } });
    await expect(instagramSocialExchangeCode("c", "http://x/cb")).rejects.toThrow(/long-lived exchange HTTP 400/);
  });
});

describe("instagramSocialRefreshToken", () => {
  it("calls refresh_access_token with the CURRENT long-lived token and stores the new one", async () => {
    m.getSecret.mockResolvedValue("long-old");
    const calls = stub({ "refresh_access_token": { body: { access_token: "long-new", token_type: "bearer", expires_in: 5184000 } } });
    const r = await instagramSocialRefreshToken("73db45ff-457e-4541-bc8f-bdb625390204");
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/refresh_access_token");
    expect(u.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(u.searchParams.get("access_token")).toBe("long-old");
    expect(r.secrets).toEqual({ "instagram_social.access_token": "long-new" });
    expect(r.expiresInSec).toBe(5184000);
  });

  it("throws when not connected", async () => {
    m.getSecret.mockResolvedValue(null);
    await expect(instagramSocialRefreshToken("t")).rejects.toThrow(/not connected/);
  });
});
