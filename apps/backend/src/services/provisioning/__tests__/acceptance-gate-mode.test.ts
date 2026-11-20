
import { describe, it, expect, afterEach } from "vitest";
import { resolveAcceptanceGateMode } from "../acceptance-gate-driver";
import {
  isAcceptanceGateEnabled,
  resolveAcceptanceRepairMaxAttempts,
} from "@/services/agents/conductor-driver";

const ORIG_MODE = process.env.BUILD_ACCEPTANCE_GATE_MODE;
const ORIG_CAP = process.env.BUILD_ACCEPTANCE_REPAIR_MAX_ATTEMPTS;

afterEach(() => {
  if (ORIG_MODE === undefined) delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
  else process.env.BUILD_ACCEPTANCE_GATE_MODE = ORIG_MODE;
  if (ORIG_CAP === undefined) delete process.env.BUILD_ACCEPTANCE_REPAIR_MAX_ATTEMPTS;
  else process.env.BUILD_ACCEPTANCE_REPAIR_MAX_ATTEMPTS = ORIG_CAP;
});

describe("resolveAcceptanceGateMode", () => {
  it("defaults to 'off' when unset (SAFE-INERT)", () => {
    delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
    expect(resolveAcceptanceGateMode()).toBe("off");
    expect(isAcceptanceGateEnabled()).toBe(false);
  });

  it("recognizes shadow + enforce (case/space tolerant)", () => {
    process.env.BUILD_ACCEPTANCE_GATE_MODE = " Shadow ";
    expect(resolveAcceptanceGateMode()).toBe("shadow");
    expect(isAcceptanceGateEnabled()).toBe(true);
    process.env.BUILD_ACCEPTANCE_GATE_MODE = "ENFORCE";
    expect(resolveAcceptanceGateMode()).toBe("enforce");
    expect(isAcceptanceGateEnabled()).toBe(true);
  });

  it("treats any garbage value as 'off' (a typo never enforces)", () => {
    process.env.BUILD_ACCEPTANCE_GATE_MODE = "on";
    expect(resolveAcceptanceGateMode()).toBe("off");
    expect(isAcceptanceGateEnabled()).toBe(false);
  });
});

describe("resolveAcceptanceRepairMaxAttempts", () => {
  it("defaults to 2 and clamps to [1,5]", () => {
    delete process.env.BUILD_ACCEPTANCE_REPAIR_MAX_ATTEMPTS;
    expect(resolveAcceptanceRepairMaxAttempts()).toBe(2);
    process.env.BUILD_ACCEPTANCE_REPAIR_MAX_ATTEMPTS = "0";
    expect(resolveAcceptanceRepairMaxAttempts()).toBe(2);
    process.env.BUILD_ACCEPTANCE_REPAIR_MAX_ATTEMPTS = "9";
    expect(resolveAcceptanceRepairMaxAttempts()).toBe(5);
    process.env.BUILD_ACCEPTANCE_REPAIR_MAX_ATTEMPTS = "3";
    expect(resolveAcceptanceRepairMaxAttempts()).toBe(3);
  });
});
