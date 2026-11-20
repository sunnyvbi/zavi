
import { describe, it, expect } from "vitest";
import {
  deriveOutcome,
  isReplyExpectingTrigger,
  shouldFailEmptyCompletion,
  EMPTY_COMPLETION_ERROR,
} from "../outcome-model";

function emptyChatOutcome() {
  return deriveOutcome({ status: "success", outputText: "", error: null });
}

describe("empty-completion guard — shouldFailEmptyCompletion", () => {
  it("FAILS an empty deliver-nothing CHAT run (old behavior marked it success)", () => {
    const outcome = emptyChatOutcome();
    expect(outcome.liveness_tier).toBe("empty");
    expect(
      shouldFailEmptyCompletion({
        enabled: true,
        status: "success",
        trigger: "chat",
        livenessTier: outcome.liveness_tier,
        decisionCount: 0,
      }),
    ).toBe(true);
  });

  it("FAILS an empty deliver-nothing SLACK run", () => {
    expect(
      shouldFailEmptyCompletion({
        enabled: true,
        status: "success",
        trigger: "slack",
        livenessTier: emptyChatOutcome().liveness_tier,
        decisionCount: 0,
      }),
    ).toBe(true);
  });

  it("does NOT false-fail a no-op CRON / scheduled / manual-scan run (correctly produced nothing)", () => {
    for (const trigger of ["cron", "scheduled", "manual", "webhook", "handoff"]) {
      expect(
        shouldFailEmptyCompletion({
          enabled: true,
          status: "success",
          trigger,
          livenessTier: "empty",
          decisionCount: 0,
        }),
      ).toBe(false);
    }
  });

  it("does NOT touch a2a (conductor build child — failed there triggers a bounded repair re-dispatch)", () => {
    expect(
      shouldFailEmptyCompletion({
        enabled: true,
        status: "success",
        trigger: "a2a",
        livenessTier: "empty",
        decisionCount: 0,
      }),
    ).toBe(false);
    expect(isReplyExpectingTrigger("a2a")).toBe(false);
  });

  it("does NOT fail a run that produced a real deliverable (liveness answered)", () => {
    const answered = deriveOutcome({ status: "success", outputText: "Here is your answer." });
    expect(answered.liveness_tier).toBe("answered");
    expect(
      shouldFailEmptyCompletion({
        enabled: true,
        status: "success",
        trigger: "chat",
        livenessTier: answered.liveness_tier,
        decisionCount: 0,
      }),
    ).toBe(false);
  });

  it("does NOT fail a run that emitted/proposed a decision (approval card the customer DID get)", () => {
    expect(
      shouldFailEmptyCompletion({
        enabled: true,
        status: "success",
        trigger: "chat",
        livenessTier: "empty",
        decisionCount: 2,
      }),
    ).toBe(false);
  });

  it("does NOT fail on an UNKNOWN decision count (DB read blip → fail-open, never mislabel)", () => {
    expect(
      shouldFailEmptyCompletion({
        enabled: true,
        status: "success",
        trigger: "chat",
        livenessTier: "empty",
        decisionCount: -1,
      }),
    ).toBe(false);
  });

  it("flag OFF → never fails (byte-identical to old behavior)", () => {
    expect(
      shouldFailEmptyCompletion({
        enabled: false,
        status: "success",
        trigger: "chat",
        livenessTier: "empty",
        decisionCount: 0,
      }),
    ).toBe(false);
  });

  it("only touches a success terminal (never cancelled / dispatch_error / parse_failed / failed)", () => {
    for (const status of ["cancelled", "dispatch_error", "parse_failed", "failed"]) {
      expect(
        shouldFailEmptyCompletion({
          enabled: true,
          status,
          trigger: "chat",
          livenessTier: "empty",
          decisionCount: 0,
        }),
      ).toBe(false);
    }
  });

  it("re-deriving the outcome for the relabeled run keeps it empty + carries the honest error", () => {
    const relabeled = deriveOutcome({
      status: "failed",
      outputText: "",
      error: EMPTY_COMPLETION_ERROR,
    });
    expect(relabeled.deliverable).toBeNull();
    expect(relabeled.liveness_tier).toBe("empty");
    expect(relabeled.failure.raw_error).toBe(EMPTY_COMPLETION_ERROR);
  });
});
