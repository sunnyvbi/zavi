
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/mcp/execute", () => ({
  callMcpTool: vi.fn(async () => ({ ok: true, content: "{}", is_error: false, ms: 0 })),
}));

vi.mock("@/services/mcp/discovery", () => ({
  listToolsForTenant: vi.fn(async () => [
    {
      name: "google_ads__list_campaigns",
      description: "List campaigns.",
      input_schema: { type: "object", properties: {} },
      server_id: "google_ads",
      tool_name: "list_campaigns",
    },
    {
      name: "google_ads__propose_budget_change",
      description: "Propose a budget change.",
      input_schema: { type: "object", properties: {} },
      server_id: "google_ads",
      tool_name: "propose_budget_change",
    },
  ]),
}));

type Handler = (args: unknown, extra: unknown) => Promise<unknown>;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _d: string, _s: unknown, handler: Handler) => ({ name, handler }),
  createSdkMcpServer: (opts: { tools: Array<{ name: string }> }) => ({ tools: opts.tools }),
}));

import { mcpServerTools } from "../mcp-server-tools";

const DECLARED = ["google_ads__list_campaigns", "google_ads__propose_budget_change"];

async function namesFor(redo: boolean | undefined): Promise<string[]> {
  const server = (await mcpServerTools(
    { tenant_id: "t-1", run_id: "r-1", agent_slug: "google_ads", redo },
    DECLARED,
  )) as unknown as { tools: Array<{ name: string }> };
  return server.tools.map((t) => t.name);
}

describe("mcpServerTools — redo strip on the live engine", () => {
  it("a redo run cannot see the money proposal at all", async () => {
    const names = await namesFor(true);
    expect(names).not.toContain("google_ads__propose_budget_change");
  });

  it("a redo run keeps the reads it needs to do the rewrite", async () => {
    const names = await namesFor(true);
    expect(names).toContain("google_ads__list_campaigns");
  });

  it("a NORMAL run still has its full grant", async () => {
    const names = await namesFor(false);
    expect(names).toContain("google_ads__list_campaigns");
    expect(names).toContain("google_ads__propose_budget_change");
  });

  it("an absent redo flag means normal, not stripped", async () => {
    const names = await namesFor(undefined);
    expect(names).toContain("google_ads__propose_budget_change");
  });
});

describe("mcpServerTools — channel chat answer turn", () => {
  async function namesForTurn(chat_answer_turn: boolean | undefined): Promise<string[]> {
    const server = (await mcpServerTools(
      { tenant_id: "t-1", run_id: "r-1", agent_slug: "google_ads", trigger: "chat", chat_answer_turn },
      DECLARED,
    )) as unknown as { tools: Array<{ name: string }> };
    return server.tools.map((t) => t.name);
  }

  it("a question turn cannot see the proposal, and keeps its reads", async () => {
    const names = await namesForTurn(true);
    expect(names).not.toContain("google_ads__propose_budget_change");
    expect(names).toContain("google_ads__list_campaigns");
  });

  it("an action turn keeps the proposal", async () => {
    expect(await namesForTurn(false)).toContain("google_ads__propose_budget_change");
  });
});
