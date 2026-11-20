
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toAnthropicName, fromAnthropicName } from "../../types";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
  listAppsMock: vi.fn(),
  listComposioCatalogMock: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/connectors/pipedream/api", () => ({ listApps: mocks.listAppsMock, getAppName: vi.fn() }));
vi.mock("@/services/connectors/composio/catalog", () => ({ listComposioCatalog: mocks.listComposioCatalogMock }));

const kit = (slug: string, name: string) => ({ slug, name, logo: "", category: null, managed: ["OAUTH2"], schemes: ["OAUTH2"], no_auth: false });
const CATALOG = [kit("notion", "Notion"), kit("gmail", "Gmail"), kit("bigmailer", "BigMailer"), kit("stripe", "Stripe"),
  kit("linear", "Linear"), kit("posthog", "PostHog"), kit("instagram", "Instagram")];

function fakeConnectorRows(rows: { slug: string }[]) {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => Promise.resolve({ data: rows, error: null });
  return { from: () => builder };
}

type Match = { slug: string; name: string; provider: string; already_connected: boolean };
async function search(query: string, rows: { slug: string }[] = [], max_results?: number): Promise<Match[]> {
  mocks.serviceClientMock.mockReturnValue(fakeConnectorRows(rows));
  const { callConnectorSearchTool } = await import("../connectors-search");
  const res = await callConnectorSearchTool("tenant-1", "search", { query, ...(max_results ? { max_results } : {}) });
  expect(res.ok).toBe(true);
  return (JSON.parse(res.content) as { matches: Match[] }).matches;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listComposioCatalogMock.mockResolvedValue(CATALOG);
});

describe("listConnectorSearchTools", () => {
  it("advertises connectors__search with the correct Anthropic name shape", async () => {
    const { listConnectorSearchTools } = await import("../connectors-search");
    const tools = listConnectorSearchTools();
    const t = tools.find((x) => x.tool_name === "search")!;
    expect(t.server_id).toBe("connectors");
    expect(t.tool_name).toBe("search");
    expect(t.input_schema.type).toBe("object");
    const name = toAnthropicName(t.server_id, t.tool_name);
    expect(name).toBe("connectors__search");
    expect(fromAnthropicName(name)).toEqual({ server_id: "connectors", tool_name: "search" });
  });
});

describe("callConnectorSearchTool", () => {
  it("offers a Composio catalog app, marked connected from the tenant's composio row; Pipedream is never queried", async () => {
    const m = await search("notion", [{ slug: "composio.notion" }, { slug: "pipedream.notion" }]);
    expect(m).toEqual([{ slug: "composio.notion", name: "Notion", provider: "composio", already_connected: true }]);
    expect(mocks.listAppsMock).not.toHaveBeenCalled();
    expect(m.some((x) => x.slug.startsWith("pipedream."))).toBe(false);
  });

  it("a native-rail app is offered as its native connector, never as a Composio twin", async () => {
    for (const q of ["stripe", "linear", "posthog"]) {
      const m = await search(q);
      expect(m.some((x) => x.slug.startsWith("composio.")), q).toBe(false);
      expect(m.find((x) => x.slug === q)).toMatchObject({ provider: "native", already_connected: false });
    }
    expect((await search("stripe", [{ slug: "composio.stripe" }]))[0].already_connected).toBe(false);
    expect((await search("stripe", [{ slug: "stripe" }]))[0].already_connected).toBe(true);
  });

  it("GA/GSC (Composio rail, no composio.* entry) keep their native entry — the rail-aware door connects through Composio", async () => {
    const m = await search("google analytics");
    expect(m.find((x) => x.slug === "google_analytics")).toMatchObject({ provider: "native", already_connected: false });
    const orphan = await search("google analytics", [{ slug: "composio.google_analytics" }]);
    expect(orphan.find((x) => x.slug === "google_analytics")?.already_connected).toBe(false);
    const c = await search("google analytics", [{ slug: "google_analytics" }]);
    expect(c.find((x) => x.slug === "google_analytics")?.already_connected).toBe(true);
    const g = await search("search console");
    expect(g.find((x) => x.slug === "google_search_console")).toMatchObject({ provider: "native" });
  });

  it("Instagram (Composio rail) is offered once, as composio.instagram", async () => {
    const m = await search("instagram");
    expect(m.filter((x) => x.name === "Instagram")).toEqual([
      { slug: "composio.instagram", name: "Instagram", provider: "composio", already_connected: false },
    ]);
  });

  it("keeps the exact app when max_results cuts the list", async () => {
    const m = await search("gmail", [], 1);
    expect(m.map((x) => x.name)).toEqual(["Gmail"]);
  });

  it("degrades to native-only matches when the Composio catalog throws", async () => {
    mocks.listComposioCatalogMock.mockRejectedValue(new Error("composio down"));
    const m = await search("stripe");
    expect(m).toEqual([{ slug: "stripe", name: "Stripe", provider: "native", already_connected: false }]);
  });

  it("the tool descriptions never offer Pipedream", async () => {
    const { listConnectorSearchTools } = await import("../connectors-search");
    for (const t of listConnectorSearchTools()) expect(t.description).not.toMatch(/pipedream/i);
  });

  it("returns tool_unknown for an unregistered tool name", async () => {
    const { callConnectorSearchTool } = await import("../connectors-search");
    const res = await callConnectorSearchTool("tenant-1", "nope", {});
    expect(res.ok).toBe(false);
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toBe("tool_unknown");
  });

  it("returns tool_input_invalid for a missing query", async () => {
    const { callConnectorSearchTool } = await import("../connectors-search");
    const res = await callConnectorSearchTool("tenant-1", "search", {});
    expect(res.ok).toBe(false);
    expect(JSON.parse(res.content).error).toBe("tool_input_invalid");
  });
});

describe("discovery + execute source wiring", () => {
  const root = join(__dirname, "..", "..");
  it("discovery.ts has the connectors server row + list branch", () => {
    const src = readFileSync(join(root, "discovery.ts"), "utf8");
    expect(src).toMatch(/server_id:\s*"connectors"/);
    expect(src).toMatch(/server\.server_id === "connectors"/);
    expect(src).toMatch(/listConnectorSearchTools\(\)/);
  });
  it("execute.ts has the connectors dispatch branch", () => {
    const src = readFileSync(join(root, "execute.ts"), "utf8");
    expect(src).toMatch(/server_id === "connectors"/);
    expect(src).toMatch(/callConnectorSearchTool\(/);
  });
});
