import { describe, it, expect } from "vitest";
import {
  validateDecisionEvidenceInBody,
  DecisionEvidenceError,
  type DecisionEvidence,
} from "../decision-evidence";

const good: DecisionEvidence = {
  reason_text: "Refund trip 123 — guest reported a no-show",
  evidence: ["booking 123 status=no_show", "host confirmed in chat"],
  alternatives_considered: ["partial refund", "no refund + warning"],
  reversibility: "reversible_with_cost",
  blast_radius: "YELLOW",
  confidence: 0.82,
};

describe("validateDecisionEvidenceInBody", () => {
  it("passes a present + well-formed envelope", () => {
    expect(() =>
      validateDecisionEvidenceInBody({ decision_evidence: good }, { decision_class: "x" }),
    ).not.toThrow();
  });

  it("THROWS on a present but malformed envelope", () => {
    const bad = { ...good, blast_radius: "PURPLE", confidence: 1.5 };
    expect(() =>
      validateDecisionEvidenceInBody({ decision_evidence: bad }, { decision_class: "x" }),
    ).toThrow(DecisionEvidenceError);
    expect(() =>
      validateDecisionEvidenceInBody({ decision_evidence: { evidence: [] } }, { decision_class: "x" }),
    ).toThrow(DecisionEvidenceError);
  });

  it("is a NO-OP when evidence is absent (evidence is optional, never enforced)", () => {
    expect(() =>
      validateDecisionEvidenceInBody({ some: "body" }, { decision_class: "stripe.refund" }),
    ).not.toThrow();
  });

  it("tolerates a non-object body (null/array/scalar — malformed row)", () => {
    for (const b of [null, undefined, 42, "s", ["a"]]) {
      expect(() => validateDecisionEvidenceInBody(b, { decision_class: "x" })).not.toThrow();
    }
  });
});
