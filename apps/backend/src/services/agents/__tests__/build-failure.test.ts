import { describe, expect, it } from "vitest";
import {
  BUILD_STATUS_ERROR_MAX_CHARS,
  boundedBuildError,
  childFailureMessage,
  durationMs,
  summarizeBuildFailure,
  nodeFailureText,
  stageRetryCount,
  type BuildChildRun,
  type BuildStageNode,
} from "../build-failure";

const children = (...rows: BuildChildRun[]) => new Map(rows.map((row) => [row.id, row]));

describe("build failure projection", () => {
  it("preserves the child agent error for an old stage node", () => {
    const graph: BuildStageNode[] = [{
      id: "build",
      status: "failed",
      target_agent_slug: "engineer",
      child_run_id: "agent-1",
      repair_attempts: 2,
      payload: { stage: "build" },
    }];
    expect(summarizeBuildFailure({
      runStatus: "failed",
      graph,
      children: children({ id: "agent-1", status: "failed", error: "vite: module not found" }),
    })).toEqual({
      class: "stage_failed",
      message: "vite: module not found",
      stage: "build",
      run_id: "agent-1",
      agent: "engineer",
      retry_count: 2,
    });
  });

  it("classifies provider capacity without losing the retryable reason", () => {
    const failure = summarizeBuildFailure({
      runStatus: "failed",
      graph: [{ status: "failed", child_run_id: "agent-1", payload: { stage: "scaffold" } }],
      children: children({ id: "agent-1", error: "Anthropic API: 429 too many requests" }),
    });
    expect(failure?.class).toBe("provider_capacity");
    expect(failure?.message).toContain("429");
  });

  it("keeps explicit conductor classes for repair, deploy, and budget failures", () => {
    for (const failureClass of ["repair_exhausted", "deploy_failed", "class_cap_halted"] as const) {
      const failure = summarizeBuildFailure({
        runStatus: failureClass === "class_cap_halted" ? "halted" : "failed",
        graph: [{
          status: failureClass === "class_cap_halted" ? "pending" : "failed",
          error: "short reason",
          failure_class: failureClass,
          payload: { stage: "qa" },
        }],
        children: children(),
      });
      expect(failure?.class).toBe(failureClass);
      expect(failure?.message).toBe("short reason");
    }
  });

  it("distinguishes stale reaping from user cancellation", () => {
    expect(summarizeBuildFailure({
      runStatus: "failed", graph: [], children: children(), cancelReason: "stale_slot_reap",
    })?.class).toBe("stale_reaped");
    expect(summarizeBuildFailure({
      runStatus: "failed", graph: [], children: children(), cancelReason: "user_cancel",
    })?.class).toBe("user_cancelled");
  });

  it("uses error > parse_error > output_text and computes safe durations", () => {
    expect(childFailureMessage({ id: "1", error: " thrown ", parse_error: "parse", output_text: "qa" }))
      .toBe("thrown");
    expect(childFailureMessage({ id: "1", parse_error: "parse", output_text: "qa" })).toBe("parse");
    expect(childFailureMessage({ id: "1", output_text: "qa" })).toBe("qa");
    expect(durationMs("2026-07-22T00:00:00Z", "2026-07-22T00:00:03Z")).toBe(3000);
    expect(durationMs("bad", "2026-07-22T00:00:03Z")).toBeNull();
  });

  it("bounds errors returned by the polling status API", () => {
    const bounded = boundedBuildError(`  ${"x".repeat(BUILD_STATUS_ERROR_MAX_CHARS + 50)}  `);
    expect(bounded).toHaveLength(BUILD_STATUS_ERROR_MAX_CHARS);
  });
});

describe("a stage being retried is not a failure yet", () => {
  const retrying: BuildStageNode = {
    id: "build",
    status: "dispatched",
    target_agent_slug: "engineer",
    child_run_id: "repair-1",
    repair_attempts: 1,
    error: null,
    last_failure_signal: 'Stage "build" finished but no code reached the provisioned repo after 10 min.',
    payload: { stage: "build" },
  };

  it("an active run whose failed stage is back in flight reports no failure", () => {
    expect(summarizeBuildFailure({
      runStatus: "active",
      graph: [{ id: "scaffold", status: "done", payload: { stage: "scaffold" } }, retrying],
      children: children({ id: "repair-1", status: "queued" }),
    })).toBeNull();
    expect(nodeFailureText(retrying)).toBeNull();
  });

  it("the same signal is the failure once the stage is failed for good", () => {
    const exhausted: BuildStageNode = { ...retrying, status: "failed", error: null, repair_attempts: 3 };
    expect(summarizeBuildFailure({
      runStatus: "failed",
      graph: [exhausted],
      children: children({ id: "repair-1", status: "success" }),
    })).toMatchObject({ class: "stage_failed", message: expect.stringContaining("no code reached"), retry_count: 3 });
    expect(nodeFailureText(exhausted)).toContain("no code reached");
  });

  it("a retry whose new child died is still a failure", () => {
    expect(summarizeBuildFailure({
      runStatus: "active",
      graph: [retrying],
      children: children({ id: "repair-1", status: "dispatch_error", error: "template not found" }),
    })).toMatchObject({ message: "template not found", stage: "build" });
  });
});

describe("stage retry count", () => {
  it("counts a site deploy node's own fix passes", () => {
    expect(stageRetryCount({ site_repair_attempts: 1, payload: { stage: "deploy" } })).toBe(1);
    expect(stageRetryCount({ repair_attempts: 2 })).toBe(2);
    expect(stageRetryCount({})).toBe(0);
    expect(stageRetryCount({ site_repair_attempts: Number.NaN })).toBe(0);
  });

  it("a failed site deploy reports its fix passes in the failure", () => {
    const failure = summarizeBuildFailure({
      runStatus: "failed",
      graph: [{ status: "failed", error: "smoke failed", site_repair_attempts: 1, payload: { stage: "deploy" } }],
      children: new Map(),
    });
    expect(failure?.retry_count).toBe(1);
  });
});
