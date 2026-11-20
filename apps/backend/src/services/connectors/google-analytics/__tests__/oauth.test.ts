import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  googleAnalyticsOAuthStartUrl,
  exchangeCode,
  listAccessibleProperties,
} from "../oauth";

const ENV = {
  GOOGLE_ADS_CLIENT_ID: "cid.apps.googleusercontent.com",
  GOOGLE_ADS_CLIENT_SECRET: "csecret",
  BACKEND_PUBLIC_URL: "https://api.zaviagent.com/",
};

beforeEach(() => {
  Object.assign(process.env, ENV);
});
afterEach(() => {
  for (const k of Object.keys(ENV)) delete (process.env as Record<string, string | undefined>)[k];
  delete (process.env as Record<string, string | undefined>).GOOGLE_ANALYTICS_CLIENT_ID;
  delete (process.env as Record<string, string | undefined>).GOOGLE_ANALYTICS_CLIENT_SECRET;
  vi.restoreAllMocks();
});

describe("googleAnalyticsOAuthStartUrl", () => {
  it("requests analytics.readonly ONLY (no write, no tagmanager) + offline consent", () => {
    const u = new URL(googleAnalyticsOAuthStartUrl("STATE123"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/analytics.readonly");
    expect(u.searchParams.get("scope")).not.toContain("tagmanager");
    expect(u.searchParams.get("scope")).not.toContain("analytics.edit");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("select_account consent");
    expect(u.searchParams.get("state")).toBe("STATE123");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://api.zaviagent.com/api/connectors/google-analytics/callback",
    );
  });

  it("reuses the Google Ads OAuth client when GA-specific env is unset", () => {
    const u = new URL(googleAnalyticsOAuthStartUrl("s"));
    expect(u.searchParams.get("client_id")).toBe("cid.apps.googleusercontent.com");
  });

  it("prefers GA-specific client when present", () => {
    process.env.GOOGLE_ANALYTICS_CLIENT_ID = "ga-cid.apps.googleusercontent.com";
    process.env.GOOGLE_ANALYTICS_CLIENT_SECRET = "ga-secret";
    const u = new URL(googleAnalyticsOAuthStartUrl("s"));
    expect(u.searchParams.get("client_id")).toBe("ga-cid.apps.googleusercontent.com");
  });

  it("throws if no OAuth client is configured at all", () => {
    delete (process.env as Record<string, string | undefined>).GOOGLE_ADS_CLIENT_ID;
    expect(() => googleAnalyticsOAuthStartUrl("s")).toThrow(/google_analytics_misconfigured/);
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

describe("listAccessibleProperties", () => {
  it("flattens accountSummaries → digit property ids + Account › Property labels", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          accountSummaries: [
            {
              displayName: "Acme",
              propertySummaries: [
                { property: "properties/123456789", displayName: "Acme Web" },
                { property: "properties/987654321", displayName: "Acme App" },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const props = await listAccessibleProperties("at");
    expect(props).toEqual([
      { property_id: "123456789", display_name: "Acme › Acme Web" },
      { property_id: "987654321", display_name: "Acme › Acme App" },
    ]);
  });

  it("throws ExpectedToolError on non-2xx", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("nope", { status: 403 }));
    await expect(listAccessibleProperties("at")).rejects.toMatchObject({
      code: "google_analytics_list_properties_failed",
    });
  });
});
