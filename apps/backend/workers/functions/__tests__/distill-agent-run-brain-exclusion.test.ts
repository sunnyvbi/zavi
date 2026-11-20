import { describe, it, expect } from "vitest";
import { isExcludedFromCompanyBrain } from "../distill-agent-run";

describe("isExcludedFromCompanyBrain", () => {
  it("keeps channel recipe runs out of company memory", () => {
    expect(isExcludedFromCompanyBrain({ trigger: "channel_recipe", payload: {} })).toBe(true);
  });

  it("keeps speculative onboarding research out, as before", () => {
    expect(
      isExcludedFromCompanyBrain({ trigger: "manual", payload: { source: "slack_onboarding_research" } }),
    ).toBe(true);
  });

  it("still distills ordinary scheduled and manual runs", () => {
    expect(isExcludedFromCompanyBrain({ trigger: "cron", payload: null })).toBe(false);
    expect(isExcludedFromCompanyBrain({ trigger: "manual", payload: { source: "ui" } })).toBe(false);
  });
});
