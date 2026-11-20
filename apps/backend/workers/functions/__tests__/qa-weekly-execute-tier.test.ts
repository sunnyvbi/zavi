
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  enqueue: vi.fn(),
  tier: vi.fn(),
  tests: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../client", () => ({ inngest: { createFunction: vi.fn(() => ({})) } }));
vi.mock("@/services/agents/deepagent", () => ({ LangChainDeepAgentEngine: class {} }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: m.enqueue }));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn(async (k: string) => k === "qa_weekly_execute_enabled") }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn(async () => false) }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn(async () => "https://staging.example.com") }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/agents/entitlement", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: (...a: unknown[]) => m.tier(...a),
}));
vi.mock("@/services/supabase", () => {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.limit = async () => ({ data: m.tests, error: null });
  return { serviceClient: () => ({ from: () => b }) };
});

import { runForTenant } from "../qa-weekly-execute";

const tenant = { id: "t-1", display_name: "Acme" };
const test = (id: string) => ({ id, title: `case ${id}`, role: "guest", nl_spec: { steps: [] }, tags: [] });

beforeEach(() => {
  m.enqueue.mockReset();
  m.tier.mockReset();
  m.tests = [test("a"), test("b")];
  m.enqueue.mockResolvedValue({ run_id: "run-1" });
});

describe("qa-weekly-execute — tier gate", () => {
  it("tier below Starter → skipped with a plain reason, zero enqueues", async () => {
    m.tier.mockResolvedValue({ enforced: true, tier: "free", required_tier: "starter", allowed: false });
    const out = await runForTenant(tenant, "k1");
    expect(out.status).toBe("skipped");
    expect((out as { reason: string }).reason).toMatch(/plan_upgrade_required: Browser Operator needs the Starter plan/);
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.tier).toHaveBeenCalledWith("t-1", "browser-operator");
  });

  it("tier unreadable → skipped (fail closed), zero enqueues", async () => {
    m.tier.mockRejectedValue(new Error("db down"));
    const out = await runForTenant(tenant, "k1");
    expect(out.status).toBe("skipped");
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("allowed → enqueues every case", async () => {
    m.tier.mockResolvedValue({ enforced: true, tier: "starter", required_tier: "starter", allowed: true });
    const out = await runForTenant(tenant, "k1");
    expect(out.status).toBe("ok");
    expect(m.enqueue).toHaveBeenCalledTimes(2);
  });

  it("downgrade race mid-batch → stops cleanly, keeps what started", async () => {
    m.tier.mockResolvedValue({ enforced: true, tier: "starter", required_tier: "starter", allowed: true });
    m.enqueue.mockResolvedValueOnce({ run_id: "run-1" }).mockRejectedValueOnce(
      Object.assign(new Error("Browser Operator needs the Starter plan ($20/mo)."), {
        code: "plan_upgrade_required",
        agent_slug: "browser-operator",
        required_tier: "starter",
        body: {},
      }),
    );
    m.tests = [test("a"), test("b"), test("c")];
    const out = await runForTenant(tenant, "k1");
    expect(out.status).toBe("ok");
    expect((out as { enqueued_runs: unknown[] }).enqueued_runs).toHaveLength(1);
    expect(m.enqueue).toHaveBeenCalledTimes(2);
  });
});
