
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: vi.fn(async () => false),
  FleetHaltedError: class FleetHaltedError extends Error {
    constructor() {
      super("Fleet is halted");
      this.name = "FleetHaltedError";
    }
  },
}));

vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: vi.fn(async () => ({
    metadata_praxis: {
      manual_only: true,
      side_effects: false,
      decision_class: null,
      cost_class: "standard",
    },
    slug: "browser-operator",
    name: "Browser Operator",
  })),
  getDispatcher: vi.fn(),
}));

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async () => {}),
}));

vi.mock("@/services/agents/ensure-runnable", () => ({
  ensureAgentRunnable: vi.fn(async () => ({ runnable: true })),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({
    rpc: vi.fn(async () => ({ data: "test-run-id", error: null })),
  })),
}));

vi.mock("@/services/agents/budget", () => ({
  resolveDailyCapUsd: vi.fn(async () => 0),
  estimateRunCost: vi.fn(() => 0),
  consumeBudgetOrReject: vi.fn(async () => true),
}));

vi.mock("@/workers/client", async () => {
  const inngest = {
    send: vi.fn(async () => {}),
    createFunction: vi.fn(),
  };
  return { inngest };
});
vi.mock("../../../../../../workers/client", async () => {
  const inngest = {
    send: vi.fn(async () => {}),
    createFunction: vi.fn(),
  };
  return { inngest };
});

import { enqueueAgentRun, SafetyGateError } from "@/services/agents/runner";

describe("P2: scheduled_dispatch gate — browser-operator is retired (2026-09-30)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["cron", "a2a", "mcp", "qa-weekly-execute", "handoff", "manual"] as const)(
    "trigger=%s is blocked for browser-operator (SafetyGateError)",
    async (trigger) => {
      await expect(
        enqueueAgentRun({
          agent_slug: "browser-operator",
          tenant_id: "t-test",
          trigger,
          payload: { source: "qa_weekly_execute" },
        }),
      ).rejects.toSatisfy((e: unknown) => {
        const err = e as Error;
        return err.name === "SafetyGateError" && err.message.includes("browser-operator");
      });
    },
  );

  it("trigger=cron for a DIFFERENT agent is allowed (gate is browser-operator-only)", async () => {
    const { loadAgentDefinition } = await import("@/services/agents/registry");
    (loadAgentDefinition as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata_praxis: {
        manual_only: false,
        side_effects: false,
        decision_class: null,
        cost_class: "standard",
      },
      slug: "growth-lead",
      name: "Growth Lead",
    });

    await expect(
      enqueueAgentRun({
        agent_slug: "growth-lead",
        tenant_id: "t-test",
        trigger: "cron",
      }),
    ).resolves.toMatchObject({ run_id: expect.any(String) });
  });
});
