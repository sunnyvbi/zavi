import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getSecret = vi.fn();
vi.mock("@/services/secrets/vault", () => ({ getSecret: (...a: unknown[]) => getSecret(...a) }));

import { gadsSearch, gadsMutate, createGoogleAdsReadSession, GADS_BASE } from "../_client";
import { GOOGLE_ADS_API_VERSION, GOOGLE_ADS_VAULT_KEYS } from "../keys";

const ENV = {
  GOOGLE_ADS_CLIENT_ID: "cid",
  GOOGLE_ADS_CLIENT_SECRET: "csecret",
  GOOGLE_ADS_DEVELOPER_TOKEN: "devtok",
};

function mockFetch(pages: Array<Record<string, unknown>>) {
  const spy = vi.spyOn(global, "fetch");
  spy.mockResolvedValueOnce(
    new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 }),
  );
  for (const p of pages) spy.mockResolvedValueOnce(new Response(JSON.stringify(p), { status: 200 }));
  return spy;
}
const adsCalls = (spy: ReturnType<typeof mockFetch>) =>
  spy.mock.calls.filter(([u]) => String(u).startsWith("https://googleads.googleapis.com/"));

beforeEach(() => {
  Object.assign(process.env, ENV);
  getSecret.mockReset();
  getSecret.mockImplementation(async (_t: string, key: string) =>
    key === GOOGLE_ADS_VAULT_KEYS.refresh_token ? "rt" : key === GOOGLE_ADS_VAULT_KEYS.customer_id ? "123-456-7890" : null,
  );
});
afterEach(() => {
  for (const k of Object.keys(ENV)) delete (process.env as Record<string, string | undefined>)[k];
  vi.restoreAllMocks();
});

describe("google-ads _client request shape", () => {
  it("uses the shared Google Ads API version for search and mutate", async () => {
    expect(GOOGLE_ADS_API_VERSION).toBe("v25");
    expect(GADS_BASE).toBe(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`);
    const spy = mockFetch([{ results: [] }, { results: [{ resourceName: "customers/1/campaigns/9" }] }]);
    await gadsSearch("t-search", "SELECT campaign.id FROM campaign");
    await gadsMutate("t-search", "campaigns", [{ updateMask: "status", update: { resourceName: "x", status: "PAUSED" } }]);
    const urls = adsCalls(spy).map(([u]) => String(u));
    expect(urls).toEqual([
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/1234567890/googleAds:search`,
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/1234567890/campaigns:mutate`,
    ]);
  });

  it("googleAds:search sends { query } only — no pageSize (PAGE_SIZE_NOT_SUPPORTED) — and paginates via pageToken", async () => {
    const spy = mockFetch([
      { results: [{ campaign: { id: "1" } }], nextPageToken: "tok2" },
      { results: [{ campaign: { id: "2" } }] },
    ]);
    const rows = await gadsSearch("t-page", "SELECT campaign.id FROM campaign");
    expect(rows).toHaveLength(2);
    const bodies = adsCalls(spy).map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies).toEqual([
      { query: "SELECT campaign.id FROM campaign" },
      { query: "SELECT campaign.id FROM campaign", pageToken: "tok2" },
    ]);
    for (const b of bodies) expect(b).not.toHaveProperty("pageSize");
  });

  const tenPagesAndMore = () =>
    Array.from({ length: 10 }, (_, i) => ({ results: [{ campaign: { id: String(i) } }], nextPageToken: `tok${i + 1}` }));

  it("past the page limit a plain search returns what it has", async () => {
    mockFetch(tenPagesAndMore());
    expect(await gadsSearch("t-cap-plain", "SELECT campaign.id FROM campaign")).toHaveLength(10);
  });

  it("past the page limit a { complete } search throws instead of coming back short", async () => {
    mockFetch(tenPagesAndMore());
    await expect(gadsSearch("t-cap-complete", "SELECT campaign.id FROM campaign", { complete: true })).rejects.toMatchObject({
      code: "google_ads_query_truncated",
    });
  });
});

describe("Google Ads invocation credentials", () => {
  it("shares one credential resolution across concurrent queries, then refreshes account context next invocation", async () => {
    const spy = mockFetch(Array.from({ length: 5 }, () => ({ results: [] })));
    const search = createGoogleAdsReadSession("session-tenant");
    await Promise.all(Array.from({ length: 4 }, () => search("SELECT campaign.id FROM campaign")));
    expect(getSecret).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.filter(([url]) => String(url).includes("oauth2.googleapis.com"))).toHaveLength(1);
    getSecret.mockImplementation(async (_tenant: string, key: string) => key === GOOGLE_ADS_VAULT_KEYS.refresh_token ? "rt" : key === GOOGLE_ADS_VAULT_KEYS.customer_id ? "987-654-3210" : "555-555-5555");
    await createGoogleAdsReadSession("session-tenant")("SELECT campaign.id FROM campaign");
    expect(getSecret).toHaveBeenCalledTimes(6);
    const [url, init] = adsCalls(spy).at(-1)!;
    expect(String(url)).toContain("/customers/9876543210/");
    expect(init?.headers).toMatchObject({ "login-customer-id": "5555555555" });
  });

  it("never shares credentials between tenants", async () => {
    getSecret.mockImplementation(async (tenant: string, key: string) => key === GOOGLE_ADS_VAULT_KEYS.refresh_token ? `rt-${tenant}` : key === GOOGLE_ADS_VAULT_KEYS.customer_id ? (tenant === "isolation-a" ? "111" : "222") : null);
    const spy = vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: String(init?.body).includes("isolation-a") ? "token-a" : "token-b", expires_in: 3600 }));
      return new Response(JSON.stringify({ results: [] }));
    });
    await Promise.all([createGoogleAdsReadSession("isolation-a")("SELECT campaign.id FROM campaign"), createGoogleAdsReadSession("isolation-b")("SELECT campaign.id FROM campaign")]);
    for (const [url, init] of adsCalls(spy)) expect(init?.headers).toMatchObject({ Authorization: String(url).includes("/111/") ? "Bearer token-a" : "Bearer token-b" });
    expect(getSecret).toHaveBeenCalledTimes(6);
  });
});

describe("Google Ads read resilience — timeout, retry, token-cache invalidation", () => {
  const tokenResponse = () =>
    new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
  const isOauth = (url: unknown) => String(url).includes("oauth2.googleapis.com");

  it("sends every request with a hard timeout signal", async () => {
    const spy = mockFetch([{ results: [] }]);
    await gadsSearch("t-signal", "SELECT campaign.id FROM campaign");
    for (const [, init] of spy.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("a timed-out search is retried once, then surfaces as google_ads_timeout", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const spy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (isOauth(url)) return tokenResponse();
      throw timeout;
    });
    await expect(gadsSearch("t-timeout", "SELECT campaign.id FROM campaign")).rejects.toMatchObject({
      code: "google_ads_timeout",
    });
    expect(adsCalls(spy)).toHaveLength(2);
  });

  it("a 503 is retried once and the retry's rows are returned", async () => {
    let calls = 0;
    const spy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (isOauth(url)) return tokenResponse();
      calls += 1;
      return calls === 1
        ? new Response("upstream", { status: 503 })
        : new Response(JSON.stringify({ results: [{ campaign: { id: "7" } }] }), { status: 200 });
    });
    const rows = await gadsSearch("t-503", "SELECT campaign.id FROM campaign");
    expect(rows).toEqual([{ campaign: { id: "7" } }]);
    expect(adsCalls(spy)).toHaveLength(2);
  });

  it("a 401 evicts the cached access token, refreshes, and retries the search once", async () => {
    let oauthCalls = 0;
    let adsCallsSeen = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
      if (isOauth(url)) {
        oauthCalls += 1;
        return new Response(
          JSON.stringify({ access_token: `at-${oauthCalls}`, expires_in: 3600 }),
          { status: 200 },
        );
      }
      adsCallsSeen += 1;
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === "Bearer at-1") return new Response("UNAUTHENTICATED", { status: 401 });
      return new Response(JSON.stringify({ results: [{ campaign: { id: "ok" } }] }), { status: 200 });
    });
    const search = createGoogleAdsReadSession("t-401");
    const rows = await search("SELECT campaign.id FROM campaign");
    expect(rows).toEqual([{ campaign: { id: "ok" } }]);
    expect(oauthCalls).toBe(2);
    expect(adsCallsSeen).toBe(2);
    await search("SELECT campaign.id FROM campaign");
    expect(oauthCalls).toBe(2);
  });

  it("concurrent cold-cache callers share ONE token refresh", async () => {
    const spy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (isOauth(url)) {
        await new Promise((r) => setTimeout(r, 20));
        return tokenResponse();
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    await Promise.all([
      gadsSearch("t-dedupe", "SELECT campaign.id FROM campaign"),
      gadsSearch("t-dedupe", "SELECT campaign.id FROM campaign"),
      gadsSearch("t-dedupe", "SELECT campaign.id FROM campaign"),
    ]);
    expect(spy.mock.calls.filter(([u]) => isOauth(u))).toHaveLength(1);
  });

  it("a mutate is NEVER retried on a 5xx", async () => {
    let mutates = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (isOauth(url)) return tokenResponse();
      mutates += 1;
      return new Response("upstream", { status: 503 });
    });
    await expect(
      gadsMutate("t-mutate-503", "campaigns", [{ updateMask: "status", update: { resourceName: "x" } }]),
    ).rejects.toMatchObject({ code: "google_ads_mutate_failed" });
    expect(mutates).toBe(1);
  });
});
