import { describe, it, expect } from "vitest";
import { deriveOutcome } from "../outcome-model";

describe("deriveOutcome", () => {
  it("success with output_text → deliverable set, failure none", () => {
    const o = deriveOutcome({ status: "success", outputText: "Opened PR #5." });
    expect(o.deliverable).toBe("Opened PR #5.");
    expect(o.failure.class).toBe("none");
    expect(o.failure.raw_error).toBeNull();
  });

  it("success with empty output_text → deliverable null (seam applies the floor)", () => {
    const o = deriveOutcome({ status: "success", outputText: "" });
    expect(o.deliverable).toBeNull();
    expect(o.failure.class).toBe("none");
  });

  it("parse_failed WITH output_text → deliverable preserved, class envelope", () => {
    const o = deriveOutcome({
      status: "parse_failed",
      outputText: "I made the change but the platform refused to ship: forbidden_path.",
      error: null,
      parseError: null,
    });
    expect(o.deliverable).toContain("forbidden_path");
    expect(o.failure.class).toBe("envelope");
    expect(o.side_effect.kind).toBe("unknown");
  });

  it("parse_failed with NO text but a parse_error → no deliverable, raw_error carried", () => {
    const o = deriveOutcome({
      status: "parse_failed",
      outputText: "",
      error: null,
      parseError: "schema mismatch on field X",
    });
    expect(o.deliverable).toBeNull();
    expect(o.failure.class).toBe("envelope");
    expect(o.failure.raw_error).toBe("schema mismatch on field X");
  });

  it("dispatch_error from an infra reap → class infra, raw_error carried", () => {
    const o = deriveOutcome({
      status: "dispatch_error",
      error: "boot_reap: orphaned by container restart (worker died mid-run)",
    });
    expect(o.deliverable).toBeNull();
    expect(o.failure.class).toBe("infra");
    expect(o.failure.raw_error).toContain("boot_reap");
  });

  it("dispatch_error from preparing the site sandbox (before any model call) → class infra", () => {
    for (const error of [
      "resetSiteRepo: git failed (exit 1): error: Your local changes to the following files would be overwritten by checkout",
      "onSiteSandboxReady: the running preview could not be stopped (exit 1)",
    ]) {
      expect(deriveOutcome({ status: "dispatch_error", error }).failure.class).toBe("infra");
    }
    for (const error of [
      "the agent said resetSiteRepo: git failed",
      "resetSiteRepo: origin mismatch (expected a, got b)",
      "onSiteSandboxReady: the run's site does not belong to this tenant",
    ]) {
      expect(deriveOutcome({ status: "dispatch_error", error }).failure.class, error).toBe("model_error");
    }
  });

  it("dispatch_error from a model/provider error → class model_error", () => {
    const o = deriveOutcome({
      status: "dispatch_error",
      error: "claude code returned an error result",
    });
    expect(o.failure.class).toBe("model_error");
  });

  it("dispatch_error with empty error → class model_error (safe generic)", () => {
    const o = deriveOutcome({ status: "dispatch_error", error: null });
    expect(o.failure.class).toBe("model_error");
    expect(o.deliverable).toBeNull();
  });

  it("cancelled → class cancelled, no failure-render error", () => {
    const o = deriveOutcome({ status: "cancelled" });
    expect(o.failure.class).toBe("cancelled");
    expect(o.failure.raw_error).toBeNull();
    expect(o.side_effect.kind).toBe("none");
  });

  it("success + sideEffect shipped → side_effect.kind shipped (with detail)", () => {
    const o = deriveOutcome({
      status: "success",
      outputText: "Opened PR #9.",
      sideEffect: { kind: "shipped", detail: "dec-123" },
    });
    expect(o.side_effect.kind).toBe("shipped");
    expect(o.side_effect.detail).toBe("dec-123");
    expect(o.deliverable).toBe("Opened PR #9.");
  });

  it("parse_failed + sideEffect refused → side_effect.kind refused (deliverable preserved)", () => {
    const o = deriveOutcome({
      status: "parse_failed",
      outputText: "Couldn't ship: forbidden_path.",
      sideEffect: { kind: "refused", reason: "builder_rejected:forbidden_path" },
    });
    expect(o.side_effect.kind).toBe("refused");
    expect(o.side_effect.reason).toBe("builder_rejected:forbidden_path");
    expect(o.deliverable).toContain("forbidden_path");
  });

  it("sideEffect absent → keeps the per-status default (success→unknown, never fabricates shipped)", () => {
    expect(deriveOutcome({ status: "success", outputText: "hi" }).side_effect.kind).toBe("unknown");
    expect(deriveOutcome({ status: "failed", error: "boom" }).side_effect.kind).toBe("none");
  });

  it("sideEffect none on a success run → none (not unknown)", () => {
    const o = deriveOutcome({ status: "success", outputText: "answered", sideEffect: { kind: "none" } });
    expect(o.side_effect.kind).toBe("none");
  });
});

describe("deriveOutcome — liveness_tier", () => {
  it("success + sideEffect shipped → tier shipped", () => {
    const o = deriveOutcome({
      status: "success",
      outputText: "Opened PR #9.",
      sideEffect: { kind: "shipped", detail: "dec-123" },
    });
    expect(o.liveness_tier).toBe("shipped");
  });

  it("success + sideEffect refused → tier plan_only (a held proposal)", () => {
    const o = deriveOutcome({
      status: "success",
      outputText: "Proposed the change; held for review.",
      sideEffect: { kind: "refused", reason: "held_for_review" },
    });
    expect(o.liveness_tier).toBe("plan_only");
  });

  it("success + deliverable, no sideEffect, no tools → tier answered", () => {
    const o = deriveOutcome({ status: "success", outputText: "Here is the analysis you asked for." });
    expect(o.side_effect.kind).toBe("unknown");
    expect(o.liveness_tier).toBe("answered");
  });

  it("success + NO deliverable, no sideEffect, no tools → tier empty (the fake-done class)", () => {
    const o = deriveOutcome({ status: "success", outputText: "" });
    expect(o.deliverable).toBeNull();
    expect(o.liveness_tier).toBe("empty");
  });

  it("success + a mutating tool ran ok (unstamped agent) → tier shipped", () => {
    const o = deriveOutcome({
      status: "success",
      outputText: "Posted the digest to #growth.",
      toolCalls: [
        { name: "mcp__server__memory__search", input_preview: "", output_preview: "", ms: 1, status: "ok" },
        { name: "mcp__server__slack__post_message", input_preview: "", output_preview: "", ms: 1, status: "ok" },
      ],
    });
    expect(o.side_effect.kind).toBe("unknown");
    expect(o.liveness_tier).toBe("shipped");
  });

  it("success + only READ tools ran + deliverable → tier answered (not shipped)", () => {
    const o = deriveOutcome({
      status: "success",
      outputText: "Funnel is constrained on supply in TX.",
      toolCalls: [
        { name: "mcp__server__meta_ads__list_campaigns", input_preview: "", output_preview: "", ms: 1, status: "ok" },
        { name: "mcp__server__growth__diagnose_funnel", input_preview: "", output_preview: "", ms: 1, status: "ok" },
      ],
    });
    expect(o.liveness_tier).toBe("answered");
  });

  it("success + a mutating tool that ERRORED + no deliverable → tier empty (mutation did not land)", () => {
    const o = deriveOutcome({
      status: "success",
      outputText: "",
      toolCalls: [
        { name: "mcp__server__slack__post_message", input_preview: "", output_preview: "", ms: 1, status: "throw" },
      ],
    });
    expect(o.liveness_tier).toBe("empty");
  });

  it("NON-DOUBLE-GUARD: a stamped side_effect skips the tool heuristic entirely", () => {
    const o = deriveOutcome({
      status: "success",
      outputText: "Empty diff — nothing to ship.",
      sideEffect: { kind: "refused", reason: "empty_diff" },
      toolCalls: [
        { name: "mcp__server__slack__post_message", input_preview: "", output_preview: "", ms: 1, status: "ok" },
      ],
    });
    expect(o.liveness_tier).toBe("plan_only");
  });

  it("stamped 'none' + deliverable → answered; stamped 'none' + no deliverable → empty", () => {
    expect(
      deriveOutcome({ status: "success", outputText: "done", sideEffect: { kind: "none" } }).liveness_tier,
    ).toBe("answered");
    expect(
      deriveOutcome({ status: "success", outputText: "", sideEffect: { kind: "none" } }).liveness_tier,
    ).toBe("empty");
  });

  it("cancelled / failure runs get a tier too (additive metadata)", () => {
    expect(deriveOutcome({ status: "cancelled", outputText: "" }).liveness_tier).toBe("empty");
    expect(deriveOutcome({ status: "dispatch_error", error: "boom" }).liveness_tier).toBe("empty");
    expect(
      deriveOutcome({ status: "parse_failed", outputText: "Here's the answer despite the envelope miss." })
        .liveness_tier,
    ).toBe("answered");
  });
});

describe("side_effect detail survives into the outcome (checkpoint evidence)", () => {
  it("keeps detail from the dispatcher stamp", () => {
    const o = deriveOutcome({
      status: "parse_failed",
      outputText: "nothing to change",
      sideEffect: { kind: "refused", reason: "empty_diff", detail: "typecheck:passed" },
    });
    expect(o.side_effect).toEqual({ kind: "refused", reason: "empty_diff", detail: "typecheck:passed" });
  });
});
