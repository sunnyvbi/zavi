
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/mcp/execute", () => ({
  callMcpTool: vi.fn(async () => ({ ok: true, content: "{}", is_error: false, ms: 0 })),
}));

vi.mock("@/services/mcp/discovery", () => ({
  listToolsForTenant: vi.fn(async () =>
    ["growth__get_metric", "operator_db__catalog", "meta_ads__propose_budget_change", "github__grep"].map((name) => ({
      name,
      description: name,
      input_schema: { type: "object", properties: {} },
      server_id: name.split("__")[0],
      tool_name: name.split("__")[1],
    })),
  ),
}));

type Handler = (args: unknown, extra: unknown) => Promise<unknown>;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _d: string, _s: unknown, handler: Handler, extras?: { alwaysLoad?: boolean }) => ({
    name,
    handler,
    alwaysLoad: extras?.alwaysLoad === true,
  }),
  createSdkMcpServer: (opts: { tools: Array<{ name: string }> }) => ({ tools: opts.tools }),
}));

import { mcpServerTools } from "../mcp-server-tools";
import { alwaysLoadForAgent } from "../always-load";
import { listToolsForTenant } from "@/services/mcp/discovery";

async function serverFor(slug: string, stage?: string) {
  const server = (await mcpServerTools(
    { tenant_id: "t-1", run_id: "r-1", agent_slug: slug },
    ["growth__get_metric", "meta_ads__propose_budget_change", "github__grep"],
    undefined,
    alwaysLoadForAgent(slug, ["growth__get_metric", "meta_ads__propose_budget_change"], stage),
  )) as unknown as { tools: Array<{ name: string; alwaysLoad: boolean }> };
  return server.tools;
}

describe("mcpServerTools — per-agent preload", () => {
  it("loads cgo's resolved everyday reads up front and keeps the rest behind search", async () => {
    const tools = await serverFor("cgo");
    const loaded = tools.filter((t) => t.alwaysLoad).map((t) => t.name).sort();
    expect(loaded).toEqual(["growth__get_metric", "operator_db__catalog"]);
    expect(tools.map((t) => t.name)).not.toContain("web_fetch__fetch");
    expect(tools).toHaveLength(4);
  });

  it("changes nothing for an agent without a preload list", async () => {
    const tools = await serverFor("pm");
    expect(tools.filter((t) => t.alwaysLoad)).toEqual([]);
  });
});

it.each(["operator", "chatgpt_ads", "instagram_organic"])("does not add missing tools for %s", async slug => {
  const tools = await serverFor(slug);
  expect(tools.map(t => t.name)).not.toContain("praxis__handoff");
  expect(tools.map(t => t.name)).not.toContain("chatgpt_ads__read_performance");
  expect(tools.map(t => t.name)).not.toContain("social__propose_post");
});

it.each([
  ["operator", "praxis__handoff"],
  ["chatgpt_ads", "chatgpt_ads__read_performance"],
  ["instagram_organic", "report__render_social_image"],
  ["instagram_organic", "social__propose_post"],
  ["instagram_organic", "social__list_posts"],
  ["instagram_organic", "instagram__read_insights"],
])("preloads the resolved tool for %s without changing the tool set", async (slug, name) => {
  vi.mocked(listToolsForTenant).mockResolvedValueOnce([name, "github__grep"].map(toolName => ({
    name: toolName, description: toolName,
    input_schema: { type: "object", properties: {} },
    server_id: toolName.split("__")[0], tool_name: toolName.split("__")[1],
  })));
  const tools = await serverFor(slug);
  expect(tools.map(t => t.name)).toEqual([name, "github__grep"]);
  expect(tools.filter(t => t.alwaysLoad).map(t => t.name)).toEqual([name]);
});

it.each([
 ["draft_strategy","growth__seo_audit"], ["draft_strategy","growth__diagnose_funnel"],
 ["own_goals","growth__compute"], ["own_goals","growth__ad_budget_room"],
])("preloads the already-resolved %s tool %s without granting anything",async(stage,name)=>{
 vi.mocked(listToolsForTenant).mockResolvedValueOnce([name,"github__grep"].map(n=>({name:n,description:n,input_schema:{type:"object",properties:{}},server_id:n.split("__")[0],tool_name:n.split("__")[1]})));
 const tools=await serverFor("cgo",stage);
 expect(tools.map(t=>t.name)).toEqual([name,"github__grep"]);
 expect(tools.filter(t=>t.alwaysLoad).map(t=>t.name)).toEqual([name]);
 const absent=await serverFor("cgo",stage);
 expect(absent.map(t=>t.name)).not.toContain(name);
});
