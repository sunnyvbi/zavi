import { describe, it, expect } from "vitest";
import { trustTierFor } from "../trust-tier";

describe("trustTierFor", () => {
  it("mcp → 1 (authenticated tenant member via external client; recalibrated 3→1)", () => {
    expect(trustTierFor({ trigger: "mcp", agent_slug: "pm" })).toBe(1);
  });

  it("operator chat → 0 (operator-stated)", () => {
    expect(trustTierFor({ trigger: "chat", agent_slug: "operator" })).toBe(0);
  });

  it("mcp + cron + webhook → 1 (connector-observed)", () => {
    expect(trustTierFor({ trigger: "mcp", agent_slug: "x" })).toBe(1);
    expect(trustTierFor({ trigger: "cron", agent_slug: "performance-marketer" })).toBe(1);
    expect(trustTierFor({ trigger: "webhook", agent_slug: "anything" })).toBe(1);
  });

  it("manual / a2a / handoff → 2 (agent-inferred)", () => {
    expect(trustTierFor({ trigger: "manual", agent_slug: "x" })).toBe(2);
    expect(trustTierFor({ trigger: "a2a", agent_slug: "x" })).toBe(2);
    expect(trustTierFor({ trigger: "handoff", agent_slug: "x" })).toBe(2);
  });
});
