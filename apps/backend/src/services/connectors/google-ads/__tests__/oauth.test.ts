import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  googleAdsOAuthStartUrl,
  exchangeCode,
  listAccessibleCustomers,
  normalizeCustomerId,
  discoverAdsAccounts,
} from "../oauth";
import { GOOGLE_ADS_API_VERSION } from "../../../tools/google-ads/keys";

const ENV = {
  GOOGLE_ADS_CLIENT_ID: "cid.apps.googleusercontent.com",
  GOOGLE_ADS_CLIENT_SECRET: "csecret",
  GOOGLE_ADS_DEVELOPER_TOKEN: "devtok",
  BACKEND_PUBLIC_URL: "https://api.zaviagent.com/",
};

beforeEach(() => {
  Object.assign(process.env, ENV);
});
afterEach(() => {
  for (const k of Object.keys(ENV)) delete (process.env as Record<string, string | undefined>)[k];
  vi.restoreAllMocks();
});

describe("googleAdsOAuthStartUrl", () => {
  it("includes adwords scope + access_type=offline + prompt=consent + state", () => {
    const u = new URL(googleAdsOAuthStartUrl("STATE123"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("select_account consent");
    expect(u.searchParams.get("state")).toBe("STATE123");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://api.zaviagent.com/api/connectors/google-ads/callback",
    );
  });
  it("throws if env is unset", () => {
    delete (process.env as Record<string, string | undefined>).GOOGLE_ADS_CLIENT_ID;
    expect(() => googleAdsOAuthStartUrl("s")).toThrow(/google_ads_misconfigured/);
  });
});

describe("exchangeCode", () => {
  it("returns refresh_token + access_token on success", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ refresh_token: "rt", access_token: "at", expires_in: 3599 }), { status: 200 }),
    );
    const r = await exchangeCode("code123");
    expect(r.refresh_token).toBe("rt");
    expect(r.access_token).toBe("at");
  });
  it("surfaces a missing refresh_token (route enforces the reconnect error)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "at", expires_in: 3599 }), { status: 200 }),
    );
    const r = await exchangeCode("code123");
    expect(r.refresh_token).toBeUndefined();
  });
  it("throws ExpectedToolError on non-2xx", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("bad", { status: 400 }));
    await expect(exchangeCode("x")).rejects.toMatchObject({ code: "google_oauth_exchange_failed" });
  });
});

describe("listAccessibleCustomers", () => {
  it("calls the shared, non-sunset Google Ads API version (v20 was sunset → 404)", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ resourceNames: [] }), { status: 200 }),
    );
    await listAccessibleCustomers("at");
    expect(GOOGLE_ADS_API_VERSION).toBe("v25");
    expect(spy.mock.calls[0][0]).toBe(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`,
    );
  });
  it("normalizes resourceNames customers/<id> → digits", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ resourceNames: ["customers/123-456-7890", "customers/9999999999"] }), { status: 200 }),
    );
    const ids = await listAccessibleCustomers("at");
    expect(ids).toEqual(["1234567890", "9999999999"]);
  });
  it("empty resourceNames → []", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    expect(await listAccessibleCustomers("at")).toEqual([]);
  });
  it("throws ExpectedToolError on API failure", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("nope", { status: 403 }));
    await expect(listAccessibleCustomers("at")).rejects.toMatchObject({ code: "google_ads_list_customers_failed" });
  });
});

describe("discoverAdsAccounts", () => {
  function mockGoogleAds(handlers: {
    accessible: string[];
    trees: Record<string, Array<{ id: string; name?: string; manager?: boolean }> | { status: number }>;
  }) {
    return vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("customers:listAccessibleCustomers")) {
        return new Response(
          JSON.stringify({ resourceNames: handlers.accessible.map((id) => `customers/${id}`) }),
          { status: 200 },
        );
      }
      const m = url.match(/customers\/(\d+)\/googleAds:search$/);
      if (m) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers["login-customer-id"]).toBe(m[1]);
        const tree = handlers.trees[m[1]];
        if (!tree) return new Response("no tree", { status: 403 });
        if ("status" in tree && !Array.isArray(tree)) return new Response("err", { status: tree.status });
        return new Response(
          JSON.stringify({
            results: (tree as Array<{ id: string; name?: string; manager?: boolean }>).map((c) => ({
              customerClient: { id: c.id, descriptiveName: c.name ?? "", manager: c.manager === true },
            })),
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it("direct-only account → login_customer_id null", async () => {
    mockGoogleAds({ accessible: ["111"], trees: { "111": [{ id: "111", name: "Acme" }] } });
    expect(await discoverAdsAccounts("at")).toEqual([
      { customer_id: "111", login_customer_id: null, descriptive_name: "Acme", manager: false },
    ]);
  });

  it("MCC → clients carry the manager id as login_customer_id; the MCC itself is not connectable", async () => {
    mockGoogleAds({
      accessible: ["999"],
      trees: {
        "999": [
          { id: "999", name: "My MCC", manager: true },
          { id: "222", name: "Client A" },
          { id: "333", name: "Client B" },
        ],
      },
    });
    const accounts = await discoverAdsAccounts("at");
    expect(accounts).toEqual([
      { customer_id: "222", login_customer_id: "999", descriptive_name: "Client A", manager: false },
      { customer_id: "333", login_customer_id: "999", descriptive_name: "Client B", manager: false },
    ]);
  });

  it("dedupe prefers DIRECT access over the MCC path", async () => {
    mockGoogleAds({
      accessible: ["999", "222"],
      trees: {
        "999": [{ id: "999", manager: true }, { id: "222", name: "Client A" }],
        "222": [{ id: "222", name: "Client A" }],
      },
    });
    expect(await discoverAdsAccounts("at")).toEqual([
      { customer_id: "222", login_customer_id: null, descriptive_name: "Client A", manager: false },
    ]);
  });

  it("one broken login is skipped, the rest still resolve", async () => {
    mockGoogleAds({
      accessible: ["444", "111"],
      trees: { "444": { status: 403 }, "111": [{ id: "111", name: "Acme" }] },
    });
    expect(await discoverAdsAccounts("at")).toEqual([
      { customer_id: "111", login_customer_id: null, descriptive_name: "Acme", manager: false },
    ]);
  });

  it("EVERY expansion failing falls back to bare accessible ids with login null (pre-MCC behavior)", async () => {
    mockGoogleAds({ accessible: ["111"], trees: { "111": { status: 500 } } });
    expect(await discoverAdsAccounts("at")).toEqual([
      { customer_id: "111", login_customer_id: null, descriptive_name: "", manager: false },
    ]);
  });
});

describe("normalizeCustomerId", () => {
  it("strips all non-digits", () => {
    expect(normalizeCustomerId("123-456-7890")).toBe("1234567890");
    expect(normalizeCustomerId("customers/55")).toBe("55");
  });
});
