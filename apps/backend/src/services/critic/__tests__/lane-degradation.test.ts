
import { describe, it, expect } from "vitest";
import { laneFailureReason } from "../reasoning-critic";
import { pmCriticFindingSchema, pmCriticResultSchema } from "@/agents/pm/critic";

describe("laneFailureReason — sanitized, fixed vocabulary", () => {
  it("classifies the failure modes that actually occur", () => {
    expect(laneFailureReason("schema_invalid: Invalid enum value at findings.0.kind")).toBe(
      "schema_invalid",
    );
    expect(laneFailureReason("malformed_json")).toBe("malformed_json");
    expect(laneFailureReason("anthropic_error: The operation was aborted")).toBe("timeout");
    expect(laneFailureReason("openai_error: 429 rate limit exceeded")).toBe("rate_limited");
    expect(laneFailureReason("anthropic_error: 529 overloaded_error")).toBe("overloaded");
    expect(laneFailureReason("openai_error: 401 invalid api key")).toBe("auth");
    expect(laneFailureReason("lane_threw: TypeError x")).toBe("lane_threw");
    expect(laneFailureReason("something we have not seen")).toBe("provider_error");
    expect(laneFailureReason(undefined)).toBe("unknown");
    expect(laneFailureReason("")).toBe("unknown");
  });

  it("NEVER leaks raw error text — every output is from the fixed vocabulary", () => {
    const VOCAB = new Set([
      "malformed_json",
      "schema_invalid",
      "timeout",
      "rate_limited",
      "overloaded",
      "auth",
      "lane_threw",
      "provider_error",
      "unknown",
    ]);
    const hostile = [
      "schema_invalid: draft said SECRET_CUSTOMER_NAME should be redacted",
      "anthropic_error: prompt contained 'user password is hunter2'",
      "openai_error: <untrusted_pm_draft> leaked </untrusted_pm_draft>",
    ];
    for (const h of hostile) {
      const r = laneFailureReason(h);
      expect(VOCAB.has(r)).toBe(true);
      expect(r).not.toContain("SECRET");
      expect(r).not.toContain("hunter2");
      expect(r).not.toContain("untrusted");
    }
  });
});

describe("pm critic schema — document findings are now expressible", () => {
  it("accepts ungrounded_system_claim (the document-mode kind)", () => {
    const finding = {
      kind: "ungrounded_system_claim",
      target: "the two programs deliberately share no infrastructure at v1",
      problem: "Asserts the two products are independent with nothing cited.",
      fix: "Cite the file that establishes it, mark it unverified, or remove it.",
    };
    expect(pmCriticFindingSchema.safeParse(finding).success).toBe(true);
  });

  it("THE BUG: before this kind existed, a document finding had no valid kind", () => {
    const invented = {
      kind: "ungrounded_architecture_claim",
      target: "x",
      problem: "y",
      fix: "z",
    };
    const r = pmCriticFindingSchema.safeParse(invented);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(laneFailureReason(`schema_invalid: ${r.error.message}`)).toBe("schema_invalid");
    }
  });

  it("a full document-mode critic result round-trips", () => {
    const result = {
      verdict: "revise",
      reversal_triggers_present: false,
      findings: [
        {
          kind: "ungrounded_system_claim",
          target: "billing lives in the upcar-private repo",
          problem: "No file cited; the run never read that repo.",
          fix: "Verify against the repo or state it as unverified.",
        },
      ],
    };
    expect(pmCriticResultSchema.safeParse(result).success).toBe(true);
  });

  it("does not break the pre-existing backlog kinds", () => {
    for (const kind of [
      "empty_structured_field",
      "prose_not_structured",
      "ungrounded_item",
      "flashy_misprioritized",
      "missing_tradeoff_side",
      "override_unjustified",
      "unmeasurable_criterion",
    ]) {
      expect(
        pmCriticFindingSchema.safeParse({ kind, target: "t", problem: "p", fix: "f" }).success,
      ).toBe(true);
    }
  });
});
