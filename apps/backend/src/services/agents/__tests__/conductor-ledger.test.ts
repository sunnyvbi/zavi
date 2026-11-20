import { describe, it, expect, vi } from "vitest";
import {
  isLoggableTick,
  mapTickToLedger,
  appendConductorAction,
} from "@/services/agents/conductor-ledger";
import type { ConductorTickResult } from "@/services/agents/conductor";

describe("conductor-ledger mapTickToLedger", () => {
  it("dispatched → carries node_id + child_run_id, no outcome", () => {
    const r: ConductorTickResult = { action: "dispatched", node_id: "n1", child_run_id: "c1" };
    expect(mapTickToLedger(r)).toEqual({
      action: "dispatched", node_id: "n1", child_run_id: "c1", outcome: null, error: null,
    });
  });

  it("dispatch_failed → outcome=failed + error carries the reason", () => {
    const r: ConductorTickResult = { action: "dispatch_failed", node_id: "n2", reason: "deduped" };
    expect(mapTickToLedger(r)).toEqual({
      action: "dispatch_failed", node_id: "n2", child_run_id: null, outcome: "failed", error: "deduped",
    });
  });

  it("completed → outcome mirrors final", () => {
    expect(mapTickToLedger({ action: "completed", final: "done" }).outcome).toBe("done");
    expect(mapTickToLedger({ action: "completed", final: "failed" }).outcome).toBe("failed");
  });

  it("halted → outcome=halted", () => {
    expect(mapTickToLedger({ action: "halted" }).outcome).toBe("halted");
  });

  it("repair_dispatched → folds to action='dispatched', outcome carries the attempt", () => {
    const r: ConductorTickResult = {
      action: "repair_dispatched",
      node_id: "qa",
      child_run_id: "repair-1",
      attempt: 2,
    };
    expect(mapTickToLedger(r)).toEqual({
      action: "dispatched",
      node_id: "qa",
      child_run_id: "repair-1",
      outcome: "repair_attempt_2",
      error: null,
    });
  });

  it("completed_after_repair_exhausted → folds to action='completed', outcome='failed', error carries root-cause", () => {
    const r: ConductorTickResult = {
      action: "completed_after_repair_exhausted",
      node_id: "build",
      root_cause: "TypeError x",
      attempts: 3,
    };
    const m = mapTickToLedger(r);
    expect(m.action).toBe("completed");
    expect(m.outcome).toBe("failed");
    expect(m.error).toContain("repair_exhausted_after_3");
    expect(m.error).toContain("TypeError x");
  });
});

describe("conductor-ledger isLoggableTick", () => {
  it("skips steady-state noise (noop, waiting)", () => {
    expect(isLoggableTick({ action: "noop", reason: "missing" })).toBe(false);
    expect(isLoggableTick({ action: "waiting", in_flight: 2 })).toBe(false);
  });
  it("logs real transitions", () => {
    expect(isLoggableTick({ action: "dispatched", node_id: "n", child_run_id: "c" })).toBe(true);
    expect(isLoggableTick({ action: "halted" })).toBe(true);
    expect(isLoggableTick({ action: "completed", final: "done" })).toBe(true);
  });
});

describe("conductor-ledger appendConductorAction", () => {
  it("no-ops (no RPC) for steady-state results", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await appendConductorAction({ rpc }, "t1", "k1", { action: "waiting", in_flight: 1 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls append_autopilot_action with mapped fields for a real transition", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await appendConductorAction({ rpc }, "t1", "k1", { action: "dispatched", node_id: "n1", child_run_id: "c1" });
    expect(rpc).toHaveBeenCalledWith("append_autopilot_action", expect.objectContaining({
      p_tenant_id: "t1", p_conductor_run_id: "k1", p_node_id: "n1",
      p_action: "dispatched", p_child_run_id: "c1", p_spend_delta: 0,
    }));
  });

  it("never throws when the RPC errors (audit must not break the sweep)", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: "boom" } });
    await expect(
      appendConductorAction({ rpc }, "t1", "k1", { action: "halted" }),
    ).resolves.toBeUndefined();
  });
});

describe("a paused Build is not recorded as a failure (checkpoint model)", () => {
  it("completed → paused", () => {
    expect(mapTickToLedger({ action: "completed", final: "paused" }).outcome).toBe("paused");
  });
  it("repair exhausted / provider capacity on a paused Build", () => {
    expect(
      mapTickToLedger({ action: "completed_after_repair_exhausted", node_id: "qa", root_cause: "x", attempts: 3, paused: true }).outcome,
    ).toBe("paused");
    expect(
      mapTickToLedger({ action: "completed_provider_capacity", node_id: "qa", root_cause: "x", attempts: 0, paused: true }).outcome,
    ).toBe("paused");
    expect(
      mapTickToLedger({ action: "completed_after_repair_exhausted", node_id: "qa", root_cause: "x", attempts: 3 }).outcome,
    ).toBe("failed");
  });
});
