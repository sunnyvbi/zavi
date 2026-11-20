import { describe, it, expect, afterEach } from "vitest";
import { pickSandboxTemplate, xlTreeThresholdKb } from "../sandbox-tier";

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
});

describe("pickSandboxTemplate — tier selection", () => {
  it("INERT when E2B_XL_TEMPLATE unset → null regardless of size (no behavior change)", () => {
    delete process.env.E2B_XL_TEMPLATE;
    expect(pickSandboxTemplate(9_999_999)).toBeNull();
    expect(pickSandboxTemplate(null)).toBeNull();
    expect(pickSandboxTemplate(undefined)).toBeNull();
  });

  it("with xl template set: over-threshold → xl template", () => {
    process.env.E2B_XL_TEMPLATE = "praxis-xl";
    expect(pickSandboxTemplate(2_500_000)).toBe("praxis-xl");
  });

  it("with xl template set: at/under threshold OR unmeasured → null (default tier)", () => {
    process.env.E2B_XL_TEMPLATE = "praxis-xl";
    expect(pickSandboxTemplate(2_000_000)).toBeNull();
    expect(pickSandboxTemplate(500_000)).toBeNull();
    expect(pickSandboxTemplate(null)).toBeNull();
    expect(pickSandboxTemplate(undefined)).toBeNull();
  });

  it("threshold is env-tunable via E2B_XL_TREE_THRESHOLD_KB", () => {
    process.env.E2B_XL_TEMPLATE = "praxis-xl";
    process.env.E2B_XL_TREE_THRESHOLD_KB = "5000000";
    expect(xlTreeThresholdKb()).toBe(5_000_000);
    expect(pickSandboxTemplate(2_500_000)).toBeNull();
    expect(pickSandboxTemplate(6_000_000)).toBe("praxis-xl");
  });

  it("bad threshold env falls back to the 2GB default", () => {
    process.env.E2B_XL_TEMPLATE = "praxis-xl";
    process.env.E2B_XL_TREE_THRESHOLD_KB = "not-a-number";
    expect(xlTreeThresholdKb()).toBe(2_000_000);
    expect(pickSandboxTemplate(2_500_000)).toBe("praxis-xl");
  });
});
