
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/mcp/execute", () => ({
  callMcpTool: vi.fn(async () => ({ ok: true, content: "{}", is_error: false, ms: 0 })),
}));

const tool = (server_id: string, tool_name: string) => ({
  name: `${server_id}__${tool_name}`,
  description: "d",
  input_schema: { type: "object", properties: {} },
  server_id,
  tool_name,
});
vi.mock("@/services/mcp/discovery", () => ({
  listToolsForTenant: vi.fn(async () => [
    tool("qa_engineer", "add_test_case"),
    tool("code_index", "search_code"),
    tool("web_search", "search"),
  ]),
}));

type Handler = (args: unknown, extra: unknown) => Promise<unknown>;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _d: string, _s: unknown, handler: Handler) => ({ name, handler }),
  createSdkMcpServer: (opts: { tools: Array<{ name: string }> }) => ({ tools: opts.tools }),
}));

import { mcpServerTools } from "../mcp-server-tools";

async function namesFor(agent_slug: string): Promise<string[]> {
  const server = (await mcpServerTools(
    { tenant_id: "t-1", run_id: "r-1", agent_slug },
    ["qa_engineer__add_test_case", "code_index__search_code", "web_search__search"],
  )) as unknown as { tools: Array<{ name: string }> };
  return server.tools.map((t) => t.name);
}

describe("mcpServerTools: internal tools hidden from custom agents", () => {
  it("a custom agent is offered neither QA engineer nor code search, and keeps the rest", async () => {
    const names = await namesFor("c-abc123def0");
    expect(names.some((n) => n.startsWith("qa_engineer__"))).toBe(false);
    expect(names.some((n) => n.startsWith("code_index__"))).toBe(false);
    expect(names).toContain("web_search__search");
  });

  it("control: a built-in agent still sees them (the strip is scoped, not a broken harness)", async () => {
    const names = await namesFor("engineer");
    expect(names).toContain("code_index__search_code");
  });
});
