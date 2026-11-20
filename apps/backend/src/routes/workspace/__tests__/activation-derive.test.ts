
import { describe, it, expect } from "vitest";
import { deriveActivationState, type ActivationSignals } from "../activation";

const base: ActivationSignals = {
  brain_seeded: true,
  connectors_count: 1,
  agents_run_count: 1,
  first_approval_acted: true,
};

describe("deriveActivationState", () => {
  it("brain not seeded → seed_brain is the next action (highest priority)", () => {
    const out = deriveActivationState({
      ...base,
      brain_seeded: false,
      connectors_count: 0,
      agents_run_count: 0,
      first_approval_acted: false,
    });
    expect(out.next_best_action.key).toBe("seed_brain");
    expect(out.next_best_action.href).toBe("/workspace?tab=brain");
    expect(out.activated).toBe(false);
  });

  it("brain seeded but no connectors → connect", () => {
    const out = deriveActivationState({
      brain_seeded: true,
      connectors_count: 0,
      agents_run_count: 0,
      first_approval_acted: false,
    });
    expect(out.next_best_action.key).toBe("connect");
    expect(out.next_best_action.href).toBe("/workspace?tab=settings");
    expect(out.activated).toBe(false);
  });

  it("brain + connectors but no run → run_agent", () => {
    const out = deriveActivationState({
      brain_seeded: true,
      connectors_count: 2,
      agents_run_count: 0,
      first_approval_acted: false,
    });
    expect(out.next_best_action.key).toBe("run_agent");
    expect(out.next_best_action.href).toBe("/workspace?agent=engineer");
    expect(out.activated).toBe(false);
  });

  it("ran an agent but no approval acted → review_approval (not yet activated)", () => {
    const out = deriveActivationState({
      brain_seeded: true,
      connectors_count: 2,
      agents_run_count: 3,
      first_approval_acted: false,
    });
    expect(out.next_best_action.key).toBe("review_approval");
    expect(out.next_best_action.href).toBe("/workspace?tab=channels");
    expect(out.activated).toBe(false);
  });

  it("ran an agent AND acted on an approval → activated, rail hides", () => {
    const out = deriveActivationState(base);
    expect(out.activated).toBe(true);
    expect(out.next_best_action.key).toBe("explore");
  });

  it("acted on an approval but never ran an agent → NOT activated (both required)", () => {
    const out = deriveActivationState({
      brain_seeded: true,
      connectors_count: 1,
      agents_run_count: 0,
      first_approval_acted: true,
    });
    expect(out.activated).toBe(false);
    expect(out.next_best_action.key).toBe("run_agent");
  });

  it("passes through the raw signals untouched", () => {
    const out = deriveActivationState({
      brain_seeded: true,
      connectors_count: 5,
      agents_run_count: 9,
      first_approval_acted: true,
    });
    expect(out.brain_seeded).toBe(true);
    expect(out.connectors_count).toBe(5);
    expect(out.agents_run_count).toBe(9);
    expect(out.first_approval_acted).toBe(true);
  });
});
