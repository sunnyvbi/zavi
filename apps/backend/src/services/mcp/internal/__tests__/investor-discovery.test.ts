
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toAnthropicName, fromAnthropicName } from "../../types";

const mocks = vi.hoisted(() => ({ callMcpTool: vi.fn() }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: mocks.callMcpTool }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listInvestorDiscoveryTools", () => {
  it("advertises investor_discovery__search with the correct Anthropic name shape", async () => {
    const { listInvestorDiscoveryTools } = await import("../investor-discovery");
    const tools = listInvestorDiscoveryTools();
    expect(tools).toHaveLength(1);
    const t = tools[0];
    expect(t.server_id).toBe("investor_discovery");
    expect(t.tool_name).toBe("search");
    expect(t.input_schema.type).toBe("object");
    const anthropicName = toAnthropicName(t.server_id, t.tool_name);
    expect(anthropicName).toBe("investor_discovery__search");
    expect(fromAnthropicName(anthropicName)).toEqual({
      server_id: "investor_discovery",
      tool_name: "search",
    });
  });
});

describe("callInvestorDiscoveryTool", () => {
  it("dispatches search and returns an ok JSON envelope", async () => {
    mocks.callMcpTool.mockImplementation(
      async (_ctx: unknown, server_id: string, _tool: string, args: { url?: string }) => {
        if (server_id === "web_search") {
          return {
            ok: true,
            is_error: false,
            content: JSON.stringify({ results: [{ url: "https://dir.example/investors-list" }] }),
            ms: 1,
          };
        }
        return {
          ok: true,
          is_error: false,
          content: JSON.stringify({
            final_url: args.url,
            status: 200,
            capture: "dom_text",
            body_text: "<untrusted_web_content>\nAcme Capital invests at seed and leads rounds.\n</untrusted_web_content>",
          }),
          ms: 1,
        };
      },
    );
    const { callInvestorDiscoveryTool } = await import("../investor-discovery");
    const ctx = { tenant_id: "t-1", run_id: "r-1" } as never;
    const res = await callInvestorDiscoveryTool(ctx, "search", { sector: "fintech", stage: "seed" });
    expect(res.ok).toBe(true);
    expect(res.is_error).toBe(false);
    const parsed = JSON.parse(res.content) as { count: number; pages_fetched: number };
    expect(typeof parsed.count).toBe("number");
    expect(typeof parsed.pages_fetched).toBe("number");
  });

  it("returns tool_unknown for an unregistered tool name", async () => {
    const { callInvestorDiscoveryTool } = await import("../investor-discovery");
    const ctx = { tenant_id: "t-1", run_id: "r-1" } as never;
    const res = await callInvestorDiscoveryTool(ctx, "nope", {});
    expect(res.ok).toBe(false);
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toBe("tool_unknown");
  });
});

describe("discovery + execute + classifier source wiring", () => {
  const mcpRoot = join(__dirname, "..", "..");
  it("discovery.ts has the investor_discovery server row + list branch", () => {
    const src = readFileSync(join(mcpRoot, "discovery.ts"), "utf8");
    expect(src).toMatch(/server_id:\s*"investor_discovery"/);
    expect(src).toMatch(/server\.server_id === "investor_discovery"/);
    expect(src).toMatch(/listInvestorDiscoveryTools\(\)/);
  });
  it("execute.ts dispatches investor_discovery to callInvestorDiscoveryTool with full ctx", () => {
    const src = readFileSync(join(mcpRoot, "execute.ts"), "utf8");
    expect(src).toMatch(/server_id === "investor_discovery"/);
    expect(src).toMatch(/callInvestorDiscoveryTool\(ctx,\s*tool_name,\s*args\)/);
  });
  it("tool-effect-classifier lists investor_discovery as internal; its search is declared a read", async () => {
    const { INTERNAL_SERVERS } = await import("../../tool-effect-classifier");
    const { effectOf } = await import("../../tool-effects");
    expect(INTERNAL_SERVERS.has("investor_discovery")).toBe(true);
    expect(effectOf("investor_discovery", "search")).toBe("read");
  });
});

describe("isSideEffectingTool for investor_discovery", () => {
  it("classifies investor_discovery__search as read-only (not side-effecting)", async () => {
    const { isSideEffectingTool } = await import("../../tool-effect-classifier");
    expect(isSideEffectingTool("investor_discovery", "search")).toBe(false);
  });
});
