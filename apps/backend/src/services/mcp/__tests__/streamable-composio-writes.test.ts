import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  tools: [] as Array<{ name: string; description?: string; annotations?: Record<string, boolean | undefined>; inputSchema?: { type: "object"; required?: string[] } }>,
  urls: [] as string[],
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL) { m.urls.push(url.toString()); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {}
    async close() {}
    async listTools() { return { tools: m.tools }; }
    async callTool() { return { content: [{ type: "text", text: "ok" }] }; }
  },
}));
vi.mock("@/services/connectors/composio/api-key", () => ({
  getComposioApiKey: () => "k",
  buildComposioMcpUrl: (t: string) => `https://backend.composio.dev/v3/mcp/srv?user_id=${t}`,
}));
vi.mock("@/services/connectors/composio/catalog", () => ({
  listToolkitToolSlugs: async (k: string) =>
    new Set(
      ({
        gmail: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"],
        linear: ["LINEAR_RUN_QUERY_OR_MUTATION"],
        notion: ["NOTION_UPDATE_PAGE", "NTN_LEGACY_CREATE_BLOCK"],
        stripe: ["STRIPE_CAPTURE_PAYMENT_INTENT"],
        hubspot: ["HUBSPOT_LIST_CONTACTS"],
        pinterest: ["PINTEREST_LIST_BOARDS", "PINTEREST_GET_PROFILE", "PINTEREST_CREATE_PIN", "PINTEREST_DELETE_PIN", "PINTEREST_DELETE_BOARD", "PINTEREST_UPDATE_BOARD"],
        tiktok_ads: ["TIKTOK_ADS_GET_CREATIVE_ASSETS", "TIKTOK_ADS_CREATE_SMART_PLUS_AD", "TIKTOK_ADS_DELETE_CREATIVE_ASSETS", "TIKTOK_ADS_UPDATE_CAMPAIGN_BUDGET", "TIKTOK_ADS_UPDATE_CAMPAIGN_STATUS", "TIKTOK_ADS_UPLOAD_IMAGE"],
        shopify: ["SHOPIFY_GRAPH_QL_SHOP", "SHOPIFY_GRAPH_QL_PRODUCTS", "SHOPIFY_GRAPH_QL_ORDERS", "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS"],
      } as Record<string, string[]>)[k] ?? [],
    ),
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: async () => "s" }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tok" }));
vi.mock("../capability-failclosed", async (orig) => ({
  ...(await orig<typeof import("../capability-failclosed")>()),
  logCapabilityWouldBlock: () => {},
}));

import {
  listStreamableTools,
  callStreamableTool,
  advertisedReadToolNames,
  advertisedComposioWriteTool,
  _clearAdvertisedReadToolsForTests,
} from "../streamable-client";
import type { McpServerRow } from "../types";
import { validateComposioInputs } from "../composio-inputs";

const COMPOSIO: McpServerRow = {
  tenant_id: "T1", server_id: "composio", transport: "streamable-http",
  url: "https://backend.composio.dev/v3/mcp/srv?user_id=OTHER", command: null, args: null, enabled: true,
} as McpServerRow;
const TOOLS = [
  { name: "GMAIL_FETCH_EMAILS", annotations: { readOnlyHint: true } },
  { name: "GMAIL_SEND_EMAIL", annotations: { readOnlyHint: false } },
  { name: "LINEAR_RUN_QUERY_OR_MUTATION", annotations: { readOnlyHint: true } },
  { name: "NOTION_UPDATE_PAGE", annotations: { destructiveHint: true } },
  { name: "STRIPE_CAPTURE_PAYMENT_INTENT", annotations: { readOnlyHint: true } },
  { name: "HUBSPOT_LIST_CONTACTS", annotations: { readOnlyHint: true } },
  { name: "NTN_LEGACY_CREATE_BLOCK", annotations: {} },
  { name: "ZOOM_DELETE_MEETING", annotations: {} },
];
const KITS = ["gmail", "linear", "notion", "stripe"];

beforeEach(() => {
  _clearAdvertisedReadToolsForTests();
  m.tools = TOOLS;
  m.urls = [];
});
afterEach(() => {
  delete process.env.CAPABILITY_FAILCLOSED_MODE;
  delete process.env.CAPABILITY_FAILCLOSED_BYPASS_TENANTS;
});

describe("Composio tools: connected apps only, writes approval-only", () => {
  it("advertises Shopify's pinned GraphQL reads and rejects a mutation hidden in the mixed product tool", async () => {
    m.tools = [
      { name: "SHOPIFY_GRAPH_QL_SHOP", annotations: { readOnlyHint: false } },
      { name: "SHOPIFY_GRAPH_QL_PRODUCTS", annotations: { destructiveHint: true } },
      { name: "SHOPIFY_GRAPH_QL_ORDERS", annotations: {} },
    ];
    const out = await listStreamableTools("T1", COMPOSIO, { toolkits: ["shopify"] });
    expect(out.map((tool) => tool.tool_name)).toEqual([
      "SHOPIFY_GRAPH_QL_SHOP", "SHOPIFY_GRAPH_QL_PRODUCTS", "SHOPIFY_GRAPH_QL_ORDERS",
    ]);
    expect(out.every((tool) => tool.requires_approval === undefined)).toBe(true);
    expect(out[1].description).toContain("update_product changes the store and needs the founder's approval");
    expect((await callStreamableTool("T1", COMPOSIO, "SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "list_products" })).ok).toBe(true);
    const blocked = await callStreamableTool("T1", COMPOSIO, "SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "delete_product" });
    expect(blocked.ok).toBe(false);
    expect(JSON.parse(blocked.content).error).toBe("tool_not_allowed");
  });
  it("advertises the Shopify write surface as an approval-only write limited to discount creation", async () => {
    m.tools = [{ name: "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS", annotations: { readOnlyHint: true } }];
    const out = await listStreamableTools("T1", COMPOSIO, { toolkits: ["shopify"] });
    expect(out[0].requires_approval).toBe(true);
    expect(out[0].description).toMatch(/^\[Needs the founder's approval before it runs\] .*Only operation discountCodeBasicCreate is available/);
    expect(advertisedComposioWriteTool("T1", "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS")).toEqual({ destructive: false });
  });
  for (const annotations of [undefined, {}, { readOnlyHint: false }, { readOnlyHint: true }]) {
    it(`keeps TikTok creative lookups read-only with annotations ${JSON.stringify(annotations)}`, async () => {
      m.tools = [
        { name: "TIKTOK_ADS_GET_CREATIVE_ASSETS", annotations, inputSchema: { type: "object", required: ["advertiser_id", "asset_type", "asset_ids"] } },
        { name: "TIKTOK_ADS_CREATE_SMART_PLUS_AD", annotations: { readOnlyHint: true } },
        { name: "TIKTOK_ADS_DELETE_CREATIVE_ASSETS", annotations: { readOnlyHint: true } },
      ];
      const out = await listStreamableTools("T1", COMPOSIO, { toolkits: ["tiktok_ads"] });
      expect(out[0].requires_approval).toBeUndefined();
      expect(advertisedReadToolNames("T1", "composio")?.has("TIKTOK_ADS_GET_CREATIVE_ASSETS")).toBe(true);
      expect(advertisedComposioWriteTool("T1", "TIKTOK_ADS_GET_CREATIVE_ASSETS")).toBeUndefined();
      expect(out.slice(1).every((tool) => tool.requires_approval)).toBe(true);
      expect(validateComposioInputs("T1", "TIKTOK_ADS_GET_CREATIVE_ASSETS", { advertiser_id: "adv" })?.is_error).toBe(true);
    });
  }

  it("never offers a raw TikTok spend write (budget, status, a launch); reads and uploads stay", async () => {
    m.tools = [
      { name: "TIKTOK_ADS_GET_CREATIVE_ASSETS", annotations: { readOnlyHint: true } },
      { name: "TIKTOK_ADS_UPDATE_CAMPAIGN_BUDGET", annotations: {} },
      { name: "TIKTOK_ADS_UPDATE_CAMPAIGN_STATUS", annotations: { readOnlyHint: true } },
      { name: "TIKTOK_ADS_CREATE_SMART_PLUS_AD", annotations: {} },
      { name: "TIKTOK_ADS_UPLOAD_IMAGE", annotations: {} },
    ];
    const out = await listStreamableTools("T1", COMPOSIO, { toolkits: ["tiktok_ads"] });
    expect(out.map((t) => t.tool_name)).toEqual(["TIKTOK_ADS_GET_CREATIVE_ASSETS", "TIKTOK_ADS_UPLOAD_IMAGE"]);
    expect(advertisedComposioWriteTool("T1", "TIKTOK_ADS_UPDATE_CAMPAIGN_BUDGET")).toBeUndefined();
    expect(advertisedReadToolNames("T1", "composio")?.has("TIKTOK_ADS_UPDATE_CAMPAIGN_STATUS")).toBe(false);
  });

  it("never offers a raw Pinterest write: pins go only through social__propose_post", async () => {
    m.tools = [
      { name: "PINTEREST_LIST_BOARDS", annotations: { readOnlyHint: true } },
      { name: "PINTEREST_GET_PROFILE", annotations: {} },
      { name: "PINTEREST_CREATE_PIN", annotations: {} },
      { name: "PINTEREST_DELETE_PIN", annotations: { readOnlyHint: true } },
      { name: "PINTEREST_DELETE_BOARD", annotations: {} },
      { name: "PINTEREST_UPDATE_BOARD", annotations: {} },
    ];
    const out = await listStreamableTools("T1", COMPOSIO, { toolkits: ["pinterest"] });
    expect(out.map((t) => t.tool_name)).toEqual(["PINTEREST_LIST_BOARDS", "PINTEREST_GET_PROFILE"]);
    expect(out.every((t) => !t.requires_approval)).toBe(true);
    expect(advertisedComposioWriteTool("T1", "PINTEREST_CREATE_PIN")).toBeUndefined();
    expect(advertisedReadToolNames("T1", "composio")?.has("PINTEREST_DELETE_PIN")).toBe(false);
  });

  it("still gates a destructive hint on a read-named TikTok tool", async () => {
    m.tools = [{ name: "TIKTOK_ADS_GET_CREATIVE_ASSETS", annotations: { destructiveHint: true } }];
    const out = await listStreamableTools("T1", COMPOSIO, { toolkits: ["tiktok_ads"] });
    expect(out[0].requires_approval).toBe(true);
  });

  it("drops unconnected toolkits; every non-read carries requires_approval + the approval prefix", async () => {
    const out = await listStreamableTools("T1", COMPOSIO, { toolkits: KITS });
    const names = out.map((t) => t.tool_name).sort();
    expect(names).toEqual([
      "GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL", "LINEAR_RUN_QUERY_OR_MUTATION",
      "NOTION_UPDATE_PAGE", "NTN_LEGACY_CREATE_BLOCK", "STRIPE_CAPTURE_PAYMENT_INTENT",
    ]);
    for (const t of out) {
      if (t.tool_name === "GMAIL_FETCH_EMAILS") {
        expect(t.requires_approval).toBeUndefined();
        expect(t.description.startsWith("[Needs")).toBe(false);
      } else {
        expect(t.requires_approval).toBe(true);
        expect(t.description.startsWith("[Needs the founder's approval before it runs] ")).toBe(true);
      }
    }
  });

  it("toolkit membership, not prefix: a catalog-listed tool with a foreign prefix is attributed; an unlisted one is dropped", async () => {
    await listStreamableTools("T1", COMPOSIO, { toolkits: KITS });
    expect(advertisedComposioWriteTool("T1", "NTN_LEGACY_CREATE_BLOCK")).toEqual({ destructive: false });
    expect(advertisedComposioWriteTool("T1", "ZOOM_DELETE_MEETING")).toBeUndefined();
  });

  it("the write set never leaks into the read set", async () => {
    await listStreamableTools("T1", COMPOSIO, { toolkits: KITS });
    expect([...(advertisedReadToolNames("T1", "composio") ?? [])]).toEqual(["GMAIL_FETCH_EMAILS"]);
    expect(advertisedComposioWriteTool("T1", "NOTION_UPDATE_PAGE")).toEqual({ destructive: true });
    expect(advertisedComposioWriteTool("T1", "GMAIL_FETCH_EMAILS")).toBeUndefined();
  });

  it("no toolkits → nothing listed (fail closed)", async () => {
    expect(await listStreamableTools("T1", COMPOSIO)).toEqual([]);
    expect(advertisedReadToolNames("T1", "composio")?.size).toBe(0);
  });

  for (const [label, env] of [
    ["shadow", { CAPABILITY_FAILCLOSED_MODE: "shadow" }],
    ["bypassed tenant", { CAPABILITY_FAILCLOSED_BYPASS_TENANTS: "T1" }],
  ] as const) {
    it(`mode-independent: under ${label} the read set is still exactly the allowlisted reads`, async () => {
      Object.assign(process.env, env);
      await listStreamableTools("T1", COMPOSIO, { toolkits: KITS });
      expect([...(advertisedReadToolNames("T1", "composio") ?? [])]).toEqual(["GMAIL_FETCH_EMAILS"]);
    });
  }

  it("per-tenant: another tenant's list does not authorize this tenant's writes", async () => {
    await listStreamableTools("T1", COMPOSIO, { toolkits: KITS });
    await listStreamableTools("T2", { ...COMPOSIO, tenant_id: "T2" } as McpServerRow, { toolkits: ["gmail"] });
    expect(advertisedComposioWriteTool("T2", "STRIPE_CAPTURE_PAYMENT_INTENT")).toBeUndefined();
    expect(advertisedComposioWriteTool("T1", "STRIPE_CAPTURE_PAYMENT_INTENT")).toEqual({ destructive: false });
  });

  it("the MCP user_id is rebuilt from the server tenant, never the stored row url", async () => {
    await listStreamableTools("T1", COMPOSIO, { toolkits: KITS });
    await callStreamableTool("T1", COMPOSIO, "GMAIL_FETCH_EMAILS", {});
    expect(m.urls.length).toBe(2);
    for (const u of m.urls) {
      expect(u).toContain("user_id=T1");
      expect(u).not.toContain("OTHER");
    }
  });
});

describe("non-Composio streamable servers are unchanged", () => {
  const HIGGS = { ...COMPOSIO, server_id: "higgsfield", url: "https://mcp.higgsfield.ai/mcp" } as McpServerRow;
  it("higgsfield: writes still dropped unless allowlisted; no approval-only writes", async () => {
    m.tools = [
      { name: "generate_video", annotations: {} },
      { name: "delete_everything", annotations: {} },
      { name: "list_jobs", annotations: { readOnlyHint: true } },
    ];
    const out = await listStreamableTools("T1", HIGGS);
    expect(out.map((t) => t.tool_name).sort()).toEqual(["generate_video", "list_jobs"]);
    expect(out.every((t) => t.requires_approval === undefined)).toBe(true);
  });
});
