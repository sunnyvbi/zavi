
import { describe, it, expect } from "vitest";
import {
  BILLABLE_BUILD_AGENT_SLUGS,
  PLAN_BUILD_ALLOWANCE,
  isBillableBuild,
  buildAllowanceFor,
  type Plan,
} from "@/services/agents/entitlement";

const PLANS: Plan[] = ["free", "solo", "team", "full", "enterprise"];

describe("billable-build detection (engineer-only, slug allowlist)", () => {
  it("engineer is the only billable build", () => {
    expect([...BILLABLE_BUILD_AGENT_SLUGS]).toEqual(["engineer"]);
    expect(isBillableBuild("engineer")).toBe(true);
  });
  it("qa is NOT a billable build (must not depend on requires_sandbox)", () => {
    expect(isBillableBuild("qa")).toBe(false);
  });
  it("cheap agents are not billable", () => {
    for (const s of ["operator", "pm", "growth-lead", "research", "advisor"]) {
      expect(isBillableBuild(s)).toBe(false);
    }
  });
});

describe("buildAllowanceFor", () => {
  it("maps each plan to its monthly allowance", () => {
    expect(buildAllowanceFor("free")).toBe(5);
    expect(buildAllowanceFor("solo")).toBe(50);
    expect(buildAllowanceFor("team")).toBe(250);
    expect(buildAllowanceFor("full")).toBe(1000);
    expect(PLAN_BUILD_ALLOWANCE.enterprise).toBeGreaterThan(100000);
  });
});

