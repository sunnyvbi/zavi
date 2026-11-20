import { describe, it, expect } from "vitest";
import { computeAgentHealth, type HealthInput } from "../agent-health";

function base(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    inactive: false,
    missingRequiredConnectors: [],
    latestTerminalStatus: "success",
    hadSuccessInWindow: true,
    staffDown: 0,
    operatorDownCount: 0,
    operatorUpCount: 0,
    operatorDownDistinctUsers: 0,
    ...overrides,
  };
}

describe("computeAgentHealth", () => {
  it("RED — missing required connector (hard blocker)", () => {
    const r = computeAgentHealth(base({ missingRequiredConnectors: ["meta_ads"] }));
    expect(r.badge).toBe("red");
    expect(r.reason).toBe("missing_required_connectors");
    expect(r.detail).toContain("meta_ads");
  });

  it("RED — last run failed AND no success in window", () => {
    const r = computeAgentHealth(base({ latestTerminalStatus: "failed", hadSuccessInWindow: false }));
    expect(r.badge).toBe("red");
    expect(r.reason).toBe("run_failed_no_recent_success");
  });

  it("GREEN — connectors ok + success in window + healthy", () => {
    expect(computeAgentHealth(base()).badge).toBe("green");
  });

  it("inactive — hidden/kill-switched agent is never scored unhealthy", () => {
    const r = computeAgentHealth(base({ inactive: true, missingRequiredConnectors: ["github"] }));
    expect(r.badge).toBe("inactive");
  });

  it("no false-RED — single user's thumbs-down does NOT go red (poison guard)", () => {
    const r = computeAgentHealth(base({ operatorDownCount: 5, operatorDownDistinctUsers: 1, operatorUpCount: 0 }));
    expect(r.badge).not.toBe("red");
    expect(r.badge).toBe("yellow");
    expect(r.reason).toBe("negative_feedback_needs_review");
  });

  it("RED — >=3 down from >=2 distinct users AND net-negative", () => {
    const r = computeAgentHealth(base({ operatorDownCount: 3, operatorDownDistinctUsers: 2, operatorUpCount: 0 }));
    expect(r.badge).toBe("red");
    expect(r.reason).toBe("customer_down_cluster");
  });

  it("no false-RED — cluster from 2 users but net-positive stays out of red", () => {
    const r = computeAgentHealth(base({ operatorDownCount: 3, operatorDownDistinctUsers: 2, operatorUpCount: 10 }));
    expect(r.badge).not.toBe("red");
  });

  it("RED — staff flagged (>=2 staff thumbs-down) regardless of distinct users", () => {
    const r = computeAgentHealth(base({ staffDown: 2 }));
    expect(r.badge).toBe("red");
    expect(r.reason).toBe("staff_flagged");
  });

  it("no false-YELLOW — connector-less agent that legitimately ran succeeds is GREEN", () => {
    expect(computeAgentHealth(base()).badge).toBe("green");
  });

  it("no_signal — brand-new agent that never ran is neutral YELLOW, not degraded", () => {
    const r = computeAgentHealth(base({ latestTerminalStatus: null, hadSuccessInWindow: false }));
    expect(r.badge).toBe("yellow");
    expect(r.reason).toBe("no_signal");
  });

  it("stale — had connectors but no success in 30d window (low-frequency idle)", () => {
    const r = computeAgentHealth(base({ latestTerminalStatus: "success", hadSuccessInWindow: false }));
    expect(r.badge).toBe("yellow");
    expect(r.reason).toBe("stale");
  });

  it("GREEN survives a low single thumbs-down when net-positive feedback", () => {
    const r = computeAgentHealth(base({ operatorDownCount: 1, operatorUpCount: 5, operatorDownDistinctUsers: 1 }));
    expect(r.badge).toBe("green");
  });

  it("downCluster option is honored (threshold of 2)", () => {
    const r = computeAgentHealth(
      base({ operatorDownCount: 2, operatorDownDistinctUsers: 2, operatorUpCount: 0 }),
      { downCluster: 2 },
    );
    expect(r.badge).toBe("red");
  });
});
