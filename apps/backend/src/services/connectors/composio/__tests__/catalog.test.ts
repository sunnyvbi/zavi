import { describe, it, expect, vi, beforeEach } from "vitest";
const fx = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../api", () => ({ composioFetch: fx.fetch }));
vi.mock("../api-key", () => ({
  getComposioAuthConfigId: (t: string) => t === "gmail" ? "ac_env_gmail" : t === "shopify" ? "ac_env_shopify_oauth" : null,
  getComposioMcpServerId: () => "srv1",
}));
import {
  listComposioCatalog, isConnectable, lookupAuthConfigId, ensureAuthConfigForConnect,
  ensureToolkitOnMcpServer, composioToolAllowedForMcp, _resetCatalogForTests,
} from "../catalog";

const page = (items: unknown[], next: string | null) =>
  new Response(JSON.stringify({ items, next_cursor: next }), { status: 200 });
const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });

beforeEach(() => { fx.fetch.mockReset(); _resetCatalogForTests(); });

describe("listComposioCatalog", () => {
  it("follows next_cursor, skips deprecated toolkits, and memoizes", async () => {
    fx.fetch
      .mockResolvedValueOnce(page([{ slug: "gmail", name: "Gmail", meta: { logo: "l" }, composio_managed_auth_schemes: ["OAUTH2"], auth_schemes: ["OAUTH2"], no_auth: false }], "c2"))
      .mockResolvedValueOnce(page([
        { slug: "acme", name: "Acme", meta: {}, composio_managed_auth_schemes: [], auth_schemes: ["OAUTH2"], no_auth: false },
        { slug: "oldapp", name: "Old", meta: {}, composio_managed_auth_schemes: ["OAUTH2"], auth_schemes: ["OAUTH2"], no_auth: false, deprecated: true },
      ], null));
    const a = await listComposioCatalog();
    const b = await listComposioCatalog();
    expect(a.map((t) => t.slug)).toEqual(["gmail", "acme"]);
    expect(b).toBe(a);
    expect(fx.fetch).toHaveBeenCalledTimes(2);
  });
  it("throws (never returns a partial catalog) when a cursor remains after the page cap", async () => {
    fx.fetch.mockImplementation(async () => page([{ slug: "x", name: "X", meta: {}, composio_managed_auth_schemes: [], auth_schemes: [], no_auth: false }], "more"));
    await expect(listComposioCatalog()).rejects.toThrow(/truncated/);
  });
});

describe("isConnectable", () => {
  it("managed OAuth or user-supplied key scheme = connectable; custom-OAuth-only = coming soon", () => {
    expect(isConnectable({ slug: "a", managed: ["OAUTH2"], schemes: ["OAUTH2"], no_auth: false })).toBe(true);
    expect(isConnectable({ slug: "b", managed: [], schemes: ["API_KEY"], no_auth: false })).toBe(true);
    expect(isConnectable({ slug: "c", managed: [], schemes: ["OAUTH2"], no_auth: false })).toBe(false);
    expect(isConnectable({ slug: "gmail", managed: [], schemes: ["OAUTH2"], no_auth: false })).toBe(true);
  });
  it("no_auth toolkits (auth_schemes ['NO_AUTH'], nothing to authorize) are connectable", () => {
    expect(isConnectable({ slug: "hackernews", managed: [], schemes: ["NO_AUTH"], no_auth: true })).toBe(true);
  });
});

describe("lookupAuthConfigId (read paths: NEVER creates)", () => {
  it("prefers the env map", async () => {
    expect(await lookupAuthConfigId("gmail")).toBe("ac_env_gmail");
    expect(fx.fetch).not.toHaveBeenCalled();
  });
  it("finds an existing ENABLED Composio auth config", async () => {
    fx.fetch.mockResolvedValueOnce(ok({ items: [{ id: "ac_existing", status: "ENABLED" }] }));
    expect(await lookupAuthConfigId("notion")).toBe("ac_existing");
  });
  it("several ENABLED configs: picks the one already on the MCP server, not the first listed", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ items: [{ id: "ac_stray", status: "ENABLED" }, { id: "ac_served", status: "ENABLED" }] }))
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_other", "ac_served"], allowed_tools: ["X"], toolkits: ["tiktok_ads"] }));
    expect(await lookupAuthConfigId("tiktok_ads")).toBe("ac_served");
    expect(fx.fetch.mock.calls[1][1]).toBe("/api/v3.1/mcp/srv1");
    expect(fx.fetch.mock.calls.every((c) => c[0] === "GET")).toBe(true);
  });
  it("several ENABLED configs, none on the MCP server yet: falls back to the first listed", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ items: [{ id: "ac_a", status: "ENABLED" }, { id: "ac_b", status: "DISABLED" }, { id: "ac_c", status: "ENABLED" }] }))
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_other"] }));
    expect(await lookupAuthConfigId("box")).toBe("ac_a");
  });
  it("returns null and issues NO POST/PATCH when none exists", async () => {
    fx.fetch.mockResolvedValueOnce(ok({ items: [] }));
    expect(await lookupAuthConfigId("notion")).toBeNull();
    expect(fx.fetch.mock.calls.every((c) => c[0] === "GET")).toBe(true);
  });
});

describe("ensureAuthConfigForConnect (connect path only)", () => {
  it("creates a managed config when none exists", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ items: [] }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ auth_config: { id: "ac_new" } }), { status: 201 }));
    expect(await ensureAuthConfigForConnect({ slug: "notion", managed: ["OAUTH2"], schemes: ["OAUTH2"], no_auth: false })).toBe("ac_new");
    expect(fx.fetch.mock.calls[1][2]).toEqual({ toolkit: { slug: "notion" }, auth_config: { type: "use_composio_managed_auth" } });
  });
});

describe("shopify auth config (custom bearer only)", () => {
  it("skips managed and custom OAuth configs and takes the bearer config", async () => {
    fx.fetch.mockResolvedValueOnce(ok({ items: [
      { id: "ac_managed", status: "ENABLED", is_composio_managed: true, auth_scheme: "OAUTH2" },
      { id: "ac_oauth", status: "ENABLED", is_composio_managed: false, auth_scheme: "OAUTH2" },
      { id: "ac_bearer", status: "ENABLED", is_composio_managed: false, auth_scheme: "BEARER_TOKEN" },
    ] }));
    expect(await lookupAuthConfigId("shopify")).toBe("ac_bearer");
    expect(fx.fetch).toHaveBeenCalledTimes(1);
  });
  it("never creates a Shopify config on connect when only a managed one exists", async () => {
    fx.fetch.mockResolvedValueOnce(ok({ items: [{ id: "ac_managed", status: "ENABLED", is_composio_managed: true }] }));
    expect(await ensureAuthConfigForConnect({ slug: "shopify", managed: ["OAUTH2"], schemes: ["OAUTH2"], no_auth: false })).toBeNull();
    expect(fx.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("ensureToolkitOnMcpServer (union of auth configs AND tools)", () => {
  it("allows only Shopify GraphQL tools for a public-app connection", () => {
    expect(composioToolAllowedForMcp("shopify", "SHOPIFY_GRAPH_QL_PRODUCTS")).toBe(true);
    expect(composioToolAllowedForMcp("shopify", "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS")).toBe(true);
    expect(composioToolAllowedForMcp("shopify", "SHOPIFY_GRAPH_QL_QUERY")).toBe(false);
    expect(composioToolAllowedForMcp("shopify", "SHOPIFY_GRAPH_QL_ADMIN_EXECUTE")).toBe(false);
    expect(composioToolAllowedForMcp("shopify", "SHOPIFY_GET_PRODUCTS")).toBe(false);
    expect(composioToolAllowedForMcp("shopify", "NOTION_GET_PAGE")).toBe(true);
  });
  it("reads Shopify's pinned GraphQL-first catalog instead of the legacy REST base version", async () => {
    fx.fetch.mockResolvedValueOnce(ok({ items: [{ slug: "SHOPIFY_GRAPH_QL_PRODUCTS" }], next_cursor: null }));
    const { listToolkitToolSlugs } = await import("../catalog");
    expect([...(await listToolkitToolSlugs("shopify"))]).toEqual(["SHOPIFY_GRAPH_QL_PRODUCTS"]);
    expect(fx.fetch.mock.calls[0][1]).toContain("/api/v3.1/tools?");
    expect(fx.fetch.mock.calls[0][1]).toContain("toolkit_versions=20261018_00");
  });
  it("removes existing Shopify REST tools while attaching the GraphQL catalog", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_shop"], allowed_tools: ["NOTION_GET_PAGE", "SHOPIFY_GET_PRODUCTS"], toolkits: ["notion", "shopify"] }))
      .mockResolvedValueOnce(ok({ items: [
        { slug: "SHOPIFY_GET_PRODUCTS" },
        { slug: "SHOPIFY_GRAPH_QL_PRODUCTS" },
        { slug: "SHOPIFY_GRAPH_QL_ORDERS" },
        { slug: "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS" },
      ], next_cursor: null }))
      .mockResolvedValueOnce(ok({ items: [{ id: "ac_shop" }] }))
      .mockResolvedValueOnce(ok({}));
    await ensureToolkitOnMcpServer("shopify", "ac_shop");
    expect(fx.fetch.mock.calls[3][2].allowed_tools).toEqual([
      "NOTION_GET_PAGE",
      "SHOPIFY_GRAPH_QL_PRODUCTS",
      "SHOPIFY_GRAPH_QL_ORDERS",
      "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS",
    ]);
  });
  it("replaces the old Shopify auth config while preserving every unrelated config", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_notion", "ac_shop_oauth"], allowed_tools: ["NOTION_GET_PAGE", "SHOPIFY_GET_PRODUCTS"], toolkits: ["notion", "shopify"] }))
      .mockResolvedValueOnce(ok({ items: [{ slug: "SHOPIFY_GRAPH_QL_PRODUCTS" }], next_cursor: null }))
      .mockResolvedValueOnce(ok({ items: [{ id: "ac_shop_oauth" }, { id: "ac_shop_bearer" }] }))
      .mockResolvedValueOnce(ok({}));
    await ensureToolkitOnMcpServer("shopify", "ac_shop_bearer");
    expect(fx.fetch.mock.calls[3][2]).toEqual({
      auth_config_ids: ["ac_notion", "ac_shop_bearer"],
      toolkits: ["notion", "shopify"],
      allowed_tools: ["NOTION_GET_PAGE", "SHOPIFY_GRAPH_QL_PRODUCTS"],
    });
  });
  it("PATCHes the FULL union of auth_config_ids and allowed_tools", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_old"], allowed_tools: ["NOTION_GET_PAGE"], toolkits: ["notion"] }))
      .mockResolvedValueOnce(ok({ items: [{ slug: "GMAIL_FETCH_EMAILS" }, { slug: "GMAIL_SEND_EMAIL" }], next_cursor: null }))
      .mockResolvedValueOnce(ok({}));
    await ensureToolkitOnMcpServer("gmail", "ac_gmail");
    const patch = fx.fetch.mock.calls[2];
    expect(patch[0]).toBe("PATCH");
    expect(patch[2]).toEqual({
      auth_config_ids: ["ac_old", "ac_gmail"],
      toolkits: ["notion", "gmail"],
      allowed_tools: ["NOTION_GET_PAGE", "GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"],
    });
  });
  it("drops exactly the tools Composio's MCP server calls invalid, then retries once", async () => {
    const refusal = new Response(JSON.stringify({ error: { message: 'Invalid tools provided for MCP server "srv": GMAIL_OLD_ACTION, GMAIL_RETIRED. These tools do not exist in the tool catalog for this project.' } }), { status: 400 });
    fx.fetch
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_old"], allowed_tools: ["NOTION_GET_PAGE"], toolkits: ["notion"] }))
      .mockResolvedValueOnce(ok({ items: [{ slug: "GMAIL_FETCH_EMAILS" }, { slug: "GMAIL_OLD_ACTION" }, { slug: "GMAIL_RETIRED" }], next_cursor: null }))
      .mockResolvedValueOnce(refusal)
      .mockResolvedValueOnce(ok({}));
    await ensureToolkitOnMcpServer("gmail", "ac_gmail");
    const patches = fx.fetch.mock.calls.filter((c) => c[0] === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches[1][2]).toEqual({
      auth_config_ids: ["ac_old", "ac_gmail"],
      toolkits: ["notion", "gmail"],
      allowed_tools: ["NOTION_GET_PAGE", "GMAIL_FETCH_EMAILS"],
    });
  });
  it("a 400 that is not the invalid-tools refusal still fails the connect (no blind retry)", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_old"], allowed_tools: ["NOTION_GET_PAGE"], toolkits: ["notion"] }))
      .mockResolvedValueOnce(ok({ items: [{ slug: "GMAIL_FETCH_EMAILS" }], next_cursor: null }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }));
    await expect(ensureToolkitOnMcpServer("gmail", "ac_gmail")).rejects.toThrow(/HTTP 400: .*bad request/);
    expect(fx.fetch.mock.calls.filter((c) => c[0] === "PATCH")).toHaveLength(1);
  });
  it("toolkit already attached, adding new catalog tools fails: returns the error instead of failing the connect, and retries next time", async () => {
    const mcp = { auth_config_ids: ["ac_tiktok"], allowed_tools: ["TIKTOK_ADS_GET_REPORT"], toolkits: ["tiktok_ads"] };
    fx.fetch
      .mockResolvedValueOnce(ok(mcp))
      .mockResolvedValueOnce(ok({ items: [{ slug: "TIKTOK_ADS_GET_REPORT" }, { slug: "TIKTOK_ADS_SMART_PLUS_AD_PREVIEW" }], next_cursor: null }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "tool limit" } }), { status: 422 }));
    const out = await ensureToolkitOnMcpServer("tiktok_ads", "ac_tiktok");
    expect(out.toolsNotAdded).toMatch(/HTTP 422: .*tool limit/);
    fx.fetch.mockResolvedValueOnce(ok(mcp)).mockResolvedValueOnce(ok({}));
    expect((await ensureToolkitOnMcpServer("tiktok_ads", "ac_tiktok")).toolsNotAdded).toBeNull();
    expect(fx.fetch.mock.calls.filter((c) => c[0] === "GET" && String(c[1]).includes("/mcp/"))).toHaveLength(2);
  });
  it("a failed tool add still throws when none of the toolkit's tools are on the server yet", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_box"], allowed_tools: ["NOTION_GET_PAGE"], toolkits: ["notion", "box"] }))
      .mockResolvedValueOnce(ok({ items: [{ slug: "BOX_LIST_FILES" }], next_cursor: null }))
      .mockResolvedValueOnce(new Response("nope", { status: 422 }));
    await expect(ensureToolkitOnMcpServer("box", "ac_box")).rejects.toThrow(/HTTP 422: nope/);
  });
  it("a failed PATCH still throws when the toolkit's auth config is not on the server yet", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_old"], allowed_tools: ["NOTION_GET_PAGE"], toolkits: ["notion"] }))
      .mockResolvedValueOnce(ok({ items: [{ slug: "GMAIL_FETCH_EMAILS" }], next_cursor: null }))
      .mockResolvedValueOnce(new Response("upstream down", { status: 500 }));
    await expect(ensureToolkitOnMcpServer("gmail", "ac_gmail")).rejects.toThrow(/HTTP 500: upstream down/);
  });
  it("refuses to PATCH when the server's allowed_tools is empty or missing (semantics unverified; the live server holds an explicit 363-name list)", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_old"], allowed_tools: [] }))
      .mockResolvedValueOnce(ok({ items: [{ slug: "GMAIL_FETCH_EMAILS" }], next_cursor: null }));
    await expect(ensureToolkitOnMcpServer("gmail", "ac_gmail")).rejects.toThrow(/allowed_tools/);
    expect(fx.fetch.mock.calls.some((c) => c[0] === "PATCH")).toBe(false);
  });
  it("throws and never PATCHes when the tool listing is truncated", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_old"], allowed_tools: ["NOTION_GET_PAGE"] }))
      .mockImplementation(async () => ok({ items: [{ slug: "GMAIL_X" }], next_cursor: "more" }));
    await expect(ensureToolkitOnMcpServer("gmail", "ac_gmail")).rejects.toThrow(/truncated/);
    expect(fx.fetch.mock.calls.some((c) => c[0] === "PATCH")).toBe(false);
  });
  it("Reddit attaches its read tools only: no agent can propose a comment, edit, delete or post", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_old"], allowed_tools: ["NOTION_GET_PAGE", "REDDIT_POST_REDDIT_COMMENT"], toolkits: ["notion"] }))
      .mockResolvedValueOnce(ok({ items: [
        { slug: "REDDIT_CREATE_REDDIT_POST" }, { slug: "REDDIT_POST_REDDIT_COMMENT" },
        { slug: "REDDIT_EDIT_REDDIT_COMMENT_OR_POST" }, { slug: "REDDIT_DELETE_REDDIT_POST" },
        { slug: "REDDIT_RETRIEVE_REDDIT_POST" }, { slug: "REDDIT_SEARCH_ACROSS_SUBREDDITS" },
      ], next_cursor: null }))
      .mockResolvedValueOnce(ok({}));
    await ensureToolkitOnMcpServer("reddit", "ac_reddit");
    expect(fx.fetch.mock.calls[2][2].allowed_tools).toEqual(["NOTION_GET_PAGE", "REDDIT_RETRIEVE_REDDIT_POST", "REDDIT_SEARCH_ACROSS_SUBREDDITS"]);
  });
  it("Pinterest attaches its read tools only, and drops the pin writes a tenant connected before", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_pin"], allowed_tools: ["NOTION_GET_PAGE", "PINTEREST_CREATE_PIN", "PINTEREST_LIST_BOARDS"], toolkits: ["notion", "pinterest"] }))
      .mockResolvedValueOnce(ok({ items: [
        { slug: "PINTEREST_CREATE_PIN" }, { slug: "PINTEREST_DELETE_PIN" }, { slug: "PINTEREST_DELETE_BOARD" },
        { slug: "PINTEREST_LIST_BOARDS" }, { slug: "PINTEREST_GET_PROFILE" },
      ], next_cursor: null }))
      .mockResolvedValueOnce(ok({}));
    await ensureToolkitOnMcpServer("pinterest", "ac_pin");
    expect(fx.fetch.mock.calls[2][2].allowed_tools).toEqual(["NOTION_GET_PAGE", "PINTEREST_LIST_BOARDS", "PINTEREST_GET_PROFILE"]);
  });
  it("is a no-op (no PATCH) when the config and every tool are already attached", async () => {
    fx.fetch
      .mockResolvedValueOnce(ok({ auth_config_ids: ["ac_gmail"], allowed_tools: ["GMAIL_FETCH_EMAILS"], toolkits: ["gmail"] }))
      .mockResolvedValueOnce(ok({ items: [{ slug: "GMAIL_FETCH_EMAILS" }], next_cursor: null }));
    await ensureToolkitOnMcpServer("gmail", "ac_gmail");
    expect(fx.fetch.mock.calls.some((c) => c[0] === "PATCH")).toBe(false);
  });
});
