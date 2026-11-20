import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ rpc: vi.fn(), read: vi.fn(), firstRun: vi.fn(), attention: vi.fn(), arm: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantRpc: h.rpc,
  applySecretListEditRpc: vi.fn(), globalClient: () => ({}), StaleRevisionError: class extends Error {},
  tenantClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: h.read }) }) }) }) }));
vi.mock("../auto-first-run", () => ({ fanOutFirstRun: h.firstRun }));
vi.mock("../goal-attention", () => ({ sendGoalAttention: h.attention }));
vi.mock("../plan-ready-email", () => ({ armPlanReadyEmail: h.arm }));
import { applySavedStrategy, advanceStrategyDelivery } from "../strategy-delivery";
beforeEach(() => { vi.useFakeTimers(); h.rpc.mockReset(); h.read.mockReset().mockResolvedValue({ data: null, error: null }); h.firstRun.mockReset(); h.attention.mockReset(); h.arm.mockReset().mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); });
describe("saved draft recovery", () => {
  it("retries a lost response in the same tenant and run, without asking a model", async () => {
    h.rpc.mockResolvedValueOnce({ error: { message: "unavailable" } }).mockResolvedValueOnce({ data: { phase: "applied", plan_id: "plan" } });
    const pending = applySavedStrategy("tenant", "run");
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ run_id: "run", phase: "applied", plan_id: "plan" });
    expect(h.rpc.mock.calls).toEqual(Array.from({ length: 2 }, () => ["tenant", "advance_growth_strategy", { p_run_id: "run", p_phase: "apply", p_artifact: null }]));
  });
  it("stops after three failed saves and preserves the failure for recovery", async () => {
    h.rpc.mockResolvedValue({ error: { message: "database credentials must not escape" } });
    const pending = expect(applySavedStrategy("tenant", "run")).rejects.toThrow("strategy_delivery_write_failed");
    await vi.advanceTimersByTimeAsync(300); await pending;
    expect(h.rpc.mock.calls.map(c => c[2].p_phase)).toEqual(["apply", "apply", "apply", "failed"]);
    expect(h.firstRun).not.toHaveBeenCalled();
  });
  it("does not fan out a reset draft", async () => {
    h.rpc.mockResolvedValue({ data: { phase: "superseded" } });
    expect((await applySavedStrategy("tenant", "run")).phase).toBe("superseded");
    expect(h.read).not.toHaveBeenCalled(); expect(h.firstRun).not.toHaveBeenCalled();
    expect(h.arm).not.toHaveBeenCalled();
  });
  it("arms the plan-ready email when the plan applies, and a failed arm never fails the apply", async () => {
    h.rpc.mockResolvedValue({ data: { phase: "applied", plan_id: "plan" } });
    h.arm.mockRejectedValue(new Error("inngest down"));
    expect((await applySavedStrategy("tenant", "run")).phase).toBe("applied");
    expect(h.arm).toHaveBeenCalledWith("tenant", "run");
  });
  it("does not call an unknown receipt successful", async () => {
    h.rpc.mockResolvedValue({ data: { phase: "made_up" } });
    await expect(advanceStrategyDelivery("tenant", "run", "checking")).rejects.toThrow("strategy_delivery_write_failed");
  });
  it("a committed plan remains successful if optional follow-up fails", async () => {
    h.rpc.mockResolvedValue({ data: { phase: "applied", plan_id: "plan", goal_id: "goal" } });
    h.read.mockResolvedValue({ data: { phase: "applied", artifact: { strategy: { channel_bets: [] } } } });
    h.firstRun.mockRejectedValue(new Error("worker unavailable"));
    expect((await applySavedStrategy("tenant", "run")).phase).toBe("applied");
    expect(h.rpc).toHaveBeenCalledTimes(1); expect(h.attention).toHaveBeenCalledWith({ tenant_id: "tenant", reason: "goal_set", goal_id: "goal" });
  });
});
