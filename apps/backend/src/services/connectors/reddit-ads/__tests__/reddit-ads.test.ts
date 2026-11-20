
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { redditAdsAuthorizeUrl, redditAdsRefreshToken } from "../oauth";
import { REDDIT_ADS_API_BASE, REDDIT_ADS_SCOPES } from "../constants";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.REDDIT_ADS_CLIENT_ID = "cid";
  process.env.REDDIT_ADS_CLIENT_SECRET = "csec";
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("redditAdsAuthorizeUrl", () => {
  it("requests duration=permanent — without it the connection dies after 1h", () => {
    const u = new URL(redditAdsAuthorizeUrl("st8", "https://api.zaviagent.com/cb"));
    expect(u.searchParams.get("duration")).toBe("permanent");
  });

  it("requests ONLY adsread — a write scope must be a deliberate re-consent", () => {
    const u = new URL(redditAdsAuthorizeUrl("st8", "https://api.zaviagent.com/cb"));
    expect(u.searchParams.get("scope")).toBe("adsread");
    expect(REDDIT_ADS_SCOPES).not.toContain("adsedit");
  });

  it("carries state + redirect_uri through unmodified", () => {
    const u = new URL(redditAdsAuthorizeUrl("st8", "https://api.zaviagent.com/cb"));
    expect(u.searchParams.get("state")).toBe("st8");
    expect(u.searchParams.get("redirect_uri")).toBe("https://api.zaviagent.com/cb");
    expect(u.origin + u.pathname).toBe("https://www.reddit.com/api/v1/authorize");
  });

  it("falls back to the reddit_social app when no dedicated ads app is set", () => {
    delete process.env.REDDIT_ADS_CLIENT_ID;
    delete process.env.REDDIT_ADS_CLIENT_SECRET;
    process.env.REDDIT_SOCIAL_CLIENT_ID = "social-cid";
    process.env.REDDIT_SOCIAL_CLIENT_SECRET = "social-csec";
    const u = new URL(redditAdsAuthorizeUrl("s", "https://x/cb"));
    expect(u.searchParams.get("client_id")).toBe("social-cid");
  });

  it("throws when neither app is provisioned (safe-inert, not a broken OAuth redirect)", () => {
    delete process.env.REDDIT_ADS_CLIENT_ID;
    delete process.env.REDDIT_ADS_CLIENT_SECRET;
    delete process.env.REDDIT_SOCIAL_CLIENT_ID;
    delete process.env.REDDIT_SOCIAL_CLIENT_SECRET;
    expect(() => redditAdsAuthorizeUrl("s", "https://x/cb")).toThrow(/REDDIT_ADS_CLIENT_ID/);
  });
});

describe("redditAdsRefreshToken", () => {
  it("KEEPS the current refresh token when Reddit returns none (no rotation documented)", async () => {
    vi.doMock("@/services/secrets/vault", () => ({
      getSecret: vi.fn(async () => "rt-original"),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "at-new", expires_in: 3600 }))),
    );
    const { redditAdsRefreshToken: fn } = await import("../oauth");
    const res = await fn("tenant-1");
    expect(res.secrets["reddit_ads.access_token"]).toBe("at-new");
    expect(res.secrets["reddit_ads.refresh_token"]).toBe("rt-original");
  });

  it("persists a ROTATED refresh token when Reddit does return one", async () => {
    vi.doMock("@/services/secrets/vault", () => ({
      getSecret: vi.fn(async () => "rt-original"),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ access_token: "at-new", refresh_token: "rt-rotated", expires_in: 3600 }),
          ),
      ),
    );
    const { redditAdsRefreshToken: fn } = await import("../oauth");
    const res = await fn("tenant-1");
    expect(res.secrets["reddit_ads.refresh_token"]).toBe("rt-rotated");
  });

  it("refuses when the tenant has no stored refresh token", async () => {
    vi.doMock("@/services/secrets/vault", () => ({ getSecret: vi.fn(async () => null) }));
    const { redditAdsRefreshToken: fn } = await import("../oauth");
    await expect(fn("tenant-1")).rejects.toThrow(/not connected/);
  });
});

describe("pagination host guard", () => {
  it("the Ads base is the v3 host, NOT the organic oauth.reddit.com host", () => {
    expect(REDDIT_ADS_API_BASE).toBe("https://ads-api.reddit.com/api/v3");
    expect(REDDIT_ADS_API_BASE).not.toContain("oauth.reddit.com");
  });

  it("stops paging when next_url points off-host (bearer must not leave the Ads API)", async () => {
    vi.doMock("@/services/connectors/core/token", () => ({
      getConnectorToken: vi.fn(async () => "at"),
    }));
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return new Response(
          JSON.stringify({
            data: [{ id: "b1", name: "Biz" }],
            pagination: { next_url: "https://evil.example.com/api/v3/me/businesses" },
          }),
        );
      }),
    );
    const { listRedditAdAccounts } = await import("../client");
    await listRedditAdAccounts("tenant-1");
    expect(seen.some((u) => u.includes("evil.example.com"))).toBe(false);
  });
});
