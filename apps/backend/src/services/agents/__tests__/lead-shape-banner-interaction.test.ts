import { describe, it, expect } from "vitest";
import { verifyCapGrounding } from "../cap-grounding-verifier";
import { shapeReportLead } from "../report-lead-shaper";

describe("F0 grounding × F1 lead-shape interaction", () => {
  it("caveat stays below the lead; full digest (with caveat) preserved", () => {
    const digest = [
      "## Ads digest",
      "",
      "### Weekly summary",
      "Spend $1,190, 17 purchases, 2.21x ROAS. The one move: pause the IC-TEST ad set.",
      ...Array.from({ length: 40 }, (_, i) => `Detail line ${i} with more analysis about campaigns and ad sets and audiences and creative fatigue and frequency.`),
      "Standing policy: host campaigns have a $737/week hard cap.",
    ].join("\n");

    const grounded = verifyCapGrounding({ reply: digest, toolCalls: [] });
    expect(grounded.hedged).toBe(true);
    expect(grounded.text.startsWith("## Ads digest")).toBe(true);
    expect(grounded.text).toMatch(/Unverified cap\/policy/);

    const shaped = shapeReportLead({
      trigger: "slack",
      agentSlug: "performance-marketer",
      hasEnvelope: true,
      body: grounded.text,
    });
    expect(shaped.collapsed).toBe(true);
    expect(shaped.lead).not.toMatch(/Unverified cap\/policy/);
    expect(shaped.lead.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(120);
    expect(shaped.full).toMatch(/Unverified cap\/policy/);
  });

  it("real reply (no fabricated cap) → no caveat, lead is clean", () => {
    const clean = "## Report\n\n### Summary\n" + Array.from({ length: 30 }, (_, i) => `Line ${i} of substantive analysis content here for length.`).join("\n");
    const shaped = shapeReportLead({ trigger: "slack", agentSlug: "research", hasEnvelope: true, body: clean });
    expect(shaped.full).not.toMatch(/Unverified cap/);
    expect(shaped.lead).not.toMatch(/Unverified cap/);
  });
});
