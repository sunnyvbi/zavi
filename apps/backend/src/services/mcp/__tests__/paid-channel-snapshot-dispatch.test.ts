import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc }) }));
vi.mock("../governance-enforce", () => ({ governActionOrBlock: async () => ({ block: false }) }));
vi.mock("../discovery", () => ({ getEnabledStreamableServer: async () => null }));
vi.mock("../streamable-client", () => ({ callStreamableTool: vi.fn(), advertisedReadToolNames: () => new Set() }));
vi.mock("../internal/praxis", () => ({ callPraxisTool: vi.fn() }));
vi.mock("@/services/routines/runner", () => ({ runTenantRoutine: vi.fn(), defaultDeps: {} }));
vi.mock("@/services/agents/skill-runtime", () => ({ handleSkillLoad: vi.fn() }));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));

import { callMcpTool, type CallMcpContext } from "../execute";

const context = (agent_slug: string) => ({ tenant_id: "T1", run_id: "", agent_slug }) as CallMcpContext;

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: { spend: 20 }, error: null });
});

describe("paid snapshot scope through MCP dispatch and its internal wrapper", () => {
  it.each(["meta_ads", "google_ads", "tiktok_ads", "linkedin_ads"])(
    "rejects ChatGPT Ads reading %s before a database call, even with forged input identity",
    async (provider) => {
      const result = await callMcpTool(context("chatgpt_ads"), "paid_acquisition", "get_latest_snapshot", {
        provider,
        agent_slug: "operator",
        tenant_id: "other-tenant",
      });
      expect(result.is_error).toBe(true);
      expect(JSON.parse(result.content).error).toBe("channel_scope_mismatch");
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["chatgpt_ads", "chatgpt_ads"],
    ["youtube_ads", "google_ads"],
    ["operator", "meta_ads"],
  ])("allows %s to read %s using the server's tenant", async (agent, provider) => {
    const result = await callMcpTool(context(agent), "paid_acquisition", "get_latest_snapshot", {
      provider,
      tenant_id: "other-tenant",
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toEqual({ spend: 20 });
    expect(rpc).toHaveBeenCalledWith("get_latest_ad_snapshot", {
      p_tenant_id: "T1",
      p_provider: provider,
      p_max_age_days: 14,
    });
  });
});
