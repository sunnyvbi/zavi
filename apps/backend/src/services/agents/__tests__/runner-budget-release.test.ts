import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  enqueue: { data: "run-1", error: null } as { data: string | null; error: { message: string } | null },
  queue: null as Array<{ data: string | null; error: { message: string } | null }> | null,
}));
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
vi.mock("../budget", async (orig) => ({ ...(await orig<typeof import("../budget")>()), resolveDailyCapUsd: async () => 50 }));
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
      if (name.startsWith("enqueue_")) {
        await new Promise((r) => setTimeout(r, 1));
        return m.queue ? m.queue.shift()! : m.enqueue;
      }
      return { data: true, error: null };
    },
    from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({ error: null }) }) }),
  };
  return { serviceClient: () => client, serverClientFromBearer: () => client };
});

import { enqueueAgentRun } from "../runner";
const T = "11111111-1111-1111-1111-111111111111";
beforeEach(() => {
  m.calls.length = 0;
  m.enqueue = { data: "run-1", error: null };
  m.queue = null;
});
const names = () => m.calls.map((c) => c.name);

describe("enqueueAgentRun: budget reservation given back when no run is created", () => {
  it("a created run keeps its reservation", async () => {
    await enqueueAgentRun({ tenant_id: T, agent_slug: "cgo", trigger: "a2a", payload: {}, setup_draft_attempt: 1 });
    expect(names()).toEqual(["consume_budget_or_reject", "enqueue_setup_draft"]);
  });

  it("a run deduped by its unique key gives back exactly the reservation it took, same day", async () => {
    m.enqueue = { data: null, error: null };
    expect(await enqueueAgentRun({ tenant_id: T, agent_slug: "cgo", trigger: "a2a", payload: {}, setup_draft_attempt: 1 })).toEqual({ run_id: "" });
    const charge = m.calls.find((c) => c.name === "consume_budget_or_reject")!.args;
    const release = m.calls.find((c) => c.name === "release_budget_reservation")!.args;
    expect(release).toEqual({ p_tenant_id: T, p_day: charge.p_day, p_estimate: charge.p_estimate });
  });

  it("a refused enqueue (e.g. no credits) gives the reservation back too, then throws", async () => {
    m.enqueue = { data: null, error: { message: "insufficient_credits" } };
    await expect(enqueueAgentRun({ tenant_id: T, agent_slug: "cgo", trigger: "a2a", payload: {}, cron_dedupe_key: "k" })).rejects.toThrow();
    expect(names()).toContain("release_budget_reservation");
  });

  it("the page and the first plan watch starting the same attempt at once: one run, one reservation kept", async () => {
    m.queue = [{ data: "run-1", error: null }, { data: null, error: null }];
    const start = () => enqueueAgentRun({ tenant_id: T, agent_slug: "cgo", trigger: "a2a", payload: {}, setup_draft_attempt: 1 });
    const [a, b] = await Promise.all([start(), start()]);
    expect([a.run_id, b.run_id].sort()).toEqual(["", "run-1"]);
    const charges = m.calls.filter((c) => c.name === "consume_budget_or_reject");
    const releases = m.calls.filter((c) => c.name === "release_budget_reservation");
    expect(charges).toHaveLength(2);
    expect(releases).toHaveLength(1);
    expect(releases[0]!.args).toEqual({ p_tenant_id: T, p_day: charges[0]!.args.p_day, p_estimate: charges[0]!.args.p_estimate });
  });

  it("never releases twice for one enqueue, and never when the run was created", async () => {
    m.enqueue = { data: null, error: { message: "insufficient_credits" } };
    await enqueueAgentRun({ tenant_id: T, agent_slug: "cgo", trigger: "a2a", payload: {}, cron_dedupe_key: "k" }).catch(() => {});
    expect(names().filter((n) => n === "release_budget_reservation")).toHaveLength(1);
    m.calls.length = 0;
    m.enqueue = { data: "run-2", error: null };
    await enqueueAgentRun({ tenant_id: T, agent_slug: "cgo", trigger: "a2a", payload: {}, cron_dedupe_key: "k2" });
    expect(names()).not.toContain("release_budget_reservation");
  });

  it("a retry after a dropped enqueue charges again and gives back again: the counter nets to zero per dropped try", async () => {
    m.enqueue = { data: null, error: null };
    for (let i = 0; i < 3; i++) await enqueueAgentRun({ tenant_id: T, agent_slug: "cgo", trigger: "a2a", payload: {}, setup_draft_attempt: 1 });
    expect(names().filter((n) => n === "consume_budget_or_reject")).toHaveLength(3);
    expect(names().filter((n) => n === "release_budget_reservation")).toHaveLength(3);
  });
});
