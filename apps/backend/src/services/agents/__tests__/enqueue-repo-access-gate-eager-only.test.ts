import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../runner.ts"), "utf8");

describe("enqueue repo-access gate is EAGER-ONLY (wildcard default safety)", () => {
  it("derives an eager-only flag from resolveSandboxMode (requires_sandbox && !lazyEligible)", () => {
    expect(SRC).toMatch(
      /const enqueueEagerSandbox\s*=\s*\n?\s*enqueueSandboxMode\.requires_sandbox && !enqueueSandboxMode\.lazyEligible;/,
    );
  });

  it("gates checkSandboxRepoAccess on enqueueEagerSandbox, NOT the bare effective flag", () => {
    expect(SRC).toMatch(/if \(enqueueEagerSandbox\) \{\s*\n\s*const repoAccess = await checkSandboxRepoAccess\(/);
    expect(SRC).not.toMatch(
      /if \(agent\.metadata_praxis\.requires_sandbox\) \{\s*\n\s*const repoAccess = await checkSandboxRepoAccess\(/,
    );
  });
});
