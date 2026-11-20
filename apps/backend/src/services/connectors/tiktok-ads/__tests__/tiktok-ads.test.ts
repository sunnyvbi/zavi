
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tiktokAdsConnector, tiktokAdsAuthorizeUrl, tiktokAdsExchangeCode } from "../oauth";
import { tiktokAdsEnabled } from "../constants";

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env.TIKTOK_ADS_APP_ID = "app-1";
  process.env.TIKTOK_ADS_SECRET = "sec-1";
  delete process.env.TIKTOK_ADS_AUTHORIZE_URL;
  delete process.env.TIKTOK_ADS_SANDBOX;
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
  vi.resetModules();
});

const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, message: "OK", data }), { status: 200 });

describe("codeParam — the both-code-and-auth_code trap", () => {
  it('declares auth_code, NOT code — TikTok returns both and only auth_code redeems', () => {
    expect(tiktokAdsConnector.codeParam).toBe("auth_code");
  });

  it("declares NO refreshToken — TikTok long-term tokens never expire", () => {
    expect(tiktokAdsConnector.refreshToken).toBeUndefined();
  });
});

describe("tiktokAdsAuthorizeUrl", () => {
  it("prefers the portal-pasted URL and only appends state", () => {
    process.env.TIKTOK_ADS_AUTHORIZE_URL =
      "https://business-api.tiktok.com/portal/auth?app_id=999&redirect_uri=https%3A%2F%2Fapi.zaviagent.com%2Fcb";
    const u = new URL(tiktokAdsAuthorizeUrl("st8", "ignored"));
    expect(u.searchParams.get("state")).toBe("st8");
    expect(u.searchParams.get("app_id")).toBe("999");
  });

  it("falls back to the constructed shape when no portal URL is configured", () => {
    const u = new URL(tiktokAdsAuthorizeUrl("st8", "https://api.zaviagent.com/cb"));
    expect(u.searchParams.get("app_id")).toBe("app-1");
    expect(u.searchParams.get("state")).toBe("st8");
    expect(u.searchParams.get("redirect_uri")).toBe("https://api.zaviagent.com/cb");
  });

  it("throws when the app is not provisioned (safe-inert)", () => {
    delete process.env.TIKTOK_ADS_APP_ID;
    delete process.env.TIKTOK_ADS_SECRET;
    expect(() => tiktokAdsAuthorizeUrl("s", "https://x/cb")).toThrow(/TIKTOK_ADS_APP_ID/);
  });

  it("tiktokAdsEnabled gates the whole surface on credentials", () => {
    expect(tiktokAdsEnabled()).toBe(true);
    delete process.env.TIKTOK_ADS_APP_ID;
    expect(tiktokAdsEnabled()).toBe(false);
  });
});

describe("tiktokAdsExchangeCode", () => {
  it("sends auth_code and NO grant_type (/oauth2/access_token/ rejects grant_type)", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return ok({ access_token: "at", advertiser_ids: ["123"], scope: [100, 200] });
      }),
    );
    await tiktokAdsExchangeCode("AUTHCODE", "https://api.zaviagent.com/cb");
    expect(body.auth_code).toBe("AUTHCODE");
    expect(body.app_id).toBe("app-1");
    expect(body).not.toHaveProperty("grant_type");
    expect(body).not.toHaveProperty("code");
  });

  it("returns NO expiresInSec — a recorded expiry would trigger a refresh that cannot exist", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ access_token: "at", advertiser_ids: ["123"] })));
    const res = await tiktokAdsExchangeCode("c", "https://x/cb");
    expect(res.expiresInSec).toBeUndefined();
  });

  it("persists advertiser_ids from the token response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok({ access_token: "at", advertiser_ids: ["123", "456"] })),
    );
    const res = await tiktokAdsExchangeCode("c", "https://x/cb");
    expect(JSON.parse(res.secrets["tiktok_ads.advertiser_ids"])).toEqual(["123", "456"]);
    expect(res.metadata.team_name).toContain("2 advertisers");
  });

  it("stringifies snowflake scope ids — a 19-digit id loses precision as a JS number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          '{"code":0,"message":"OK","data":{"access_token":"at","scope":[100,"7043626160646946818"],"advertiser_ids":["1"]}}',
          { status: 200 },
        ),
      ),
    );
    const res = await tiktokAdsExchangeCode("c", "https://x/cb");
    expect(res.metadata.scopes).toContain("7043626160646946818");
    expect(res.metadata.scopes.every((s) => typeof s === "string")).toBe(true);
  });

  it("FAILS on HTTP 200 with a non-zero business code (TikTok's failure shape)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 40105, message: "invalid auth_code" }), {
            status: 200,
          }),
      ),
    );
    await expect(tiktokAdsExchangeCode("bad", "https://x/cb")).rejects.toThrow(/40105/);
  });

  it("accepts code 20001 (partially successful) — a token was still issued", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: 20001, message: "partial", data: { access_token: "at" } }),
            { status: 200 },
          ),
      ),
    );
    const res = await tiktokAdsExchangeCode("c", "https://x/cb");
    expect(res.secrets["tiktok_ads.access_token"]).toBe("at");
  });
});

describe("transport quirks", () => {
  it("appends a trailing slash BEFORE the query string (404 without it)", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        seen.push(String(u));
        return ok({ list: [] });
      }),
    );
    const { tiktokAdsGet } = await import("../http");
    await tiktokAdsGet("tok", "campaign/get", { advertiser_id: "1" });
    expect(seen[0]).toContain("/campaign/get/?");
  });

  it("JSON-encodes array params (advertiser_ids=[\"1\",\"2\"], not repeated keys)", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        seen.push(String(u));
        return ok({ list: [] });
      }),
    );
    const { tiktokAdsGet } = await import("../http");
    await tiktokAdsGet("tok", "advertiser/info", { advertiser_ids: ["1", "2"] });
    const q = new URL(seen[0]).searchParams.get("advertiser_ids");
    expect(q).toBe('["1","2"]');
  });

  it("uses the Access-Token header, not Authorization: Bearer", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>;
        return ok({});
      }),
    );
    const { tiktokAdsGet } = await import("../http");
    await tiktokAdsGet("tok-123", "advertiser/info");
    expect(headers["Access-Token"]).toBe("tok-123");
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("treats HTTP 200 + non-zero code as an ERROR, not an empty success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 40102, message: "token expired" }), { status: 200 }),
      ),
    );
    const { tiktokAdsGet } = await import("../http");
    await expect(tiktokAdsGet("tok", "campaign/get")).rejects.toMatchObject({
      code: "tiktok_ads_token_invalid",
    });
  });

  it("distinguishes app-level (40100) from advertiser-level (40133) rate limits", async () => {
    for (const code of [40100, 40133]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ code, message: "too frequent" }), { status: 200 })),
      );
      vi.resetModules();
      const { tiktokAdsGet } = await import("../http");
      await expect(tiktokAdsGet("tok", "campaign/get")).rejects.toMatchObject({
        code: "tiktok_ads_rate_limited",
      });
    }
  });

  it("sandbox is opt-in per deployment and swaps the host", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        seen.push(String(u));
        return ok({});
      }),
    );
    process.env.TIKTOK_ADS_SANDBOX = "1";
    vi.resetModules();
    const { tiktokAdsGet } = await import("../http");
    await tiktokAdsGet("tok", "campaign/get");
    expect(seen[0]).toContain("sandbox-ads.tiktok.com");
    expect(seen[0]).not.toContain("business-api.tiktok.com");
  });
});
