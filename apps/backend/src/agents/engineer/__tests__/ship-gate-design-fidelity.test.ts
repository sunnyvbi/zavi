import { describe, it, expect } from "vitest";
import { evaluateCtoShipGate, shipBlockExplanation } from "../ship-gate";

const baseEnv = {
  risk_class: "moderate",
  test_results: { passed: 3, failed: 0 },
  app_verify_result: { path: "/book", status: 200 },
};

describe("ship gate — design_fidelity", () => {
  it("BLOCKS when the build substituted an unblessed native control", () => {
    const r = evaluateCtoShipGate({ ...baseEnv, design_fidelity_substituted: ['input type="datetime-local"'] });
    expect(r.shippable).toBe(false);
    if (!r.shippable) expect(r.reason).toBe("design_fidelity");
  });

  it("does NOT block when no substitution was detected", () => {
    expect(evaluateCtoShipGate({ ...baseEnv, design_fidelity_substituted: [] }).shippable).toBe(true);
  });

  it("does NOT block a build with no approved mock bound to it (field absent)", () => {
    expect(evaluateCtoShipGate(baseEnv).shippable).toBe(true);
  });

  it("ignores a non-array stamp rather than throwing", () => {
    expect(
      evaluateCtoShipGate({ ...baseEnv, design_fidelity_substituted: "datetime-local" })
        .shippable,
    ).toBe(true);
  });

  it("explains the block in the operator's terms, owning the mistake", () => {
    const msg = shipBlockExplanation("design_fidelity");
    expect(msg).toMatch(/approved/i);
    expect(msg).toMatch(/native|default/i);
    expect(msg.length).toBeGreaterThan(40);
  });
});
