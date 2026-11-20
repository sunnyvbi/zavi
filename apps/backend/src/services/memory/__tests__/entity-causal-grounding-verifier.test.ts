import { describe, it, expect } from "vitest";
import type { ToolCallTrace } from "@/services/tools/types";
import {
  classifyEntityGrounding,
  extractEntityAtoms,
} from "../entity-causal-grounding-verifier";

const tc = (name: string, output_preview: string, status: ToolCallTrace["status"] = "ok"): ToolCallTrace => ({
  name,
  input_preview: "",
  output_preview,
  ms: 1,
  status,
});

describe("entity-causal-grounding-verifier", () => {
  it("QA#1 INCIDENT REPLAY: ungrounded 'PR #N fixes X' (no tools) => not grounded", () => {
    const v = classifyEntityGrounding({
      body: "PR #1079 fixes the webhookHandlers.ts double-charge race. Merge it, urgent.",
      toolCalls: [],
    });
    expect(v.hasEntityClaim).toBe(true);
    expect(v.grounded).toBe(false);
    expect(v.contradicted).toBe(false);
    expect(v.groundedBy).toBeNull();
  });

  it("QA#3 CONTRADICTION: tool return references #1079 but it's a carousel fix => contradicted, not grounded", () => {
    const v = classifyEntityGrounding({
      body: "PR #1079 fixes the webhook race.",
      toolCalls: [
        tc("github__get_pr", 'PR #1079: "stop runaway mobile carousel cycling on car detail page" branch=car-detail-mobile-embla'),
      ],
    });
    expect(v.hasEntityClaim).toBe(true);
    expect(v.contradicted).toBe(true);
    expect(v.grounded).toBe(false);
    expect(v.groundedBy).toBeNull();
  });

  it("QA#2 GROUNDED: tool return supports the relationship => grounded + provenance", () => {
    const v = classifyEntityGrounding({
      body: "PR #1080 fixes the webhook idempotency handler.",
      toolCalls: [
        tc("github__get_pr", 'PR #1080: "add idempotency key to webhook handler; prevents duplicate processing"'),
      ],
    });
    expect(v.grounded).toBe(true);
    expect(v.contradicted).toBe(false);
    expect(v.groundedBy).toEqual({ tool: "github__get_pr", ref: "1080" });
  });

  it("QA#4 NO REGRESSION: a pure number claim has no entity atom => gate inert", () => {
    const v = classifyEntityGrounding({
      body: "Bookings rose to 198 this week, up from 170.",
      toolCalls: [],
    });
    expect(v.hasEntityClaim).toBe(false);
    expect(v.grounded).toBe(false);
    expect(v.contradicted).toBe(false);
  });

  it("bare entity mention WITHOUT a causal/action verb is NOT gated", () => {
    const v = classifyEntityGrounding({
      body: "I reviewed PR #1079 and left comments.",
      toolCalls: [],
    });
    expect(v.hasEntityClaim).toBe(false);
  });

  it("errored tool return grounds nothing", () => {
    const v = classifyEntityGrounding({
      body: "PR #1080 fixes webhook idempotency.",
      toolCalls: [tc("github__get_pr", "PR #1080 webhook idempotency", "tool_error")],
    });
    expect(v.grounded).toBe(false);
  });

  it("file-path causal claim is detected", () => {
    const atoms = extractEntityAtoms("The root cause is webhookHandlers.ts mishandling retries.");
    expect(atoms.some((a) => a.kind === "file" && a.ref === "webhookHandlers.ts")).toBe(true);
  });

  it("commit-sha causal claim is detected (hex, not a bare number)", () => {
    const atoms = extractEntityAtoms("Commit a1b2c3d introduced the regression.");
    expect(atoms.some((a) => a.kind === "commit" && a.ref === "a1b2c3d")).toBe(true);
  });

  it("multiple atoms: one contradicted poisons the note", () => {
    const v = classifyEntityGrounding({
      body: "PR #1080 fixes webhook idempotency. Also PR #1079 fixes the webhook race.",
      toolCalls: [
        tc("github__get_pr", 'PR #1080: "webhook idempotency handler"'),
        tc("github__get_pr", 'PR #1079: "mobile carousel cycling fix"'),
      ],
    });
    expect(v.contradicted).toBe(true);
    expect(v.grounded).toBe(false);
  });
});
