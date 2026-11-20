
import { describe, it, expect } from "vitest";
import { shapeReportLead } from "../report-lead-shaper";

const LONG_BODY = [
  "Found it. This is real evidence, not a guess.",
  "The compiled dist bundle on main still contains the old code path.",
  ...Array.from(
    { length: 40 },
    (_, i) => `Supporting detail number ${i} explains another part of the failure in full.`,
  ),
].join(" ");

describe("shapeReportLead — surface gate", () => {
  it("does NOT collapse a long CHAT reply (the reported bug)", () => {
    const out = shapeReportLead({
      trigger: "chat",
      agentSlug: "engineer",
      hasEnvelope: true,
      body: LONG_BODY,
    });
    expect(out.collapsed).toBe(false);
    expect(out.lead).toBe(LONG_BODY);
    expect(out.full).toBe(LONG_BODY);
  });

  it("does NOT collapse a long CHAT reply from growth-lead either", () => {
    const out = shapeReportLead({
      trigger: "chat",
      agentSlug: "growth-lead",
      hasEnvelope: true,
      body: LONG_BODY,
    });
    expect(out.collapsed).toBe(false);
  });

  it("STILL collapses a long SLACK reply (slack has no clamp; it threads the overflow)", () => {
    const out = shapeReportLead({
      trigger: "slack",
      agentSlug: "engineer",
      hasEnvelope: true,
      body: LONG_BODY,
    });
    expect(out.collapsed).toBe(true);
    expect(out.full).toBe(LONG_BODY);
    expect(out.lead.length).toBeLessThan(LONG_BODY.length);
  });

  it("never collapses a short reply, on any surface", () => {
    const short = "Deploy is green.";
    for (const trigger of ["chat", "slack", "cron"]) {
      const out = shapeReportLead({ trigger, agentSlug: "engineer", hasEnvelope: true, body: short });
      expect(out.collapsed).toBe(false);
      expect(out.lead).toBe(short);
    }
  });
});

describe("shapeReportLead — the lead never ends in a bare ellipsis", () => {
  it("cuts a collapsed slack lead at a sentence boundary, not mid-word", () => {
    const out = shapeReportLead({
      trigger: "slack",
      agentSlug: "engineer",
      hasEnvelope: true,
      body: LONG_BODY,
    });
    expect(out.collapsed).toBe(true);
    expect(out.lead.endsWith("…")).toBe(false);
    expect(out.lead).not.toContain("…");
    expect(out.lead.trim()).toMatch(/[.!?]$/);
  });

  it("keeps the terminator when the 120th word IS the end of a sentence", () => {
    const words = Array.from({ length: 119 }, (_, i) => `word${i}`);
    const body = `${words.join(" ")} end. ${"tail ".repeat(60)}`;
    const out = shapeReportLead({
      trigger: "slack",
      agentSlug: "engineer",
      hasEnvelope: true,
      body,
    });
    expect(out.collapsed).toBe(true);
    expect(out.lead.trim()).toMatch(/[.!?]$/);
    expect(out.lead).not.toContain("…");
  });

  it("emits no bare ellipsis even when the body has no sentence boundary in budget", () => {
    const noPunct = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const out = shapeReportLead({
      trigger: "slack",
      agentSlug: "engineer",
      hasEnvelope: true,
      body: noPunct,
    });
    if (out.collapsed) {
      expect(out.lead.endsWith("…")).toBe(false);
      expect(out.lead).not.toContain("…");
    }
  });
});
