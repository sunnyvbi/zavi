import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  insert: vi.fn(),
  resolveOwnedComposioAccount: vi.fn(),
  listAccessibleProperties: vi.fn(),
  listAccessibleSites: vi.fn(),
  logEvent: vi.fn(async () => {}),
}));

vi.mock("@/services/tenant-client", () => ({
  oauthCallbackClient: () => ({
    rpc: mocks.rpc,
    from: () => ({ insert: (row: unknown) => ({ select: () => ({ single: () => mocks.insert(row) }) }) }),
  }),
}));
vi.mock("@/services/connectors/composio/account", () => ({
  resolveOwnedComposioAccount: mocks.resolveOwnedComposioAccount,
}));
vi.mock("@/services/connectors/google-analytics/oauth", () => ({
  googleAnalyticsOAuthStartUrl: vi.fn(),
  exchangeCode: vi.fn(),
  listAccessibleProperties: mocks.listAccessibleProperties,
}));
vi.mock("@/services/connectors/google-search-console/oauth", () => ({
  googleSearchConsoleOAuthStartUrl: vi.fn(),
  exchangeCode: vi.fn(),
  listAccessibleSites: mocks.listAccessibleSites,
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: vi.fn(async () => {}) }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn(async () => {}) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.logEvent }));

import { completeGoogleAnalyticsComposioConnect } from "../google-analytics";
import { completeGoogleSearchConsoleComposioConnect } from "../google-search-console";

const tu = { tenant_id: "tnt-1", user_id: "usr-1" };

function backTo(sent: unknown): string | null {
  const m = /id="back" href="([^"]*)"/.exec(String(sent));
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

function mockRes() {
  return {
    statusCode: 200,
    sent: "" as unknown,
    status(c: number) { this.statusCode = c; return this; },
    send(b: unknown) { this.sent = b; return this; },
  };
}

const ACCOUNT = (toolkit: string) => ({ tenant_id: "tnt-1", toolkit, connected_account_id: "ca_x", auth_config_id: "ac_x" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveOwnedComposioAccount.mockImplementation(async (_t: string, kit: string) => ACCOUNT(kit));
});

describe("completeGoogleAnalyticsComposioConnect", () => {
  it("one property: persists via the native RPC with an EMPTY refresh token", async () => {
    mocks.listAccessibleProperties.mockResolvedValue([{ property_id: "123", display_name: "Site" }]);
    mocks.rpc.mockResolvedValue({ error: null });

    const res = mockRes();
    await completeGoogleAnalyticsComposioConnect(tu, "ca_1", res as never);

    expect(mocks.rpc).toHaveBeenCalledWith("set_google_analytics_connection", {
      p_tenant_id: "tnt-1",
      p_refresh_token: "",
      p_property_id: "123",
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.sent)).toContain("Connected");
  });

  it("many properties: stashes a pending row with an EMPTY refresh token and renders the picker", async () => {
    mocks.listAccessibleProperties.mockResolvedValue([
      { property_id: "123", display_name: "A" },
      { property_id: "456", display_name: "B" },
    ]);
    mocks.insert.mockResolvedValue({ data: { id: "00000000-0000-0000-0000-000000000001" }, error: null });

    const res = mockRes();
    await completeGoogleAnalyticsComposioConnect(tu, "ca_1", res as never);

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ refresh_token: "", property_ids: ["123", "456"] }));
    expect(String(res.sent)).toContain("Pick the Google Analytics property");
  });

  it("no stored Composio account: explains Google didn’t answer and links back to Zavi, nothing persisted", async () => {
    mocks.resolveOwnedComposioAccount.mockResolvedValue(null);

    const res = mockRes();
    await completeGoogleAnalyticsComposioConnect(tu, "ca_1", res as never);

    expect(res.statusCode).toBe(502);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(backTo(res.sent)).toBe(
      "http://localhost:3000/workspace?tab=settings&composio_error=google_analytics&code=google_api_error",
    );
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: "google_api_error", tenant_id: "tnt-1" }),
    );
  });

  it("zero properties: explains in plain words why it didn’t connect and links back to Zavi", async () => {
    mocks.listAccessibleProperties.mockResolvedValue([]);

    const res = mockRes();
    await completeGoogleAnalyticsComposioConnect(tu, "ca_1", res as never);

    expect(res.statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(backTo(res.sent)).toBe(
      "http://localhost:3000/workspace?tab=settings&composio_error=google_analytics&code=no_properties",
    );
    expect(String(res.sent)).not.toContain("Close tab");
    expect(String(res.sent)).toContain("Couldn’t connect Google Analytics");
    expect(String(res.sent)).toContain("can’t see any Google Analytics property");
  });
});

describe("completeGoogleSearchConsoleComposioConnect", () => {
  it("one site: persists via the native RPC with an EMPTY refresh token", async () => {
    mocks.listAccessibleSites.mockResolvedValue([{ site_url: "sc-domain:example.com", permission_level: "siteOwner" }]);
    mocks.rpc.mockResolvedValue({ error: null });

    const res = mockRes();
    await completeGoogleSearchConsoleComposioConnect(tu, "ca_2", res as never);

    expect(mocks.rpc).toHaveBeenCalledWith("set_google_search_console_connection", {
      p_tenant_id: "tnt-1",
      p_refresh_token: "",
      p_site_url: "sc-domain:example.com",
    });
  });

  it("zero sites: explains there is no Search Console site and persists nothing", async () => {
    mocks.listAccessibleSites.mockResolvedValue([]);

    const res = mockRes();
    await completeGoogleSearchConsoleComposioConnect(tu, "ca_2", res as never);

    expect(res.statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(backTo(res.sent)).toBe(
      "http://localhost:3000/workspace?tab=settings&composio_error=google_search_console&code=no_sites",
    );
    expect(String(res.sent)).toContain("no verified site in Search Console");
  });
});

describe("Composio completion without the product's Google scope", () => {
  const SCOPE_403 = 'sites.list returned 403: {"error":{"code":403,"message":"Request had insufficient authentication scopes.","status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}';

  it("GSC: reports scope_missing, sends nothing and persists nothing (the return leg undoes the connect)", async () => {
    mocks.listAccessibleSites.mockRejectedValue(new Error(SCOPE_403));

    const res = mockRes();
    const outcome = await completeGoogleSearchConsoleComposioConnect(tu, "ca_2", res as never);

    expect(outcome).toBe("scope_missing");
    expect(res.sent).toBe("");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "google_scope_missing", tenant_id: "tnt-1" }));
  });

  it("GA: same for an Analytics token without the Analytics scope", async () => {
    mocks.listAccessibleProperties.mockRejectedValue(new Error(SCOPE_403.replace("sites.list", "accountSummaries.list")));

    const res = mockRes();
    const outcome = await completeGoogleAnalyticsComposioConnect(tu, "ca_1", res as never);

    expect(outcome).toBe("scope_missing");
    expect(res.sent).toBe("");
  });

  it("any other Google 403 keeps the generic 'Google didn’t answer' page", async () => {
    mocks.listAccessibleSites.mockRejectedValue(new Error('sites.list returned 403: {"error":{"code":403,"message":"User does not have sufficient permission for site."}}'));

    const res = mockRes();
    const outcome = await completeGoogleSearchConsoleComposioConnect(tu, "ca_2", res as never);

    expect(outcome).toBe("done");
    expect(res.statusCode).toBe(502);
    expect(String(res.sent)).toContain("Google didn’t answer as expected");
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "google_api_error" }));
  });
});
