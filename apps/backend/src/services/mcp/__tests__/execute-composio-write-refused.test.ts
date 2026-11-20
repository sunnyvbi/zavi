import { describe, it, expect, vi } from "vitest";

const callStreamableTool = vi.fn();
const govern = vi.fn(async () => ({ block: false }));
vi.mock("../governance-enforce", () => ({ governActionOrBlock: (...args: unknown[]) => govern(...(args as [])) }));
vi.mock("../discovery", () => ({
  getEnabledStreamableServer: async () => ({
    tenant_id: "T1", server_id: "composio", transport: "streamable-http",
    url: "https://backend.composio.dev/v3/mcp/srv?user_id=T1", command: null, args: null, enabled: true,
  }),
}));
vi.mock("../streamable-client", () => ({
  callStreamableTool: (...a: unknown[]) => callStreamableTool(...a),
  advertisedReadToolNames: () => new Set(["GMAIL_FETCH_EMAILS"]),
}));
vi.mock("../internal/praxis", () => ({ callPraxisTool: vi.fn() }));
vi.mock("@/services/routines/runner", () => ({ runTenantRoutine: vi.fn(), defaultDeps: {} }));
vi.mock("@/services/agents/skill-runtime", () => ({ handleSkillLoad: vi.fn() }));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));
vi.mock("@/services/connectors/tiktok-ads/ad-accounts", () => ({
  ensureAdAccounts: async () => ({
    connected: true,
    accounts: [{ advertiser_id: "7683915592165785621", name: "Main", currency: "USD", status: "ENABLE", timezone: "UTC", source: "business_center" }],
    selected_id: "7683915592165785621",
    needs: "nothing",
    checked_at: null,
  }),
}));

import { callMcpTool, type CallMcpContext } from "../execute";
import { rememberComposioInputs } from "../composio-inputs";

describe("execute refuses a Composio write even if governance is bypassed", () => {
  it("missing TikTok lookup inputs stop before governance, approval, or vendor dispatch", async () => {
    rememberComposioInputs("qa-preflight", [{
      server_id: "composio",
      tool_name: "TIKTOK_ADS_GET_CREATIVE_ASSETS",
      description: "Get creative assets",
      input_schema: { type: "object", required: ["advertiser_id", "asset_type", "asset_ids"] },
    }]);
    govern.mockClear();
    callStreamableTool.mockClear();
    const r = await callMcpTool({ tenant_id: "qa-preflight", run_id: "" } as CallMcpContext, "composio", "TIKTOK_ADS_GET_CREATIVE_ASSETS", { advertiser_id: "7683915592165785621" });
    expect(JSON.parse(r.content).error).toBe("composio_invalid_arguments");
    expect(govern).not.toHaveBeenCalled();
    expect(callStreamableTool).not.toHaveBeenCalled();
  });
  it("a TikTok call naming an ad account the founder does not have stops before governance or dispatch", async () => {
    govern.mockClear();
    callStreamableTool.mockClear();
    const r = await callMcpTool({ tenant_id: "qa-preflight", run_id: "" } as CallMcpContext, "composio", "TIKTOK_ADS_GET_CREATIVE_ASSETS", { advertiser_id: "999", asset_type: "VIDEO", asset_ids: ["v"] });
    expect(JSON.parse(r.content).error).toBe("tiktok_ads_unknown_account");
    expect(govern).not.toHaveBeenCalled();
    expect(callStreamableTool).not.toHaveBeenCalled();
  });
  it("SQUARE_CREATE_REFUND (not in the read set) → tool_not_allowed, vendor never called", async () => {
    const r = await callMcpTool({ tenant_id: "T1", run_id: "" } as CallMcpContext, "composio", "SQUARE_CREATE_REFUND", { charge: "ch_1", amount: 500 });
    expect(JSON.parse(r.content).error).toBe("tool_not_allowed");
    expect(callStreamableTool).not.toHaveBeenCalled();
  });
  it("control: an advertised read does reach the vendor (the refusal above is the read-set gate, not a broken harness)", async () => {
    callStreamableTool.mockResolvedValueOnce({ ok: true, is_error: false, content: "[]", ms: 1 });
    const r = await callMcpTool({ tenant_id: "T1", run_id: "" } as CallMcpContext, "composio", "GMAIL_FETCH_EMAILS", {});
    expect(r.ok).toBe(true);
    expect(callStreamableTool).toHaveBeenCalledTimes(1);
  });
});
