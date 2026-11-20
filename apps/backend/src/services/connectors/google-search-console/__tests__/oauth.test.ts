import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  googleSearchConsoleOAuthStartUrl,
  exchangeCode,
  listAccessibleSites,
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
  delete (process.env as Record<string, string | undefined>).GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
  delete (process.env as Record<string, string | undefined>).GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET;
  vi.restoreAllMocks();
});

describe("googleSearchConsoleOAuthStartUrl", () => {
  it("requests webmasters.readonly ONLY + offline consent", () => {
    const u = new URL(googleSearchConsoleOAuthStartUrl("STATE123"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/webmasters.readonly");
    expect(u.searchParams.get("scope")).not.toContain("webmasters ");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("select_account consent");
    expect(u.searchParams.get("state")).toBe("STATE123");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://api.zaviagent.com/api/connectors/google-search-console/callback",
    );
  });

  it("reuses the Google Ads OAuth client when GSC-specific env is unset", () => {
    const u = new URL(googleSearchConsoleOAuthStartUrl("s"));
    expect(u.searchParams.get("client_id")).toBe("cid.apps.googleusercontent.com");
  });

  it("prefers the GSC-specific client when present", () => {
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID = "gsc-cid.apps.googleusercontent.com";
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET = "gsc-secret";
    const u = new URL(googleSearchConsoleOAuthStartUrl("s"));
    expect(u.searchParams.get("client_id")).toBe("gsc-cid.apps.googleusercontent.com");
  });

  it("throws if no OAuth client is configured at all", () => {
    delete (process.env as Record<string, string | undefined>).GOOGLE_ADS_CLIENT_ID;
    expect(() => googleSearchConsoleOAuthStartUrl("s")).toThrow(/google_search_console_misconfigured/);
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

describe("listAccessibleSites", () => {
  it("filters unverified sites and sorts by site_url", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          siteEntry: [
            { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
            { siteUrl: "https://blog.example.com/", permissionLevel: "siteFullUser" },
            { siteUrl: "https://spam.example.com/", permissionLevel: "siteUnverifiedUser" },
          ],
        }),
        { status: 200 },
      ),
    );
    const sites = await listAccessibleSites("at");
    expect(sites).toEqual([
      { site_url: "https://blog.example.com/", permission_level: "siteFullUser" },
      { site_url: "sc-domain:example.com", permission_level: "siteOwner" },
    ]);
  });

  it("returns [] when the account has no sites", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    expect(await listAccessibleSites("at")).toEqual([]);
  });

  it("throws ExpectedToolError on non-2xx", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("nope", { status: 403 }));
    await expect(listAccessibleSites("at")).rejects.toMatchObject({
      code: "google_search_console_list_sites_failed",
    });
  });
});
