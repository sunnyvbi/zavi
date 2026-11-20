import { describe, it, expect } from "vitest";
import { shouldHonestLabel } from "../honest-liveness-label";
import { selectReplyTextFromRow } from "../terminal-reply-text";

describe("shouldHonestLabel", () => {
  it("flag OFF → never labels, for any tier", () => {
    for (const tier of ["shipped", "answered", "plan_only", "empty"] as const) {
      expect(
        shouldHonestLabel({ enabled: false, agentSlug: "growth-lead", tier, isError: false }),
      ).toBe(false);
    }
  });

  it("flag ON + plan_only/empty → labels; shipped/answered → does not", () => {
    const base = { enabled: true, agentSlug: "growth-lead", isError: false } as const;
    expect(shouldHonestLabel({ ...base, tier: "plan_only" })).toBe(true);
    expect(shouldHonestLabel({ ...base, tier: "empty" })).toBe(true);
    expect(shouldHonestLabel({ ...base, tier: "shipped" })).toBe(false);
    expect(shouldHonestLabel({ ...base, tier: "answered" })).toBe(false);
  });

  it("engineer is excluded even on plan_only/empty (its own verifier owns it)", () => {
    expect(
      shouldHonestLabel({ enabled: true, agentSlug: "engineer", tier: "empty", isError: false }),
    ).toBe(false);
    expect(
      shouldHonestLabel({ enabled: true, agentSlug: "engineer", tier: "plan_only", isError: false }),
    ).toBe(false);
  });

  it("a genuine-failure bubble (isError) is never labeled", () => {
    expect(
      shouldHonestLabel({ enabled: true, agentSlug: "growth-lead", tier: "empty", isError: true }),
    ).toBe(false);
  });

  it("null/undefined tier → not labeled", () => {
    expect(
      shouldHonestLabel({ enabled: true, agentSlug: "growth-lead", tier: null, isError: false }),
    ).toBe(false);
    expect(
      shouldHonestLabel({ enabled: true, agentSlug: "growth-lead", tier: undefined, isError: false }),
    ).toBe(false);
  });
});

const row = (over: Record<string, unknown>) => ({
  status: "success",
  output_text: null,
  error: null,
  parse_error: null,
  agent_slug: "growth-lead",
  outcome: null,
  ...over,
});

describe("selectReplyTextFromRow — Move 5 honest label", () => {
  const planOnlyRow = row({
    output_text: "Referral program plan: 1) ... 2) ...",
    outcome: { deliverable: "Referral program plan: 1) ... 2) ...", liveness_tier: "plan_only" },
  });
  const emptyRow = row({ output_text: "", outcome: { deliverable: null, liveness_tier: "empty" } });
  const shippedRow = row({
    output_text: "Launched the referral program.",
    outcome: { deliverable: "Launched the referral program.", liveness_tier: "shipped" },
  });

  it("plan_only / empty / shipped → the reply as written, never a heads-up banner", () => {
    expect(selectReplyTextFromRow(planOnlyRow).markdown).toBe("Referral program plan: 1) ... 2) ...");
    expect(selectReplyTextFromRow(emptyRow).markdown).toBe("Done - no output.");
    expect(selectReplyTextFromRow(shippedRow).markdown).toBe("Launched the referral program.");
    for (const r of [planOnlyRow, emptyRow, shippedRow]) {
      expect(selectReplyTextFromRow(r).markdown).not.toMatch(/Heads up|no action taken yet/);
      expect(selectReplyTextFromRow(r).isError).toBe(false);
    }
  });
});
