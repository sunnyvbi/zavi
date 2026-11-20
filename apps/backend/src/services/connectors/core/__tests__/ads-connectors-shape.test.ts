import { describe, it, expect, beforeEach, afterEach } from "vitest";

const OLD = { ...process.env };
beforeEach(() => {
  for (const p of ["LINKEDIN_ADS", "SNAPCHAT_ADS", "SPOTIFY_ADS", "PINTEREST_ADS", "MICROSOFT_ADS"]) {
    process.env[`${p}_CLIENT_ID`] = `${p.toLowerCase()}-id`;
    process.env[`${p}_CLIENT_SECRET`] = "s";
  }
});
afterEach(() => { process.env = { ...OLD }; });

const CASES = [
  { mod: "../../linkedin-ads/oauth", exp: "linkedinAdsConnector", slug: "linkedin_ads", host: "www.linkedin.com", scope: "r_ads r_ads_reporting rw_ads r_organization_social" },
  { mod: "../../snapchat-ads/oauth", exp: "snapchatAdsConnector", slug: "snapchat_ads", host: "accounts.snapchat.com", scope: "snapchat-marketing-api" },
  { mod: "../../spotify-ads/oauth", exp: "spotifyAdsConnector", slug: "spotify_ads", host: "accounts.spotify.com", scope: null },
  { mod: "../../pinterest-ads/oauth", exp: "pinterestAdsConnector", slug: "pinterest_ads", host: "www.pinterest.com", scope: "ads:read" },
  { mod: "../../microsoft-ads/oauth", exp: "microsoftAdsConnector", slug: "microsoft_ads", host: "login.microsoftonline.com", scope: "https://ads.microsoft.com/msads.manage offline_access" },
] as const;

describe.each(CASES)("$slug", ({ mod, exp, slug, host, scope }) => {
  it("slug/serverId match, declares a refresh path, no codeParam override", async () => {
    const c = (await import(mod))[exp];
    expect(c.slug).toBe(slug);
    expect(c.serverId).toBe(slug);
    expect(typeof c.refreshToken).toBe("function");
    expect(c.codeParam).toBeUndefined();
  });
  it("authorize URL points at the vendor with the read-only scope set", async () => {
    const c = (await import(mod))[exp];
    const u = new URL(c.authorizeUrl("st8", "https://api.zaviagent.com/api/connectors/x/callback"));
    expect(u.host).toBe(host);
    expect(u.searchParams.get("state")).toBe("st8");
    expect(u.searchParams.get("response_type")).toBe("code");
    if (scope === null) expect(u.searchParams.has("scope")).toBe(false);
    else expect(u.searchParams.get("scope")).toBe(scope);
  });
});

it("pinterest_ads NEVER requests ads:write (its channel has no write rail)", async () => {
  const pi = (await import("../../pinterest-ads/oauth")).pinterestAdsConnector;
  expect(pi.scopes).not.toContain("ads:write");
});

it("microsoft_ads uses the published sandbox developer token only when MICROSOFT_ADS_SANDBOX=1", async () => {
  const { microsoftAdsDeveloperToken, microsoftAdsHost } = await import("../../microsoft-ads/constants");
  delete process.env.MICROSOFT_ADS_DEVELOPER_TOKEN;
  expect(() => microsoftAdsDeveloperToken()).toThrow(/MICROSOFT_ADS_DEVELOPER_TOKEN/);
  process.env.MICROSOFT_ADS_SANDBOX = "1";
  expect(microsoftAdsDeveloperToken()).toBe("BBD37VB98");
  expect(microsoftAdsHost("campaign")).toContain(".sandbox.");
});
