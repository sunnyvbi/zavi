import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), serviceClient: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClient }));

import { consumeClassBudget, decisionClassForStage } from "../class-cap";

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.serviceClient.mockReset();
  mocks.serviceClient.mockReturnValue({ rpc: mocks.rpc });
});

describe("decisionClassForStage", () => {
  it("maps provision → provision.repo", () => {
    expect(decisionClassForStage("provision")).toBe("provision.repo");
  });
  it("maps spec/scaffold/build/qa → the stage slug itself", () => {
    expect(decisionClassForStage("spec")).toBe("spec");
    expect(decisionClassForStage("scaffold")).toBe("scaffold");
    expect(decisionClassForStage("build")).toBe("build");
    expect(decisionClassForStage("qa")).toBe("qa");
  });
  it("returns null for deploy / unknown / empty / nullish (no per-class cap)", () => {
    expect(decisionClassForStage("deploy")).toBeNull();
    expect(decisionClassForStage("something-else")).toBeNull();
    expect(decisionClassForStage("")).toBeNull();
    expect(decisionClassForStage(null)).toBeNull();
    expect(decisionClassForStage(undefined)).toBeNull();
  });
});

describe("consumeClassBudget", () => {
  it("'charged' from the RPC → 'charged'; passes the (tenant, class, estimate) args", async () => {
    mocks.rpc.mockResolvedValue({ data: "charged", error: null });
    const v = await consumeClassBudget("t-1", "build", 3.5);
    expect(v).toBe("charged");
    expect(mocks.rpc).toHaveBeenCalledWith("consume_class_budget_or_reject", {
      p_tenant_id: "t-1",
      p_decision_class: "build",
      p_estimate_usd: 3.5,
    });
  });

  it("'over_cap' from the RPC → 'over_cap'", async () => {
    mocks.rpc.mockResolvedValue({ data: "over_cap", error: null });
    expect(await consumeClassBudget("t-1", "build", 99)).toBe("over_cap");
  });

  it("RPC error → 'read_error' (transient; NOT a halt-worthy breach)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "db blip" } });
    expect(await consumeClassBudget("t-1", "build", 1)).toBe("read_error");
  });

  it("RPC throw → 'read_error' (transient)", async () => {
    mocks.rpc.mockRejectedValue(new Error("network"));
    expect(await consumeClassBudget("t-1", "build", 1)).toBe("read_error");
  });

  it("FAIL-CLOSED: a genuine 'over_cap' from the RPC still → 'over_cap' (real breach halts)", async () => {
    mocks.rpc.mockResolvedValue({ data: "over_cap", error: null });
    expect(await consumeClassBudget("t-1", "build", 99)).toBe("over_cap");
  });

  it("FAIL-CLOSED: unexpected non-'charged' data (not an error) → 'over_cap', NOT read_error", async () => {
    mocks.rpc.mockResolvedValue({ data: "weird", error: null });
    expect(await consumeClassBudget("t-1", "build", 1)).toBe("over_cap");
  });
});
