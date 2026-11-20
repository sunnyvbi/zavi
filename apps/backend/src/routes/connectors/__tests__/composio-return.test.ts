import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
const audit = vi.hoisted(() => ({ record: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@/services/connectors/core/connector-events", () => ({ recordConnectorEvent: audit.record }));

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rpc: vi.fn(),
  verifyActive: vi.fn(),
  buildMcpUrl: vi.fn(() => "https://mcp.example/tnt"),
  lookupAuthConfigId: vi.fn(async () => "ac_notion"),
  ensureAuthConfigForConnect: vi.fn(async (): Promise<string | null> => { throw new Error("return must never create a config"); }),
  ensureToolkitOnMcpServer: vi.fn(async () => ({ toolsNotAdded: null as string | null })),
  logEvent: vi.fn(async () => {}),
  composioLink: vi.fn(),
  newestActive: vi.fn(async (): Promise<string | null> => null),
  syncActiveTenant: vi.fn(async () => {}),
  prevRow: null as null | { team_id: string },
  rowReads: [] as Array<null | { team_id: string }>,
  readFails: false,
  rowDeletes: [] as string[],
  storedTeamId: "",
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      let deleting = false;
      const filters: Record<string, unknown> = {};
      const q: any = { select: () => q, eq: (k: string, v: unknown) => { filters[k] = v; return q; }, like: () => q, limit: async () => ({ data: [] }), update: () => q, delete: () => { deleting = true; return q; },
        then: (ok: (v: unknown) => void) => { if (deleting && (!("team_id" in filters) || filters.team_id === mocks.storedTeamId)) mocks.rowDeletes.push(table); ok({ error: null }); },
        maybeSingle: async () => mocks.readFails ? { data: null, error: { message: "db down" } } : ({ data: mocks.rowReads.length ? mocks.rowReads.shift() : mocks.prevRow, error: null }) };
      return q;
    },
  }),
}));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: mocks.syncActiveTenant }));
vi.mock("@/services/connectors/composio/api-key", () => ({
  buildComposioMcpUrl: mocks.buildMcpUrl,
}));
vi.mock("@/services/connectors/composio/catalog", () => ({
  listComposioCatalog: async () => ["notion", "gmail", "figma", "google_analytics", "google_search_console", "tiktok_ads"].map((slug) => ({
    slug, name: slug, logo: "", category: null, managed: ["OAUTH2"], schemes: ["OAUTH2"], no_auth: false,
  })),
  isConnectable: () => true,
  lookupAuthConfigId: mocks.lookupAuthConfigId,
  ensureAuthConfigForConnect: mocks.ensureAuthConfigForConnect,
  ensureToolkitOnMcpServer: mocks.ensureToolkitOnMcpServer,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.logEvent }));
const founder = vi.hoisted(() => ({ notify: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: founder.notify }));
vi.mock("@/services/connectors/composio/api", () => ({
  composioLink: mocks.composioLink,
  composioVerifyActive: mocks.verifyActive,
  composioDisconnect: vi.fn(),
}));
const completionMocks = vi.hoisted(() => ({
  ga: vi.fn(async (..._a: unknown[]): Promise<"done" | "scope_missing"> => "done"),
  gsc: vi.fn(async (..._a: unknown[]): Promise<"done" | "scope_missing"> => "done"),
}));
vi.mock("../google-analytics", () => ({ completeGoogleAnalyticsComposioConnect: completionMocks.ga }));
vi.mock("../google-search-console", () => ({ completeGoogleSearchConsoleComposioConnect: completionMocks.gsc }));

const tiktokMocks = vi.hoisted(() => ({ sync: vi.fn(async () => ({})), resolve: vi.fn(async () => ({ tenant_id: "tnt-1", toolkit: "tiktok_ads", connected_account_id: "ca_tt1", auth_config_id: "ac" })) }));
vi.mock("@/services/connectors/tiktok-ads/ad-accounts", () => ({ syncAdAccounts: tiktokMocks.sync }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: tiktokMocks.resolve }));

import { composioReturn, composioConnectStart } from "../composio";
import { composioDisconnect } from "@/services/connectors/composio/api";

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    redirectedTo?: string;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
    redirect: (c: number, url: string) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    redirect(c: number, url: string) { this.statusCode = c; this.redirectedTo = url; return this; },
  };
  return res;
}

function reqFor(query: Record<string, string>, toolkit = "notion") {
  return { params: { toolkit }, query, headers: {} } as never;
}

beforeEach(() => {
  audit.record.mockClear();
  mocks.requireAuth.mockReset();
  mocks.rpc.mockReset();
  mocks.verifyActive.mockReset();
  mocks.syncActiveTenant.mockClear();
  mocks.ensureToolkitOnMcpServer.mockReset();
  mocks.ensureToolkitOnMcpServer.mockResolvedValue({ toolsNotAdded: null });
  mocks.logEvent.mockClear();
  mocks.composioLink.mockReset();
  mocks.ensureAuthConfigForConnect.mockReset();
  mocks.ensureAuthConfigForConnect.mockImplementation(async () => { throw new Error("return must never create a config"); });
  mocks.prevRow = null;
  mocks.rowReads = [];
  mocks.rowDeletes = [];
  mocks.storedTeamId = "";
  founder.notify.mockClear();
  completionMocks.gsc.mockClear();
  completionMocks.ga.mockClear();
  vi.mocked(composioDisconnect).mockReset();
});

function redirectQuery(res: { redirectedTo?: string }): URLSearchParams {
  return new URL(res.redirectedTo ?? "http://x/").searchParams;
}

describe("composioReturn — tokenless state-nonce recovery", () => {
  it("completes the connection from state alone, with NO Bearer header", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);

    const res = mockRes();
    await composioReturn(
      reqFor({ state: "raw-state-xyz", connected_account_id: "ca_123" }),
      res as never,
    );

    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(302);
    expect(res.redirectedTo).toContain("composio_notion=connected");
    expect(audit.record).toHaveBeenCalledWith({ tenant_id: "tnt-1", slug: "composio.notion", action: "connect", actor_user_id: "usr-1", via: "composio_return" });
    expect(mocks.verifyActive).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "tnt-1", connected_account_id: "ca_123" }),
    );
  });

  it("consumes the state with its bound account and, without an account id in the query, attaches exactly that account", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1", connected_account_id: "ca_bound" }], error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);
    const res = mockRes();
    await composioReturn(reqFor({ state: "raw-state-xyz" }), res as never);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "consume_oauth_state_bound", { p_provider: "composio", p_state_hash: expect.any(String) });
    expect(mocks.verifyActive).toHaveBeenCalledWith(expect.objectContaining({ user_id: "tnt-1", connected_account_id: "ca_bound" }));
    expect(res.redirectedTo).toContain("composio_notion=connected");
    expect(mocks.rpc).toHaveBeenCalledWith("set_composio_app_connection", expect.objectContaining({ p_connected_account_id: "ca_bound" }));
  });

  it("a callback naming a different account than the one bound to the state never attaches it", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1", connected_account_id: "ca_bound" }], error: null });
    const res = mockRes();
    await composioReturn(reqFor({ state: "raw-state-xyz", connected_account_id: "ca_other" }), res as never);
    expect(redirectQuery(res).get("code")).toBe("connection_not_owned");
    expect(mocks.verifyActive).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith("set_composio_app_connection", expect.anything());
  });

  it("without an account id anywhere, fails with missing_params after consuming the state", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1", connected_account_id: null }], error: null });
    const res = mockRes();
    await composioReturn(reqFor({ state: "raw-state-xyz" }), res as never);
    expect(redirectQuery(res).get("code")).toBe("missing_params");
    expect(mocks.verifyActive).not.toHaveBeenCalled();
  });

  it("accepts the camelCase account id too", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);
    const res = mockRes();
    await composioReturn(reqFor({ state: "raw-state-xyz", connectedAccountId: "ca_camel" }), res as never);
    expect(mocks.verifyActive).toHaveBeenCalledWith(expect.objectContaining({ connected_account_id: "ca_camel" }));
  });

  it("google_analytics return: skips the shared-server attach and hands the browser to the picker flow", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);

    const res = mockRes();
    await composioReturn(reqFor({ state: "raw-state-xyz", connected_account_id: "ca_ga1" }, "google_analytics"), res as never);

    expect(mocks.ensureToolkitOnMcpServer).not.toHaveBeenCalled();
    expect(res.redirectedTo).toBeUndefined();
    expect(completionMocks.ga).toHaveBeenCalledWith({ tenant_id: "tnt-1", user_id: "usr-1" }, "ca_ga1", res);
    expect(completionMocks.gsc).not.toHaveBeenCalled();
  });

  it("tiktok_ads return: saves the ad accounts it finds, then lands the browser as usual", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);
    tiktokMocks.sync.mockClear();

    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_tt1" }, "tiktok_ads"), res as never);

    expect(tiktokMocks.resolve).toHaveBeenCalledWith("tnt-1", "tiktok_ads");
    expect(tiktokMocks.sync).toHaveBeenCalledWith(expect.objectContaining({ connected_account_id: "ca_tt1" }));
    expect(redirectQuery(res).get("composio_tiktok_ads")).toBe("connected");
  });

  it("tiktok_ads return: a failed ad-account search never fails the connect", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);
    tiktokMocks.sync.mockRejectedValueOnce(new Error("TikTok down"));

    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_tt1" }, "tiktok_ads"), res as never);

    expect(redirectQuery(res).get("composio_tiktok_ads")).toBe("connected");
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "tiktok_ads_account_sync_failed" }));
  });

  it("google_search_console return: same, via its own completion handler", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);

    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_gsc1" }, "google_search_console"), res as never);

    expect(mocks.ensureToolkitOnMcpServer).not.toHaveBeenCalled();
    expect(completionMocks.gsc).toHaveBeenCalledWith({ tenant_id: "tnt-1", user_id: "usr-1" }, "ca_gsc1", res);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ slug: "composio.google_search_console", action: "connect" }));
    expect(founder.notify).toHaveBeenCalledWith(expect.objectContaining({ event: "first_connector" }));
    expect(composioDisconnect).not.toHaveBeenCalled();
  });

  it("google_search_console return without the Search Console scope: revokes, drops the row, no connect event or alert, reconnect page", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);
    completionMocks.gsc.mockResolvedValueOnce("scope_missing");
    mocks.storedTeamId = "ca_gsc1";

    const res = Object.assign(mockRes(), { sent: "" as unknown, send(b: unknown) { this.sent = b; return this; } });
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_gsc1" }, "google_search_console"), res as never);

    expect(composioDisconnect).toHaveBeenCalledWith("ca_gsc1");
    expect(mocks.rowDeletes).toEqual(["connector_metadata"]);
    expect(audit.record).not.toHaveBeenCalled();
    expect(founder.notify).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.redirectedTo).toBeUndefined();
    expect(String(res.sent)).toContain("Google didn’t give Zavi access to Search Console. Reconnect and tick the Search Console box.");
  });

  it("scope missing, but another tab saved a different account meanwhile: the undo leaves that row alone", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);
    completionMocks.gsc.mockResolvedValueOnce("scope_missing");
    mocks.storedTeamId = "ca_gsc_other_tab";

    const res = Object.assign(mockRes(), { sent: "" as unknown, send(b: unknown) { this.sent = b; return this; } });
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_gsc1" }, "google_search_console"), res as never);

    expect(composioDisconnect).toHaveBeenCalledWith("ca_gsc1");
    expect(mocks.rowDeletes).toEqual([]);
  });

  it("scope missing but the Composio revoke fails: keeps the row (Disconnect stays possible), still shows the reconnect page", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);
    completionMocks.ga.mockResolvedValueOnce("scope_missing");
    vi.mocked(composioDisconnect).mockRejectedValueOnce(new Error("composio 500"));

    const res = Object.assign(mockRes(), { sent: "" as unknown, send(b: unknown) { this.sent = b; return this; } });
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_ga1" }, "google_analytics"), res as never);

    expect(mocks.rowDeletes).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
    expect(founder.notify).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "composio_undo_revoke_failed" }));
    expect(String(res.sent)).toContain("Reconnect and tick the Google Analytics box.");
  });

  it("lands back on Settings when Composio returns no ?state= (cannot recover tenant)", async () => {
    const res = mockRes();
    await composioReturn(reqFor({ connected_account_id: "ca_123" }), res as never);
    expect(res.statusCode).toBe(302);
    expect(redirectQuery(res).get("code")).toBe("missing_state");
    expect(redirectQuery(res).get("composio_error")).toBe("notion");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects an invalid/expired/replayed state and NEVER writes the connection", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    const res = mockRes();
    await composioReturn(
      reqFor({ state: "stale-or-replayed", connected_account_id: "ca_123" }),
      res as never,
    );
    expect(res.statusCode).toBe(302);
    expect(redirectQuery(res).get("code")).toBe("invalid_state");
    expect(audit.record).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.verifyActive).not.toHaveBeenCalled();
  });

  it("rejects an account not active for the recovered tenant (cross-tenant guard)", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null });
    mocks.verifyActive.mockResolvedValueOnce(false);
    const res = mockRes();
    await composioReturn(
      reqFor({ state: "valid", connected_account_id: "ca_not_owned" }),
      res as never,
    );
    expect(res.statusCode).toBe(302);
    expect(res.redirectedTo).toContain("composio_error=notion&code=connection_not_owned");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.ensureToolkitOnMcpServer).not.toHaveBeenCalled();
  });

  it("rejects an unknown toolkit before touching state or Composio", async () => {
    const res = mockRes();
    await composioReturn(
      reqFor({ state: "x", connected_account_id: "ca_1" }, "not-a-real-app"),
      res as never,
    );
    expect(res.statusCode).toBe(302);
    expect(redirectQuery(res).get("code")).toBe("unknown_toolkit");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("E3 locks: tenant-derived identity, unowned never stored, attach after proof", () => {
  function okConsume() {
    mocks.rpc.mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null });
  }

  it("connect sends user_id = auth.tenant_id even when the request carries another user_id", async () => {
    process.env.BACKEND_PUBLIC_URL = "https://api.example";
    mocks.requireAuth.mockResolvedValueOnce({ tenant_id: "tnt-A", user_id: "usr-A" });
    mocks.rpc.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ data: true, error: null });
    mocks.ensureAuthConfigForConnect.mockResolvedValueOnce("ac_notion");
    mocks.composioLink.mockResolvedValueOnce({ redirect_url: "https://composio/x", connected_account_id: "ca_1" });
    const res = mockRes();
    await composioConnectStart(
      { params: { toolkit: "notion" }, body: { user_id: "OTHER", tenant_id: "OTHER" }, query: { user_id: "OTHER" }, headers: {} } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(mocks.composioLink).toHaveBeenCalledWith(expect.objectContaining({ user_id: "tnt-A", auth_config_id: "ac_notion" }));
    expect(mocks.rpc).toHaveBeenCalledWith("mint_oauth_state", expect.objectContaining({ p_tenant_id: "tnt-A" }));
    expect(mocks.ensureToolkitOnMcpServer).not.toHaveBeenCalled();
  });

  it("connect for a native-rail toolkit (slack) answers 404 unknown_toolkit", async () => {
    mocks.requireAuth.mockResolvedValueOnce({ tenant_id: "tnt-A", user_id: "usr-A" });
    const res = mockRes();
    await composioConnectStart({ params: { toolkit: "slack" }, body: {}, query: {}, headers: {} } as never, res as never);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe("unknown_toolkit");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("success: never creates a config, attaches only after verify, stores p_auth_config_id", async () => {
    okConsume();
    mocks.rpc.mockResolvedValueOnce({ error: null });
    const order: string[] = [];
    mocks.verifyActive.mockImplementationOnce(async () => { order.push("verify"); return true; });
    mocks.ensureToolkitOnMcpServer.mockImplementationOnce(async () => { order.push("attach"); return { toolsNotAdded: null }; });
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_1" }), res as never);
    expect(res.redirectedTo).toContain("composio_notion=connected");
    expect(order).toEqual(["verify", "attach"]);
    expect(mocks.ensureToolkitOnMcpServer).toHaveBeenCalledWith("notion", "ac_notion");
    expect(mocks.ensureAuthConfigForConnect).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenLastCalledWith("set_composio_app_connection", expect.objectContaining({
      p_tenant_id: "tnt-1", p_toolkit: "notion", p_connected_account_id: "ca_1", p_auth_config_id: "ac_notion",
    }));
  });

  it("a failed MCP attach fails the connect: redirect mcp_sync_failed, nothing stored, logged without args", async () => {
    okConsume();
    mocks.verifyActive.mockResolvedValueOnce(true);
    mocks.ensureToolkitOnMcpServer.mockRejectedValueOnce(new Error("composio mcp patch HTTP 500"));
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_1" }), res as never);
    expect(res.statusCode).toBe(302);
    expect(res.redirectedTo).toContain("/workspace?tab=settings&composio_error=notion&code=mcp_sync_failed");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalledWith("set_composio_app_connection", expect.anything());
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      code: "composio_mcp_sync_failed", message: "composio mcp patch HTTP 500",
      tenant_id: "tnt-1", meta: { connector_slug: "composio.notion" },
    }));
  });

  it("toolkit already served, only new catalog tools could not be added: the connect still succeeds and the error is logged", async () => {
    okConsume();
    mocks.rpc.mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);
    mocks.ensureToolkitOnMcpServer.mockResolvedValueOnce({ toolsNotAdded: "composio mcp patch HTTP 422: bad tool" });
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_1" }), res as never);
    expect(res.redirectedTo).toContain("composio_notion=connected");
    expect(res.redirectedTo).not.toContain("composio_error");
    expect(mocks.rpc).toHaveBeenCalledWith("set_composio_app_connection", expect.objectContaining({ p_connected_account_id: "ca_1" }));
    expect(vi.mocked(composioDisconnect)).not.toHaveBeenCalledWith("ca_1");
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      code: "composio_mcp_tools_not_added", message: "composio mcp patch HTTP 422: bad tool",
      tenant_id: "tnt-1", meta: { connector_slug: "composio.notion" },
    }));
  });

  it("a failed MCP attach revokes the just-authorized account at Composio (best effort)", async () => {
    okConsume();
    mocks.verifyActive.mockResolvedValueOnce(true);
    mocks.ensureToolkitOnMcpServer.mockRejectedValueOnce(new Error("composio mcp patch HTTP 500"));
    vi.mocked(composioDisconnect).mockRejectedValueOnce(new Error("composio delete HTTP 503"));
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_1" }), res as never);
    expect(vi.mocked(composioDisconnect)).toHaveBeenCalledWith("ca_1");
    expect(res.redirectedTo).toContain("code=mcp_sync_failed");
  });

  it("reconnecting to a DIFFERENT account revokes the previous one after the new row is saved", async () => {
    okConsume();
    mocks.rowReads = [{ team_id: "ca_old" }, { team_id: "ca_new" }];
    const order: string[] = [];
    mocks.rpc.mockImplementationOnce(async () => { order.push("save"); return { error: null }; });
    vi.mocked(composioDisconnect).mockImplementationOnce(async () => { order.push("revoke_old"); throw new Error("503"); });
    mocks.verifyActive.mockResolvedValueOnce(true);
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_new" }), res as never);
    expect(res.redirectedTo).toContain("composio_notion=connected");
    expect(order).toEqual(["save", "revoke_old"]);
    expect(vi.mocked(composioDisconnect)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(composioDisconnect)).toHaveBeenCalledWith("ca_old");
  });

  it("reconnecting the SAME account revokes nothing; a first connect revokes nothing", async () => {
    for (const prev of [{ team_id: "ca_1" }, null]) {
      okConsume();
      mocks.prevRow = prev;
      mocks.rpc.mockResolvedValueOnce({ error: null });
      mocks.verifyActive.mockResolvedValueOnce(true);
      const res = mockRes();
      await composioReturn(reqFor({ state: "s", connected_account_id: "ca_1" }), res as never);
      expect(res.redirectedTo).toContain("composio_notion=connected");
    }
    expect(vi.mocked(composioDisconnect)).not.toHaveBeenCalled();
  });

  it("reconnecting the SAME account when the MCP attach fails does NOT revoke the stored account", async () => {
    okConsume();
    mocks.prevRow = { team_id: "ca_1" };
    mocks.verifyActive.mockResolvedValueOnce(true);
    mocks.ensureToolkitOnMcpServer.mockRejectedValueOnce(new Error("composio mcp patch HTTP 500"));
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_1" }), res as never);
    expect(res.redirectedTo).toContain("code=mcp_sync_failed");
    expect(vi.mocked(composioDisconnect)).not.toHaveBeenCalled();
  });

  it("reconnecting the SAME account when the save fails does NOT revoke the stored account", async () => {
    okConsume();
    mocks.prevRow = { team_id: "ca_1" };
    mocks.rpc.mockResolvedValueOnce({ error: { message: "db down" } });
    mocks.verifyActive.mockResolvedValueOnce(true);
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_1" }), res as never);
    expect(res.redirectedTo).toContain("code=set_composio_app_connection_failed");
    expect(vi.mocked(composioDisconnect)).not.toHaveBeenCalled();
  });

  it("does not revoke the previous account if the row still stores it after the save", async () => {
    okConsume();
    mocks.rowReads = [{ team_id: "ca_old" }, { team_id: "ca_old" }];
    mocks.rpc.mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_new" }), res as never);
    expect(res.redirectedTo).toContain("composio_notion=connected");
    expect(vi.mocked(composioDisconnect)).not.toHaveBeenCalled();
  });

  it("a failed save revokes the just-connected account at Composio", async () => {
    okConsume();
    mocks.rpc.mockResolvedValueOnce({ error: { message: "db down" } });
    mocks.verifyActive.mockResolvedValueOnce(true);
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_1" }), res as never);
    expect(res.redirectedTo).toContain("code=set_composio_app_connection_failed");
    expect(vi.mocked(composioDisconnect)).toHaveBeenCalledWith("ca_1");
  });

  it("an unreadable stored row means no revoke at all (it may be the live account)", async () => {
    okConsume();
    mocks.readFails = true;
    mocks.rpc.mockResolvedValueOnce({ error: { message: "db down" } });
    mocks.verifyActive.mockResolvedValueOnce(true);
    vi.mocked(composioDisconnect).mockClear();
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_1" }), res as never);
    mocks.readFails = false;
    expect(res.redirectedTo).toContain("code=set_composio_app_connection_failed");
    expect(vi.mocked(composioDisconnect)).not.toHaveBeenCalled();
  });

  it("a hostile toolkit param is never echoed: composio_error=unknown", async () => {
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_1" }, "<script>"), res as never);
    expect(res.statusCode).toBe(302);
    expect(res.redirectedTo).not.toContain("script");
    expect(redirectQuery(res).get("composio_error")).toBe("unknown");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("connect failure hides vendor text from the browser", () => {
  const VENDOR = "composio link HTTP 500: secret vendor body";
  const PLAIN = "Couldn't start the connection. Try again in a minute.";

  it.each([
    ["link", () => {
      mocks.ensureAuthConfigForConnect.mockResolvedValueOnce("ac_notion");
      mocks.rpc.mockResolvedValueOnce({ error: null });
      mocks.composioLink.mockRejectedValueOnce(new Error(VENDOR));
    }],
    ["resolve", () => {
      mocks.ensureAuthConfigForConnect.mockRejectedValueOnce(new Error(VENDOR));
    }],
  ])("%s failure answers 502 with the plain message and logs the raw one", async (_leg, arrange) => {
    process.env.BACKEND_PUBLIC_URL = "https://api.example";
    mocks.requireAuth.mockResolvedValueOnce({ tenant_id: "tnt-A", user_id: "usr-A" });
    arrange();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = mockRes();
    await composioConnectStart({ params: { toolkit: "notion" }, body: {}, query: {}, headers: {} } as never, res as never);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: { code: "composio_link_failed", message: PLAIN } });
    expect(JSON.stringify(res.body)).not.toContain("secret vendor body");
    expect(warn.mock.calls.flat().join(" ")).toContain(VENDOR);
    expect(warn.mock.calls.flat().join(" ")).toContain("notion");
    warn.mockRestore();
  });
});

describe("Composio connect returns the founder to the page they started from", () => {
  const webOrigin = process.env.WEB_ORIGIN;
  afterEach(() => {
    if (webOrigin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = webOrigin;
  });

  async function connectFrom(returnTo: unknown, toolkit = "gmail"): Promise<string> {
    process.env.BACKEND_PUBLIC_URL = "https://api.example";
    process.env.WEB_ORIGIN = "http://localhost:3020,http://localhost:3022";
    mocks.requireAuth.mockResolvedValueOnce({ tenant_id: "tnt-1", user_id: "usr-1" });
    mocks.rpc.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ data: true, error: null });
    mocks.ensureAuthConfigForConnect.mockResolvedValueOnce("ac_notion");
    mocks.composioLink.mockResolvedValueOnce({ redirect_url: "https://composio/x", connected_account_id: "ca_r" });
    const start = mockRes();
    await composioConnectStart(
      { params: { toolkit }, body: returnTo === undefined ? {} : { return_to: returnTo }, query: {}, headers: {} } as never,
      start as never,
    );
    expect(start.statusCode).toBe(200);
    const callback = new URL((mocks.composioLink.mock.calls.at(-1)![0] as { callback_url: string }).callback_url);
    expect(callback.origin).toBe("https://api.example");
    expect(callback.pathname).toBe(`/api/connectors/composio/${toolkit}/return`);
    const state = callback.searchParams.get("state")!;
    const minted = mocks.rpc.mock.calls.find(([fn]) => fn === "mint_oauth_state")![1] as { p_state_hash: string };
    expect(minted.p_state_hash).toBe(crypto.createHash("sha256").update(state).digest("hex"));

    mocks.rpc
      .mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);
    const back = mockRes();
    await composioReturn(reqFor({ state, connected_account_id: "ca_r" }, toolkit), back as never);
    expect(mocks.rpc).toHaveBeenCalledWith("bind_oauth_state_account", expect.objectContaining({ p_state_hash: minted.p_state_hash, p_connected_account_id: "ca_r" }));
    expect(mocks.rpc).toHaveBeenCalledWith("consume_oauth_state_bound", expect.objectContaining({ p_state_hash: minted.p_state_hash }));
    expect(back.statusCode).toBe(302);
    return back.redirectedTo!;
  }

  it("a connect started on Email campaigns lands back on Email campaigns with the connected flag", async () => {
    const landing = await connectFrom("/workspace?tab=channels&channel=email_marketing");
    expect(landing).toBe("http://localhost:3020/workspace?tab=channels&channel=email_marketing&composio_gmail=connected");
  });

  it("keeps a thread page and its hash", async () => {
    const landing = await connectFrom("/workspace/abc-123?tab=channels#connect");
    expect(landing).toBe("http://localhost:3020/workspace/abc-123?tab=channels&composio_gmail=connected#connect");
  });

  for (const hostile of [
    "https://evil.com",
    "https://evil.com/workspace?tab=channels",
    "//evil.com",
    "//evil.com/workspace",
    "/\\evil.com",
    "/\\evil.com/workspace",
    "javascript:alert(1)",
    "/workspace/../../evil",
    "/login?next=https://evil.com",
    "/workspace?tab=settings&channel=email_marketing",
    ["/workspace?tab=channels"],
    42,
    `/workspace?tab=channels&x=${"a".repeat(600)}`,
    undefined,
  ]) {
    it(`falls back to Settings for return_to ${JSON.stringify(hostile)?.slice(0, 60)}`, async () => {
      const landing = await connectFrom(hostile);
      expect(landing).toBe("http://localhost:3020/workspace?tab=settings&composio_gmail=connected");
    });
  }
});

describe("a connect started in its own tab lands that tab on the small done page", () => {
  function doneQuery(res: { redirectedTo?: string }) {
    const u = new URL(res.redirectedTo ?? "http://x/");
    return { path: u.pathname, q: u.searchParams };
  }

  async function startWith(body: unknown): Promise<string> {
    process.env.BACKEND_PUBLIC_URL = "https://api.example";
    mocks.requireAuth.mockResolvedValueOnce({ tenant_id: "tnt-A", user_id: "usr-A" });
    mocks.rpc.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ data: true, error: null });
    mocks.ensureAuthConfigForConnect.mockResolvedValueOnce("ac_notion");
    mocks.composioLink.mockResolvedValueOnce({ redirect_url: "https://composio/x", connected_account_id: "ca_1" });
    const res = mockRes();
    await composioConnectStart({ params: { toolkit: "notion" }, body, query: {}, headers: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    return (mocks.composioLink.mock.calls.at(-1)![0] as { callback_url: string }).callback_url;
  }

  it("only a start that says popup:true marks the return leg", async () => {
    const marked = new URL(await startWith({ popup: true }));
    expect(marked.searchParams.get("popup")).toBe("1");
    expect(marked.searchParams.get("state")).toBeTruthy();
    for (const body of [{}, undefined, { popup: "true" }, { popup: 1 }]) {
      expect(new URL(await startWith(body)).searchParams.has("popup")).toBe(false);
    }
  });

  it("a verified popup connect stores the row, then shows the done page instead of the app", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_123", popup: "1" }), res as never);
    expect(res.statusCode).toBe(302);
    const { path, q } = doneQuery(res);
    expect(path).toBe("/connectors/composio/done");
    expect(q.get("toolkit")).toBe("notion");
    expect(q.get("status")).toBe("connected");
    expect(res.redirectedTo).not.toContain("/workspace");
    expect(mocks.verifyActive).toHaveBeenCalledWith(expect.objectContaining({ user_id: "tnt-1", connected_account_id: "ca_123" }));
    expect(mocks.rpc).toHaveBeenCalledWith("set_composio_app_connection", expect.objectContaining({ p_tenant_id: "tnt-1", p_connected_account_id: "ca_123" }));
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it("the popup marker never skips verification: an unowned account shows the plain reason and nothing is stored", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null });
    mocks.verifyActive.mockResolvedValueOnce(false);
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_x", popup: "1" }), res as never);
    const { path, q } = doneQuery(res);
    expect(path).toBe("/connectors/composio/done");
    expect(q.get("status")).toBe("error");
    expect(q.get("reason")).toBe("connection_not_owned");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.ensureToolkitOnMcpServer).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("a popup return with a replayed state or a hostile toolkit lands on the done page without echoing it", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    const replay = mockRes();
    await composioReturn(reqFor({ state: "old", connected_account_id: "ca_1", popup: "1" }), replay as never);
    expect(doneQuery(replay).q.get("reason")).toBe("invalid_state");
    expect(mocks.verifyActive).not.toHaveBeenCalled();

    const hostile = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_1", popup: "1" }, "<script>"), hostile as never);
    expect(hostile.redirectedTo).not.toContain("script");
    expect(doneQuery(hostile).path).toBe("/connectors/composio/done");
    expect(doneQuery(hostile).q.get("toolkit")).toBe("unknown");
    expect(doneQuery(hostile).q.get("reason")).toBe("unknown_toolkit");
  });

  it("without the marker the same return keeps today's Settings landing", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [{ tenant_id: "tnt-1", user_id: "usr-1" }], error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.verifyActive.mockResolvedValueOnce(true);
    const res = mockRes();
    await composioReturn(reqFor({ state: "s", connected_account_id: "ca_123", popup: "0" }), res as never);
    expect(res.redirectedTo).toMatch(/\/workspace\?tab=settings&composio_notion=connected$/);
  });
});
