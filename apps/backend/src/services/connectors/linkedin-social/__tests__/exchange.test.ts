
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { linkedinSocialExchangeCode } from "../oauth";

const ENV = ["LINKEDIN_SOCIAL_CLIENT_ID", "LINKEDIN_SOCIAL_CLIENT_SECRET"] as const;
const prev: Record<string, string | undefined> = {};

function stubFetch(tokenJson: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/oauth/v2/accessToken")) {
        return { ok: true, status: 200, json: async () => tokenJson, text: async () => "" };
      }
      if (String(url).includes("/v2/userinfo")) {
        return { ok: true, status: 200, json: async () => ({ sub: "9316_hXyZ", name: "Developer Zavi" }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

beforeEach(() => {
  for (const k of ENV) prev[k] = process.env[k];
  process.env.LINKEDIN_SOCIAL_CLIENT_ID = "test-client";
  process.env.LINKEDIN_SOCIAL_CLIENT_SECRET = "test-secret";
});
afterEach(() => {
  for (const k of ENV) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  vi.unstubAllGlobals();
});

describe("linkedinSocialExchangeCode", () => {
  it("splits LinkedIn's COMMA-separated scope string into individual scopes", async () => {
    stubFetch({ access_token: "tok", expires_in: 5184000, scope: "openid,profile,w_member_social" });
    const r = await linkedinSocialExchangeCode("code", "https://api.example/cb");
    expect(r.metadata.scopes).toEqual(["openid", "profile", "w_member_social"]);
    expect(r.metadata.scopes).toContain("w_member_social");
  });

  it("also accepts space-separated scope (RFC 6749 form)", async () => {
    stubFetch({ access_token: "tok", expires_in: 5184000, scope: "openid profile w_member_social" });
    const r = await linkedinSocialExchangeCode("code", "https://api.example/cb");
    expect(r.metadata.scopes).toEqual(["openid", "profile", "w_member_social"]);
  });

  it("builds the person URN from userinfo.sub and stores it alongside the token", async () => {
    stubFetch({ access_token: "tok_abc", expires_in: 5184000, scope: "openid,profile,w_member_social" });
    const r = await linkedinSocialExchangeCode("code", "https://api.example/cb");
    expect(r.secrets["linkedin_social.access_token"]).toBe("tok_abc");
    expect(r.secrets["linkedin_social.author_urn"]).toBe("urn:li:person:9316_hXyZ");
    expect(r.metadata.team_id).toBe("9316_hXyZ");
    expect(r.metadata.team_name).toBe("Developer Zavi");
  });

  it("carries LinkedIn's 60-day TTL through so the expiry cliff is recorded", async () => {
    stubFetch({ access_token: "tok", expires_in: 5184000, scope: "openid,profile,w_member_social" });
    const r = await linkedinSocialExchangeCode("code", "https://api.example/cb");
    expect(r.expiresInSec).toBe(5184000);
  });

  it("falls back to 60 days when LinkedIn omits expires_in", async () => {
    stubFetch({ access_token: "tok", scope: "openid,profile,w_member_social" });
    const r = await linkedinSocialExchangeCode("code", "https://api.example/cb");
    expect(r.expiresInSec).toBe(60 * 24 * 60 * 60);
  });

  it("refuses a token response with no access_token", async () => {
    stubFetch({ scope: "openid" });
    await expect(linkedinSocialExchangeCode("code", "https://api.example/cb")).rejects.toThrow(/missing access_token/);
  });
});
