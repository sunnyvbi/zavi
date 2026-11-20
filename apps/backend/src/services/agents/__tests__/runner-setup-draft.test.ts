import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ calls: [] as Array<{ name: string; args: Record<string, unknown> }> }));
vi.mock("../deepagent", () => ({ LangChainDeepAgentEngine: class {} }));
vi.mock("../fleet-halt", async (orig) => ({ ...(await orig<typeof import("../fleet-halt")>()), isFleetHalted: async () => false }));
vi.mock("../registry", async (orig) => ({
  ...(await orig<typeof import("../registry")>()),
  loadAgentDefinition: async (slug: string) => ({
    slug, content_hash: "h",
    metadata_praxis: { manual_only: true, side_effects: false, cost_class: "expensive", requires_sandbox: false },
  }),
}));
vi.mock("@/services/sandbox/sandbox-enablement-flag", async (orig) => ({
  ...(await orig<typeof import("@/services/sandbox/sandbox-enablement-flag")>()),
  resolveSandboxMode: async () => ({ requires_sandbox: false, lazyEligible: false }),
}));
vi.mock("../budget", async (orig) => ({ ...(await orig<typeof import("../budget")>()), resolveDailyCapUsd: async () => 0 }));
vi.mock("../ensure-runnable", async (orig) => ({
  ...(await orig<typeof import("../ensure-runnable")>()),
  ensureAgentRunnable: async (_t: string, slug: string) => ({ runnable: true, agent: { slug } }),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: async () => ({}) } }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: () => {} }));
vi.mock("@/services/logging/logEvent", async (orig) => ({ ...(await orig<typeof import("@/services/logging/logEvent")>()), logEvent: async () => {} }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: async () => {} }));
vi.mock("@/services/supabase", () => {
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      m.calls.push({ name, args });
      return { data: "run-1", error: null };
    },
    from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({ error: null }) }) }),
  };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});

import { enqueueAgentRun } from "../runner";
const T = "11111111-1111-1111-1111-111111111111";
beforeEach(() => { m.calls.length = 0; });

describe("enqueueAgentRun: setup drafts 1-3 go through the admission bridge", () => {
  it("setup_draft_attempt routes to enqueue_setup_draft with the attempt and NO key", async () => {
    await enqueueAgentRun({ tenant_id: T, agent_slug: "cgo", trigger: "a2a", payload: { stage: "draft_strategy" }, setup_draft_attempt: 2 });
    const call = m.calls.find((c) => c.name.startsWith("enqueue_"))!;
    expect(call).toEqual({ name: "enqueue_setup_draft", args: { p_tenant_id: T, p_agent_hash: "h", p_payload: { stage: "draft_strategy" }, p_attempt: 2 } });
  });
  it("everything else keeps using enqueue_agent_run (no bridge)", async () => {
    await enqueueAgentRun({ tenant_id: T, agent_slug: "cgo", trigger: "a2a", payload: {}, cron_dedupe_key: `cgo:draft:${T}:setup:paid:4` });
    expect(m.calls.find((c) => c.name.startsWith("enqueue_"))!.name).toBe("enqueue_agent_run");
  });
  it.each([
    [{ agent_slug: "growth-lead" }],
    [{ trigger: "manual" as const, user_access_token: "tok" }],
    [{ cron_dedupe_key: "x" }],
  ])("refuses a setup_draft_attempt on anything but a server-written cgo a2a run: %j", async (over) => {
    await expect(
      enqueueAgentRun({ tenant_id: T, agent_slug: "cgo", trigger: "a2a", payload: {}, setup_draft_attempt: 1, ...over }),
    ).rejects.toThrow(/setup_draft_attempt/);
    expect(m.calls.find((c) => c.name.startsWith("enqueue_"))).toBeUndefined();
  });
});
