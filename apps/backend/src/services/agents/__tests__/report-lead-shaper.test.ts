import { describe, it, expect } from "vitest";
import { shapeReportLead } from "../report-lead-shaper";
import fixture from "./__fixtures__/real-ads-reply.json";

const digest: string = fixture.reply;

describe("shapeReportLead", () => {
  it("collapses a broad-ask digest to a ≤120-word lead on slack, keeps full", () => {
    const r = shapeReportLead({
      trigger: "slack",
      agentSlug: "performance-marketer",
      hasEnvelope: true,
      body: digest,
    });
    expect(r.collapsed).toBe(true);
    expect(r.lead.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(120);
    expect(r.full).toBe(digest);
    expect(r.lead.length).toBeGreaterThan(0);
    expect(r.lead).not.toMatch(/^\s*#/);
  });

  it("does NOT collapse on web chat (chat renders the full reply)", () => {
    const r = shapeReportLead({
      trigger: "chat",
      agentSlug: "performance-marketer",
      hasEnvelope: true,
      body: digest,
    });
    expect(r.collapsed).toBe(false);
    expect(r.lead).toBe(digest);
  });

  it("no-ops on cron/scheduled (surface-gated)", () => {
    for (const trigger of ["cron", "scheduled", "manual", "handoff", "qa-weekly-execute"]) {
      expect(shapeReportLead({ trigger, agentSlug: "performance-marketer", hasEnvelope: true, body: digest }).collapsed).toBe(false);
    }
  });

  it("no-ops for a non-report agent", () => {
    expect(shapeReportLead({ trigger: "slack", agentSlug: "operator", hasEnvelope: true, body: digest }).collapsed).toBe(false);
  });

  it("no-ops on a short reply (already graspable)", () => {
    const r = shapeReportLead({ trigger: "slack", agentSlug: "pm", hasEnvelope: true, body: "Yes — the Bay Area budget is doubled to $20/day as of this morning." });
    expect(r.collapsed).toBe(false);
    expect(r.lead).toBe("Yes — the Bay Area budget is doubled to $20/day as of this morning.");
  });

  it("no-ops when there is no envelope to fall back to", () => {
    expect(shapeReportLead({ trigger: "slack", agentSlug: "pm", hasEnvelope: false, body: digest }).collapsed).toBe(false);
  });
});
