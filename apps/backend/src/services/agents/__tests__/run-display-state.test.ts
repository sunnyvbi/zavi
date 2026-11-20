import { describe, it, expect } from "vitest";
import { classifyRun, runHasDeliverable, presentationStatus } from "../run-display-state";

describe("classifyRun", () => {
  it("success → answered", () => {
    expect(classifyRun({ status: "success", outputText: "done" }).displayState).toBe("answered");
  });

  it("success with empty output → still answered (surface shows its own floor)", () => {
    expect(classifyRun({ status: "success", outputText: "" }).displayState).toBe("answered");
  });

  it("parse_failed WITH outcome.deliverable → answered", () => {
    const r = classifyRun({
      status: "parse_failed",
      outcome: { deliverable: "I made the change but couldn't ship the migration." },
    });
    expect(r.displayState).toBe("answered");
    expect(r.hasDeliverable).toBe(true);
  });

  it("parse_failed with outcome present but deliverable null → failed", () => {
    expect(classifyRun({ status: "parse_failed", outcome: { deliverable: null } }).displayState).toBe(
      "failed",
    );
  });

  it("dispatch_error with nothing → failed", () => {
    expect(
      classifyRun({ status: "dispatch_error", outcome: { deliverable: null } }).displayState,
    ).toBe("failed");
  });

  it("cancelled → cancelled", () => {
    expect(classifyRun({ status: "cancelled" }).displayState).toBe("cancelled");
  });

  it("queued / running / dispatching → running", () => {
    expect(classifyRun({ status: "queued" }).displayState).toBe("running");
    expect(classifyRun({ status: "running" }).displayState).toBe("running");
    expect(classifyRun({ status: "dispatching" }).displayState).toBe("running");
  });

  it("null outcome + parse_failed + output_text fallback → answered", () => {
    expect(
      classifyRun({ status: "parse_failed", outcome: null, outputText: "real answer" }).displayState,
    ).toBe("answered");
  });

  it("null outcome + parse_failed + no output_text → failed", () => {
    expect(classifyRun({ status: "parse_failed", outcome: null, outputText: "" }).displayState).toBe(
      "failed",
    );
  });

  it("outcome present + empty deliverable does NOT fall back to stale outputText → failed", () => {
    expect(
      classifyRun({ status: "parse_failed", outcome: { deliverable: "" }, outputText: "stale" })
        .displayState,
    ).toBe("failed");
  });

  it("presentationStatus convenience matches", () => {
    expect(presentationStatus({ status: "success" })).toBe("answered");
  });

  it("runHasDeliverable direct", () => {
    expect(runHasDeliverable({ status: "success" })).toBe(true);
    expect(runHasDeliverable({ status: "failed", outcome: { deliverable: null } })).toBe(false);
  });
});
