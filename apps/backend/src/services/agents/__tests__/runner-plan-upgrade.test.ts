
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  gates: { runnable: true } as Record<string, unknown>,
  rpcResult: { data: "run-1", error: null } as { data: unknown; error: unknown },
  rpcCalls: 0,
  rejections: [] as Array<Record<string, unknown>>,
  disabled: false,
  disabledCalls: [] as Array<[string, string | undefined]>,
}));

vi.mock("../deepagent", () => ({ LangChainDeepAgentEngine: class {} }));
vi.mock("../fleet-halt", async (orig) => ({
  ...(await orig<typeof import("../fleet-halt")>()),
  isFleetHalted: async () => false,
}));
vi.mock("@/services/tenants/disabled", async (orig) => ({
  ...(await orig<typeof import("@/services/tenants/disabled")>()),
  isTenantDisabled: async (t: string, mode?: string) => {
    m.disabledCalls.push([t, mode]);
    return m.disabled;
  },
}));
vi.mock("../registry", async (orig) => ({
  ...(await orig<typeof import("../registry")>()),
  loadAgentDefinition: async (slug: string) => ({
    slug,
    content_hash: "h",
    metadata_praxis: { manual_only: true, side_effects: false, cost_class: "cheap", requires_sandbox: false },
  }),
}));
vi.mock("@/services/sandbox/sandbox-enablement-flag", async (orig) => ({
  ...(await orig<typeof import("@/services/sandbox/sandbox-enablement-flag")>()),
  resolveSandboxMode: async () => ({ requires_sandbox: false, lazyEligible: false }),
}));
vi.mock("../budget", async (orig) => ({
  ...(await orig<typeof import("../budget")>()),
  resolveDailyCapUsd: async () => 0,
}));
vi.mock("../ensure-runnable", async (orig) => ({
  ...(await orig<typeof import("../ensure-runnable")>()),
  ensureAgentRunnable: async (_t: string, slug: string) =>
    m.gates.runnable ? { runnable: true, agent: { slug } } : m.gates,
}));
vi.mock("@/services/analytics/mixpanel", () => ({ track: () => {} }));
vi.mock("@/services/logging/logEvent", async (orig) => ({
  ...(await orig<typeof import("@/services/logging/logEvent")>()),
  logEvent: async () => {},
}));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: async () => {} }));
vi.mock("@/services/supabase", () => {
  const client = {
    rpc: async () => {
      m.rpcCalls += 1;
      return m.rpcResult;
    },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === "enqueue_rejections") m.rejections.push(row);
        return { error: null };
      },
    }),
  };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});

import { enqueueAgentRun, PlanUpgradeRequiredError, TenantDisabledError } from "../runner";

const T = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  m.gates = { runnable: true };
  m.rpcResult = { data: "run-1", error: null };
  m.rpcCalls = 0;
  m.rejections.length = 0;
  m.disabled = false;
  m.disabledCalls.length = 0;
});

describe("enqueueAgentRun — disabled workspace", () => {
  it("refuses with TenantDisabledError (code tenant_disabled) before any RPC, fail-open read", async () => {
    m.disabled = true;
    const err = await enqueueAgentRun({ tenant_id: T, agent_slug: "pm", trigger: "a2a", payload: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(TenantDisabledError);
    expect(err.code).toBe("tenant_disabled");
    expect(m.rpcCalls).toBe(0);
    expect(m.disabledCalls).toEqual([[T, "open"]]);
  });

  it("an active tenant enqueues as before", async () => {
    const r = await enqueueAgentRun({ tenant_id: T, agent_slug: "pm", trigger: "a2a", payload: {} });
    expect(r).toBeTruthy();
    expect(m.rpcCalls).toBeGreaterThan(0);
  });
});

describe("enqueueAgentRun — plan_upgrade_required", () => {
  it("TS gate refusal → PlanUpgradeRequiredError with required_tier + 403 body, no RPC", async () => {
    m.gates = { runnable: false, reason: "plan_upgrade_required", required_tier: "pro", detail: "x" };
    const err = await enqueueAgentRun({ tenant_id: T, agent_slug: "meta_ads", trigger: "a2a", payload: {} }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(PlanUpgradeRequiredError);
    expect(err.required_tier).toBe("pro");
    expect(err.body).toEqual({
      error: {
        code: "plan_upgrade_required",
        required_tier: "pro",
        message: "Meta Ads needs the Pro plan ($240/mo).",
      },
    });
    expect(m.rpcCalls).toBe(0);
    await vi.waitFor(() => expect(m.rejections[0]?.rejection_reason).toBe("plan_upgrade_required"));
  });

  it("DB trigger raise → PlanUpgradeRequiredError with the tier from details", async () => {
    m.rpcResult = {
      data: null,
      error: { message: "plan_upgrade_required", details: "starter", code: "P0001" },
    };
    const err = await enqueueAgentRun({ tenant_id: T, agent_slug: "seo", trigger: "a2a", payload: {} }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(PlanUpgradeRequiredError);
    expect(err.required_tier).toBe("starter");
    expect(err.message).toMatch(/needs the Starter plan \(\$20\/mo\)/);
  });

  it("DB raise with no details defaults to pro (never under-states the price)", async () => {
    m.rpcResult = { data: null, error: { message: "plan_upgrade_required" } };
    const err = await enqueueAgentRun({ tenant_id: T, agent_slug: "engineer", trigger: "a2a", payload: {} }).catch(
      (e) => e,
    );
    expect(err.required_tier).toBe("pro");
  });

  it("insufficient_credits still maps to its own error (no collision)", async () => {
    m.rpcResult = { data: null, error: { message: "insufficient_credits" } };
    const err = await enqueueAgentRun({ tenant_id: T, agent_slug: "seo", trigger: "a2a", payload: {} }).catch(
      (e) => e,
    );
    expect(err).not.toBeInstanceOf(PlanUpgradeRequiredError);
    expect(err.name).toBe("InsufficientCreditsError");
  });
});
