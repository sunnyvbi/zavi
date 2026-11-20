import { describe, it, expect, vi } from "vitest";

const govern = vi.fn(async () => ({ block: false }));
vi.mock("../governance-enforce", () => ({ governActionOrBlock: (...a: unknown[]) => govern(...(a as [])) }));
vi.mock("../discovery", () => ({ getEnabledStreamableServer: async () => null }));
vi.mock("../streamable-client", () => ({ callStreamableTool: vi.fn(), advertisedReadToolNames: () => new Set() }));
vi.mock("../internal/praxis", () => ({ callPraxisTool: vi.fn() }));
vi.mock("@/services/routines/runner", () => ({ runTenantRoutine: vi.fn(), defaultDeps: {} }));
vi.mock("@/services/agents/skill-runtime", () => ({ handleSkillLoad: vi.fn() }));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));

import { callMcpTool, type CallMcpContext } from "../execute";

const ctx = (agent_slug: string) => ({ tenant_id: "T1", run_id: "", agent_slug }) as CallMcpContext;

describe("paid channel execution scope", () => {
  it.each([
    ["google_ads", "list_campaigns"],
    ["meta_ads", "list_campaigns"],
    ["reddit_ads", "list_campaigns"],
    ["tiktok_ads", "propose_new_campaign"],
    ["growth", "read_ads_perf"],
  ])("refuses a ChatGPT Ads call to %s before governance or provider dispatch", async (server, name) => {
    govern.mockClear();
    const result = await callMcpTool(ctx("chatgpt_ads"), server, name, {});
    expect(JSON.parse(result.content).error).toBe("channel_scope_mismatch");
    expect(govern).not.toHaveBeenCalled();
  });
});

describe("callMcpTool: internal servers refused for custom agents", () => {
  it.each([
    ["qa_engineer", "add_test_case"],
    ["code_index", "search_code"],
  ])("c-* slug + %s is refused before governance", async (server, name) => {
    govern.mockClear();
    const r = await callMcpTool(ctx("c-abc123def0"), server, name, {});
    expect(r.is_error).toBe(true);
    expect(JSON.parse(r.content)).toEqual({
      error: "tool_not_available",
      message: "This tool is not available to custom agents.",
    });
    expect(govern).not.toHaveBeenCalled();
  });

  it("control: a built-in slug is not refused by this gate", async () => {
    const r = await callMcpTool(ctx("engineer"), "code_index", "search_code", {});
    expect(JSON.parse(r.content).error).not.toBe("tool_not_available");
  });
});
