import { describe, it, expect, vi } from "vitest";

vi.mock("../agent-capabilities", () => ({
  agentCapabilities: (slug: string) => ({
    money_path: false,
    reads_operator_db:
      slug === "new-support-agent" || slug === "operator" || slug === "advisor",
    emits_artifact: false,
    structured_clarifications: false,
  }),
}));

import {
  isPiiScrubAgent,
  PII_SCRUB_AGENT_SLUGS,
  scrubAgentEgress,
} from "../scrub-agent-egress";

describe("#17 PII-scrub set is capability-derived (isPiiScrubAgent)", () => {
  it("(d) keeps every hardcoded PII-scrub member covered", () => {
    for (const slug of [
      "pm",
      "chief-of-staff",
      "support-lead",
      "dispute-response",
      "growth-lead",
      "performance-marketer",
    ]) {
      expect(PII_SCRUB_AGENT_SLUGS.has(slug)).toBe(true);
      expect(isPiiScrubAgent(slug)).toBe(true);
    }
  });

  it("(c) covers a NEW operator_db-reading agent not in the hardcoded set", () => {
    expect(PII_SCRUB_AGENT_SLUGS.has("new-support-agent")).toBe(false);
    expect(isPiiScrubAgent("new-support-agent")).toBe(true);
  });

  it("keeps the documented operator/advisor carve-out held out (even with the flag)", () => {
    expect(isPiiScrubAgent("operator")).toBe(false);
    expect(isPiiScrubAgent("advisor")).toBe(false);
  });

  it("does NOT scrub an agent without the flag", () => {
    expect(isPiiScrubAgent("engineer")).toBe(false);
  });

  it("(c) end-to-end: a flag-derived agent's emitted PII is actually redacted", () => {
    const text = "Reach the buyer at jane.doe@example.com or 415-555-0199.";
    const scrubbed = scrubAgentEgress(text, {
      surface: "chat",
      scrubPii: isPiiScrubAgent("new-support-agent"),
    });
    expect(scrubbed.text).not.toContain("jane.doe@example.com");
    expect(scrubbed.text).not.toContain("415-555-0199");
    expect(scrubbed.families).toContain("pii");
  });

  it("does NOT scrub PII for a non-covered agent (opt-out stays off)", () => {
    const text = "Reach the buyer at jane.doe@example.com.";
    const scrubbed = scrubAgentEgress(text, {
      surface: "chat",
      scrubPii: isPiiScrubAgent("engineer"),
    });
    expect(scrubbed.text).toContain("jane.doe@example.com");
  });
});
