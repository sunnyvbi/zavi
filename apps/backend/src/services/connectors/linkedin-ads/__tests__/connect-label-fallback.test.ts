import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ list: vi.fn(), urls: [] as string[] }));
vi.mock("../client", () => ({ listLinkedInAdAccountsRaw: m.list }));

import { linkedinAdsConnector } from "../oauth";

const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

beforeEach(() => {
  vi.stubEnv("LINKEDIN_ADS_CLIENT_ID", "client-id");
  vi.stubEnv("LINKEDIN_ADS_CLIENT_SECRET", "client-secret");
  m.list.mockReset();
  m.urls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    m.urls.push(String(url));
    if (String(url) !== TOKEN_URL) throw new Error(`unexpected LinkedIn call ${url}`);
    return new Response(JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 5184000, refresh_token_expires_in: 31536000, scope: "r_ads,rw_ads" }), { status: 200 });
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("LinkedIn Ads Connect when the ad account list cannot be read", () => {
  it.each([
    ["rate limited until midnight UTC", Object.assign(new Error("linkedin_ads HTTP 429 daily quota"), { status: 429 })],
    ["LinkedIn is down", new Error("linkedin_ads HTTP 503")],
  ])("%s: the tokens are still saved, with a plain fallback label and no account id that could look like a swap", async (_label, err) => {
    m.list.mockRejectedValue(err);
    const out = await linkedinAdsConnector.exchangeCode("code-1", "http://localhost:3011/api/connectors/linkedin_ads/callback");
    expect(out.secrets["linkedin_ads.access_token"]).toBe("at-new");
    expect(out.secrets["linkedin_ads.refresh_token"]).toBe("rt-new");
    expect(out.secrets["linkedin_ads.refresh_expires_at"]).toMatch(/^\d{4}-/);
    expect(out.metadata.team_name).toBe("LinkedIn Ads");
    expect(out.metadata.team_id).toBe("");
    expect(m.list).toHaveBeenCalledTimes(1);
    expect(m.urls).toEqual([TOKEN_URL]);
  });

  it("must not catch: a readable account list still names the first account", async () => {
    m.list.mockResolvedValue([{ id: "508000111", name: "Acme Ads" }, { id: "508000222", name: "Other" }]);
    const out = await linkedinAdsConnector.exchangeCode("code-1", "http://localhost:3011/api/connectors/linkedin_ads/callback");
    expect(out.metadata).toMatchObject({ team_id: "508000111", team_name: "Acme Ads (+1)" });
  });

  it("must not catch: a refused token exchange still fails the sign-in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })));
    await expect(linkedinAdsConnector.exchangeCode("code-1", "http://localhost:3011/api/connectors/linkedin_ads/callback")).rejects.toThrow();
    expect(m.list).not.toHaveBeenCalled();
  });
});
