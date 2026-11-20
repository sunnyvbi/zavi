
import { describe, it, expect } from "vitest";
import { GOVERNANCE_GOLDENS } from "../goldens";
import { scoreGovernance } from "../runner";

describe("governance goldens — deterministic pure-policy gate (no LLM)", () => {
  const report = scoreGovernance(GOVERNANCE_GOLDENS);

  it("every golden decides as expected (100% deterministic accuracy)", () => {
    const failures = report.cases
      .filter((c) => !c.pass)
      .map((c) => `  ✗ [${c.kind}] ${c.name}: ${c.reason}`)
      .join("\n");
    expect(failures, `governance golden failures:\n${failures}`).toBe("");
    expect(report.accuracy).toBe(1);
    expect(report.passed).toBe(report.total);
  });

  it("no seeded incident golden regressed", () => {
    expect(
      report.incidentFailures.map((c) => `${c.name}: ${c.reason}`).join("\n"),
    ).toBe("");
  });

  it("both invariants + every seeded incident are actually present", () => {
    const kinds = new Set(GOVERNANCE_GOLDENS.map((g) => g.kind));
    expect(kinds.has("tenant_ownership")).toBe(true);
    expect(kinds.has("operator_tool")).toBe(true);
    expect(kinds.has("credits_enforced")).toBe(true);

    const incidents = new Set(
      GOVERNANCE_GOLDENS.map((g) => g.incident).filter(Boolean),
    );
    expect(incidents.has("cross_tenant_reach")).toBe(true);
    expect(incidents.has("budget_runaway")).toBe(true);
    expect(incidents.has("untrusted_inbound_exfil")).toBe(true);
  });

  it("at least one REFUSE case exists per invariant (the deny is asserted, not just the allow)", () => {
    const denies = GOVERNANCE_GOLDENS.filter((g) => {
      if (g.kind === "tenant_ownership") return g.expect.allow === false;
      if (g.kind === "operator_tool") return g.expect.allow === false;
      return false;
    });
    const denyKinds = new Set(denies.map((g) => g.kind));
    expect(denyKinds.has("tenant_ownership")).toBe(true);
    expect(denyKinds.has("operator_tool")).toBe(true);
  });
});
