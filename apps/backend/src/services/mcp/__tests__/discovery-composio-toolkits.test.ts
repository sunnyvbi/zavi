import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  slugs: [] as string[],
  readError: false,
  calls: [] as Array<{ tenant: string; toolkits: readonly string[] | undefined }>,
  logs: [] as Array<{ code?: string }>,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const rows =
        table === "tenant_mcp_servers"
          ? [{ tenant_id: "T1", server_id: "composio", transport: "streamable-http", url: "https://backend.composio.dev/v3/mcp/srv?user_id=T1", command: null, args: [], enabled: true }]
          : [];
      const q: any = {
        select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
        like: async () =>
          m.readError ? { data: null, error: { message: "boom" } } : { data: m.slugs.map((slug) => ({ slug })), error: null },
        maybeSingle: async () => ({ data: null, error: null }),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(ok, bad),
      };
      return q;
    },
  }),
}));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async (e: { code?: string }) => { m.logs.push(e); }),
}));
vi.mock("../streamable-client", async (orig) => ({
  ...(await orig<typeof import("../streamable-client")>()),
  listStreamableTools: vi.fn(async (tenant: string, _s: unknown, opts: { toolkits?: readonly string[] } = {}) => {
    m.calls.push({ tenant, toolkits: opts.toolkits });
    return (opts.toolkits ?? []).map((k) => ({
      server_id: "composio",
      tool_name: `${k.toUpperCase()}_LIST_ITEMS`,
      description: "d",
      input_schema: { type: "object" as const },
    }));
  }),
}));

import { discoverToolsForTenant } from "../discovery";

beforeEach(() => { m.slugs = []; m.readError = false; m.calls = []; m.logs = []; });
afterEach(() => { delete process.env.ALL_AGENTS_ALL_TOOLS; });

describe("discovery: Composio tools of the tenant's connected apps only", () => {
  it("connecting a new app changes the cache key and lists its tools on the next pass (sorted toolkits)", async () => {
    m.slugs = ["composio.notion"];
    const first = await discoverToolsForTenant("T1", ["composio__*"]);
    m.slugs = ["composio.notion", "composio.gmail"];
    const second = await discoverToolsForTenant("T1", ["composio__*"]);
    expect(m.calls.map((c) => c.toolkits)).toEqual([["notion"], ["gmail", "notion"]]);
    const composioNames = (r: typeof first) => r.tools.filter((t) => t.server_id === "composio").map((t) => t.name).sort();
    expect(composioNames(first)).toEqual(["composio__NOTION_LIST_ITEMS"]);
    expect(composioNames(second)).toEqual(["composio__GMAIL_LIST_ITEMS", "composio__NOTION_LIST_ITEMS"]);
  });

  it("a native-rail app's composio row (linear, spec 14) is never listed", async () => {
    m.slugs = ["composio.hubspot", "composio.linear", "pipedream.gmail"];
    await discoverToolsForTenant("T1", ["composio__*"]);
    expect(m.calls[0].toolkits).toEqual(["hubspot"]);
  });

  it("every agent can read: with ALL_AGENTS_ALL_TOOLS=0 an agent that never declared composio still gets them", async () => {
    process.env.ALL_AGENTS_ALL_TOOLS = "0";
    m.slugs = ["composio.airtable"];
    const r = await discoverToolsForTenant("T1", ["web_search__search"]);
    expect(r.tools.map((t) => t.name)).toContain("composio__AIRTABLE_LIST_ITEMS");
    expect(r.disconnected_connectors).not.toContain("composio");
  });

  it("no connected Composio app: nothing listed and no spurious connect prompt", async () => {
    process.env.ALL_AGENTS_ALL_TOOLS = "0";
    m.slugs = [];
    const r = await discoverToolsForTenant("T1", ["web_search__search"]);
    expect(r.tools.some((t) => t.server_id === "composio")).toBe(false);
    expect(r.disconnected_connectors).not.toContain("composio");
  });

  it("connected-app read error → no Composio tools this pass, logged, never all toolkits", async () => {
    m.readError = true;
    const r = await discoverToolsForTenant("T1", ["composio__*"]);
    expect(r.tools.some((t) => t.server_id === "composio")).toBe(false);
    expect(m.calls).toEqual([]);
    expect(m.logs.map((l) => l.code)).toContain("composio_connected_read_failed");
  });
});
