
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/mcp/execute", () => ({
  callMcpTool: vi.fn(async () => ({ ok: true, content: "{}", is_error: false, ms: 0 })),
}));

vi.mock("@/services/mcp/discovery", () => ({
  listToolsForTenant: vi.fn(async () =>
    ["github__search_code", "github__read_file", "memory__search"].map((name) => ({
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
  tool: (name: string, _d: string, _s: unknown, handler: Handler) => ({ name, handler }),
  createSdkMcpServer: (opts: { tools: Array<{ name: string }> }) => ({ tools: opts.tools }),
}));

import { mcpServerTools } from "../mcp-server-tools";

async function namesFor(disabled_tools?: string[]): Promise<string[]> {
  const server = (await mcpServerTools(
    { tenant_id: "t-1", run_id: "r-1", agent_slug: "operator", disabled_tools },
    ["github__search_code", "github__read_file", "memory__search"],
  )) as unknown as { tools: Array<{ name: string }> };
  return server.tools.map((t) => t.name);
}

describe("mcpServerTools — variant tools.disable", () => {
  it("a disabled tool is not on the server the model talks to", async () => {
    const names = await namesFor(["github__search_code"]);
    expect(names).not.toContain("github__search_code");
    expect(names).toContain("github__read_file");
    expect(names).toContain("memory__search");
  });

  it("no disable list keeps the full grant", async () => {
    expect(await namesFor(undefined)).toHaveLength(3);
  });
});
