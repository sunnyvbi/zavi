import { beforeEach, describe, expect, it, vi } from "vitest";

const SENTINEL = { ok: false, is_error: true, content: JSON.stringify({ error: "reached_governance" }), ms: 0 };
const govern = vi.fn(async () => ({ block: true, result: SENTINEL }));
const tier = vi.hoisted(() => ({ decide: null as unknown as (t: string, s: string) => Promise<unknown> }));

vi.mock("../governance-enforce", () => ({ governActionOrBlock: (...a: unknown[]) => govern(...(a as [])) }));
vi.mock("../discovery", () => ({ getEnabledStreamableServer: async () => null }));
vi.mock("../streamable-client", () => ({ callStreamableTool: vi.fn(), advertisedReadToolNames: () => new Set() }));
vi.mock("../internal/praxis", () => ({ callPraxisTool: vi.fn() }));
vi.mock("@/services/routines/runner", () => ({ runTenantRoutine: vi.fn(), defaultDeps: {} }));
vi.mock("@/services/agents/skill-runtime", () => ({ handleSkillLoad: vi.fn() }));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));
vi.mock("@/services/agents/entitlement", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: (t: string, s: string) => tier.decide(t, s),
}));

import { callMcpTool, type CallMcpContext } from "../execute";

const ctx = (agent_slug: string) => ({ tenant_id: "T1", run_id: "", agent_slug }) as CallMcpContext;
const FREE = { enforced: true, tier: "free", required_tier: "pro", allowed: false };
const PRO = { enforced: true, tier: "pro", required_tier: "pro", allowed: true };

beforeEach(() => {
  govern.mockClear();
  tier.decide = vi.fn(async () => FREE);
});

describe("callMcpTool: email send tools are refused below the email_marketing plan, for every agent", () => {
  it.each([
    ["growth-lead", "email", "propose_campaign"],
    ["cgo", "email", "propose_campaign"],
    ["chief-of-staff", "outbound", "propose_email"],
    ["operator", "outbound", "propose_cohort_email"],
    ["growth-lead", "email", "plan_send"],
    ["email_marketing", "email_campaign", "propose_send"],
  ])("%s calling %s/%s on a Free tenant is refused before governance and dispatch", async (agent, server, tool) => {
    const r = await callMcpTool(ctx(agent), server, tool, { route: "sendgrid" });
    expect(r.is_error).toBe(true);
    expect(JSON.parse(r.content)).toMatchObject({ error: "plan_upgrade_required", required_tier: "pro" });
    expect(govern).not.toHaveBeenCalled();
    expect(tier.decide).toHaveBeenCalledWith("T1", "email_marketing");
  });

  it("a plan read that throws refuses too (deny by default)", async () => {
    tier.decide = vi.fn(async () => {
      throw new Error("tier gate: subscription read failed");
    });
    const r = await callMcpTool(ctx("growth-lead"), "email", "propose_campaign", {});
    expect(JSON.parse(r.content)).toMatchObject({ error: "plan_unverified" });
    expect(govern).not.toHaveBeenCalled();
  });

  it("control: a Pro tenant's proposal goes on to governance", async () => {
    tier.decide = vi.fn(async () => PRO);
    const r = await callMcpTool(ctx("growth-lead"), "email", "propose_campaign", {});
    expect(r).toBe(SENTINEL);
    expect(govern).toHaveBeenCalledTimes(1);
  });

  it("control: reading lists and the transactional email tool never ask for the plan", async () => {
    await callMcpTool(ctx("growth-lead"), "outbound", "list_email_lists", {});
    await callMcpTool(ctx("support-lead"), "email", "send", {});
    expect(tier.decide).not.toHaveBeenCalled();
    expect(govern).toHaveBeenCalledTimes(2);
  });
});
