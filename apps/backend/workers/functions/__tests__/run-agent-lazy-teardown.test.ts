import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../run-agent.ts"), "utf8");

describe("run-agent lazy-sandbox teardown adoption (FIX #1)", () => {
  it("adopts the lazily-provisioned handle UNCONDITIONALLY when sandbox is null", () => {
    expect(SRC).toMatch(
      /if \(!sandbox\) \{\s*try \{\s*const adopted = takeLazyProvisionedSandbox\(run_id\)/,
    );
  });

  it("does NOT gate the adoption on the worker's local lazySandboxEligible flag", () => {
    expect(SRC).not.toMatch(/if \(!sandbox && lazySandboxEligible\)/);
  });

  it("the adopted handle flows into the existing teardown (wipe secrets + pause)", () => {
    expect(SRC).toMatch(/const adopted = takeLazyProvisionedSandbox\(run_id\);[\s\S]*?sandbox = adopted\.handle;/);
  });
});
