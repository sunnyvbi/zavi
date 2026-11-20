import { describe, it, expect } from "vitest";
import { buildShipPrEvidence } from "../ship-pr-evidence";
import { decisionEvidenceSchema } from "@/services/agents/decision-evidence";

describe("buildShipPrEvidence — system-derived evidence from the engineer envelope", () => {
  it("always returns a schema-valid envelope (even for an empty body)", () => {
    const ev = buildShipPrEvidence({});
    expect(() => decisionEvidenceSchema.parse(ev)).not.toThrow();
    expect(ev.alternatives_considered).toEqual([]);
    expect(ev.reason_text.length).toBeGreaterThan(0);
  });

  it("maps risk_class → blast_radius (trivial=GREEN, low=YELLOW, medium=ORANGE)", () => {
    expect(buildShipPrEvidence({ risk_class: "trivial" }).blast_radius).toBe("GREEN");
    expect(buildShipPrEvidence({ risk_class: "low" }).blast_radius).toBe("YELLOW");
    expect(buildShipPrEvidence({ risk_class: "medium" }).blast_radius).toBe("ORANGE");
    expect(buildShipPrEvidence({}).blast_radius).toBe("YELLOW");
  });

  it("derives confidence from the deterministic test receipt", () => {
    expect(buildShipPrEvidence({ verify: { status: "passed" } }).confidence).toBe(0.8);
    expect(
      buildShipPrEvidence({ verify: { status: "failed" }, approval_class: "ship_red" }).confidence,
    ).toBe(0.3);
    expect(buildShipPrEvidence({ verify: { status: "failed" } }).confidence).toBe(0.5);
    expect(buildShipPrEvidence({ verify: { status: "couldnt_run" } }).confidence).toBe(0.5);
    expect(buildShipPrEvidence({ verify: { status: "not_run" } }).confidence).toBe(0.5);
    expect(buildShipPrEvidence({}).confidence).toBe(0.5);
  });

  it("builds reason_text from title + summary and surfaces real file/verify/risk facts", () => {
    const ev = buildShipPrEvidence({
      title: "Fix null deref in payout",
      rendered_markdown: "Guards the payout amount lookup.",
      files: [{ path: "a.ts" }, { path: "b.ts" }],
      test_results: { passed: 12, failed: 0 },
      verify: { status: "passed" },
      risk_class: "low",
    });
    expect(ev.reason_text).toContain("Fix null deref in payout");
    expect(ev.reason_text).toContain("Guards the payout amount lookup.");
    expect(ev.evidence).toContain("2 file(s) changed");
    expect(ev.evidence).toContain("tests: passed (sandbox)");
    expect(ev.evidence).not.toContain("12 passed / 0 failed");
    expect(ev.evidence).toContain("risk_class: low");
    expect(ev.reversibility).toBe("reversible_with_cost");
  });

  it("Slice 1 P2 — model test_results NEVER reaches evidence; verify receipt drives the test line", () => {
    const ev = buildShipPrEvidence({
      title: "x",
      test_results: { passed: 99, failed: 0 },
      verify: { status: "couldnt_run", reason: "mongodb-memory-server download failed" },
    });
    expect(ev.evidence.some((e) => e.includes("couldn't run in sandbox"))).toBe(true);
    expect(ev.evidence.some((e) => e.includes("99"))).toBe(false);
    const ev2 = buildShipPrEvidence({ title: "y", test_results: { passed: 5, failed: 0 } });
    expect(ev2.evidence).toContain("tests: not run in sandbox");
  });

  it("a legacy critic verdict on the envelope adds no evidence line and no confidence change", () => {
    const ev = buildShipPrEvidence({
      title: "x",
      critic: { status: "ok", verdict: "fail", top_severity: "P1" },
      critic_unverified: true,
    });
    expect(ev.evidence.some((e) => e.startsWith("critic"))).toBe(false);
    expect(ev.confidence).toBe(0.5);
  });
});
