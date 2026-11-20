import { beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ seo: vi.fn(), email: vi.fn(), geo: vi.fn(), linkedin: vi.fn() }));
const OK = { ok: true, is_error: false, content: "{}", ms: 0 };

vi.mock("../governance-enforce", () => ({ governActionOrBlock: async () => ({ block: false }) }));
vi.mock("../discovery", () => ({ getEnabledStreamableServer: async () => null }));
vi.mock("../streamable-client", () => ({ callStreamableTool: vi.fn(), advertisedReadToolNames: () => new Set() }));
vi.mock("../internal/praxis", async (orig) => ({ ...(await orig<object>()), callPraxisTool: vi.fn() }));
vi.mock("../internal/seo", async (orig) => ({ ...(await orig<object>()), callSeoTool: async (...a: unknown[]) => (seen.seo(...a), OK) }));
vi.mock("../internal/geo", async (orig) => ({ ...(await orig<object>()), callGeoTool: async (...a: unknown[]) => (seen.geo(...a), OK) }));
vi.mock("../internal/email", async (orig) => ({ ...(await orig<object>()), callEmailTool: async (...a: unknown[]) => (seen.email(...a), OK) }));
vi.mock("../internal/linkedin-ads", async (orig) => ({ ...(await orig<object>()), callLinkedinAdsTool: async (...a: unknown[]) => (seen.linkedin(...a), OK) }));
vi.mock("@/services/routines/runner", () => ({ runTenantRoutine: vi.fn(), defaultDeps: {} }));
vi.mock("@/services/agents/skill-runtime", () => ({ handleSkillLoad: vi.fn() }));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));
vi.mock("@/services/agents/entitlement", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: async () => ({ enforced: true, tier: "pro", required_tier: "pro", allowed: true }),
}));

import { callMcpTool, type CallMcpContext } from "../execute";
import { callPraxisTool } from "../internal/praxis";

const ctx = (agent_slug: string, top_action_run?: boolean) => ({ tenant_id: "T1", run_id: "R1", agent_slug, top_action_run }) as CallMcpContext;

beforeEach(() => {
  seen.seo.mockClear();
  seen.email.mockClear();
});

describe("callMcpTool: top_action_run reaches the channel-card propose paths", () => {
  it("seo__propose_pr", async () => {
    await callMcpTool(ctx("seo", true), "seo", "propose_pr", {});
    expect(seen.seo.mock.calls[0][0]).toMatchObject({ run_id: "R1", top_action_run: true });
  });

  it("email__propose_campaign", async () => {
    await callMcpTool(ctx("email_marketing", true), "email", "propose_campaign", {});
    expect(seen.email.mock.calls[0][3]).toMatchObject({ run_id: "R1", top_action_run: true });
  });

  it("an ordinary run carries no marker", async () => {
    await callMcpTool(ctx("seo"), "seo", "propose_pr", {});
    expect(seen.seo.mock.calls[0][0].top_action_run).toBeUndefined();
  });
});

describe("callMcpTool: the founder-order mark reaches the praxis tools", () => {
  it.each([true, false, undefined])("founder_chat_order %s is forwarded as is", async (mark) => {
    vi.mocked(callPraxisTool).mockClear().mockResolvedValue(OK as never);
    await callMcpTool({ ...ctx("operator"), founder_chat_order: mark } as CallMcpContext, "praxis", "render_video", {});
    expect(vi.mocked(callPraxisTool).mock.calls[0][0].founder_chat_order).toBe(mark);
  });
});

describe("callMcpTool: GEO paid check receives server-only provenance", () => {
  it("forwards the human and suppression markers through the real dispatch", async () => {
    seen.geo.mockClear();
    await callMcpTool({
      ...ctx("geo"), trigger: "handoff", founder_chat_order: true,
      founder_order_group: "root-run", founder_order_unverified: false, untrusted_context: false, captured_page_context: false,
      writes_suppressed: false, redo: false,
    } as CallMcpContext, "geo", "start_answer_check", {});
    expect(seen.geo.mock.calls[0][0]).toMatchObject({
      tenant_id: "T1", run_id: "R1", run_trigger: "handoff", founder_chat_order: true,
      founder_order_group: "root-run", founder_order_unverified: false, untrusted_context: false, captured_page_context: false,
      writes_suppressed: false, redo: false,
    });
  });
});

describe("callMcpTool: the unverified founder mark reaches the LinkedIn tools", () => {
  it("linkedin_ads__propose_launch_campaign", async () => {
    const c = { ...ctx("linkedin_ads"), founder_chat_order: true, founder_order_unverified: true } as CallMcpContext;
    await callMcpTool(c, "linkedin_ads", "propose_launch_campaign", {});
    expect(seen.linkedin.mock.calls[0][0]).toMatchObject({ founder_chat_order: true, founder_order_unverified: true });
  });
});
