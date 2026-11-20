
import { describe, it, expect } from "vitest";
import { getAgentShapeConstraints } from "@/services/agents/registry";

describe("supply-demand-balancer agent.md shape constraints", () => {
  it("declares recommended_for_shapes: [marketplace]", () => {
    const c = getAgentShapeConstraints("supply-demand-balancer");
    expect(c).toEqual({ recommended_for_shapes: ["marketplace"] });
  });

  it("a general agent declares NO shape constraints (null)", () => {
    expect(getAgentShapeConstraints("chief-of-staff")).toBeNull();
  });

  it("unknown slug → null", () => {
    expect(getAgentShapeConstraints("does-not-exist")).toBeNull();
  });
});
