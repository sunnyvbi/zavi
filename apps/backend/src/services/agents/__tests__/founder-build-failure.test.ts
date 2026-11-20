import { describe, expect, it } from "vitest";
import {
  BUILD_CHECKS_FAILED,
  BUILD_DATABASE_SETUP_FAILED,
  BUILD_FIXES_EXHAUSTED,
  BUILD_INTERNAL_FAILURE,
  BUILD_NO_CREDITS_TO_START,
  BUILD_OUT_OF_CREDITS,
  BUILD_OVER_BUDGET,
  BUILD_PROVIDER_BUSY,
  BUILD_PUBLISH_FAILED,
  BUILD_SETUP_FAILED,
  BUILD_STAGE_RETRYING,
  BUILD_STALLED,
  BUILD_STOPPED_BY_YOU,
  BUILD_TEAM_REVIEW,
  FOUNDER_BUILD_FAILURE_CODES,
  founderBuildFailure,
} from "@zavi/shared";
import { BUILD_FAILURE_CLASSES } from "../conductor";
import { APP_DATABASE_SETUP_FAILED_COPY, APP_HOSTING_NOT_READY_COPY } from "../run-failure-code";
import { BUILD_REPO_NOT_PROVISIONED_COPY, SITE_SETUP_UNAVAILABLE_COPY } from "../start-product-build";
import { founderFailureView, founderStageError, summarizeBuildFailure } from "../build-failure";

const RAW = "onSiteSandboxReady: the running preview could not be stopped (exit 1)";

describe("founderBuildFailure: every conductor failure class has founder copy", () => {
  const expected: Record<(typeof BUILD_FAILURE_CLASSES)[number], string> = {
    stage_failed: BUILD_INTERNAL_FAILURE,
    dispatch_failed: BUILD_INTERNAL_FAILURE,
    provider_capacity: BUILD_PROVIDER_BUSY,
    repair_exhausted: BUILD_FIXES_EXHAUSTED,
    acceptance_failed: BUILD_CHECKS_FAILED,
    deploy_failed: BUILD_PUBLISH_FAILED,
    budget_halted: BUILD_OVER_BUDGET,
    class_cap_halted: BUILD_OVER_BUDGET,
    stale_reaped: BUILD_STALLED,
    user_cancelled: BUILD_STOPPED_BY_YOU,
    provision_failed: BUILD_SETUP_FAILED,
    coach_precedence: BUILD_TEAM_REVIEW,
    app_database_setup: BUILD_DATABASE_SETUP_FAILED,
    unknown: BUILD_INTERNAL_FAILURE,
  };

  for (const cls of BUILD_FAILURE_CLASSES) {
    it(`${cls}: plain copy, never the raw diagnostic`, () => {
      const out = founderBuildFailure({ class: cls, message: RAW });
      expect(out?.message).toBe(expected[cls]);
      expect(out?.message).not.toContain("exit 1");
      expect(FOUNDER_BUILD_FAILURE_CODES).toContain(out?.code);
    });
  }

  it("the QA failure (an internal sandbox step) reads as the generic line with code internal", () => {
    expect(founderBuildFailure({ class: "stage_failed", message: RAW })).toEqual({
      code: "internal",
      message: BUILD_INTERNAL_FAILURE,
    });
  });

  it("an unknown class or a class missing altogether falls back to the generic line", () => {
    expect(founderBuildFailure({ class: "brand_new_class", message: RAW })?.message).toBe(BUILD_INTERNAL_FAILURE);
    expect(founderBuildFailure({ message: RAW })?.message).toBe(BUILD_INTERNAL_FAILURE);
  });

  it("credits win over the class they were written under, and partway is said only after work finished", () => {
    const reason = "repair dispatch failed (insufficient_credits); last failure: insufficient_credits";
    expect(founderBuildFailure({ class: "repair_exhausted", message: reason }, { startedWork: true })).toEqual({
      code: "out_of_credits",
      message: BUILD_OUT_OF_CREDITS,
    });
    expect(founderBuildFailure({ class: "stage_failed", message: reason })?.message).toBe(BUILD_NO_CREDITS_TO_START);
  });

  it("a founder's own stop stays a stop even if the text mentions credits", () => {
    expect(founderBuildFailure({ class: "user_cancelled", message: "insufficient_credits" })?.code).toBe("stopped_by_you");
  });

  it("recognises budget and capacity text under a generic class", () => {
    expect(founderBuildFailure({ class: "stage_failed", message: "Build stopped at build: class spend cap reached." })?.code).toBe(
      "safety_limit",
    );
    expect(founderBuildFailure({ class: "stage_failed", message: "Claude Code returned API Error: 529 overloaded" })?.code).toBe(
      "service_busy",
    );
  });

  it("no failure means no line", () => {
    expect(founderBuildFailure(null)).toBeNull();
    expect(founderBuildFailure({ class: "", message: "  " })).toBeNull();
  });

  it("no founder line names a vendor or an internal tool", () => {
    for (const cls of [...BUILD_FAILURE_CLASSES, "x"]) {
      const line = founderBuildFailure({ class: cls, message: RAW })!.message;
      expect(line).not.toMatch(/claude|anthropic|e2b|sandbox|render|neon|supabase|github|conductor|dispatch|—/i);
    }
  });
});

describe("founderFailureView: what /build-status sends", () => {
  const graph = [
    { status: "done", payload: { stage: "provision" } },
    { status: "failed", error: RAW, payload: { stage: "build" }, child_run_id: "r1", target_agent_slug: "engineer" },
  ];

  it("carries class, code, founder message, stage and retries, and drops the raw text and agent", () => {
    const failure = summarizeBuildFailure({ runStatus: "failed", graph, children: new Map() });
    const view = founderFailureView(failure, [{ status: "done" }, { status: "failed" }]);
    expect(view).toEqual({
      class: "stage_failed",
      code: "internal",
      message: BUILD_INTERNAL_FAILURE,
      stage: "build",
      retry_count: 0,
    });
    expect(JSON.stringify(view)).not.toContain("onSiteSandboxReady");
  });

  it("null stays null", () => {
    expect(founderFailureView(null, [])).toBeNull();
  });

  it("uses finished stages to decide 'partway' for a credits stop", () => {
    const failure = summarizeBuildFailure({
      runStatus: "failed",
      graph: [{ status: "failed", error: "insufficient_credits", payload: { stage: "build" } }],
      children: new Map(),
    });
    expect(founderFailureView(failure, [{ status: "done" }])?.message).toBe(BUILD_OUT_OF_CREDITS);
    expect(founderFailureView(failure, [{ status: "pending" }])?.message).toBe(BUILD_NO_CREDITS_TO_START);
  });
});

describe("copy the backend already wrote for the founder reaches them word for word", () => {
  it.each([APP_DATABASE_SETUP_FAILED_COPY, APP_HOSTING_NOT_READY_COPY, BUILD_REPO_NOT_PROVISIONED_COPY, SITE_SETUP_UNAVAILABLE_COPY])(
    "%s",
    (copy) => {
      expect(founderBuildFailure({ class: "stage_failed", message: `app_database_setup_failed: ${copy}\n    at stack` })?.message).toBe(
        copy,
      );
    },
  );

  it("a refused file path keeps its founder line (it names the founder's own files) in the view and the stage row", () => {
    const signal = "dispatch_inner: builder_policy_refused: Zavi can't publish changes to .env, so it left them out.\n  at x";
    const failure = summarizeBuildFailure({
      runStatus: "failed",
      graph: [{ status: "failed", error: signal, payload: { stage: "build" } }],
      children: new Map(),
    });
    expect(founderFailureView(failure, [])?.message).toBe("Zavi can't publish changes to .env, so it left them out.");
    expect(founderStageError(signal, "failed", "stage_failed")).toBe(
      "Zavi can't publish changes to .env, so it left them out.",
    );
  });
});

describe("founderStageError: a stage row's line", () => {
  it("failed stage: founder copy for its class", () => {
    expect(founderStageError(RAW, "failed", "deploy_failed")).toBe(BUILD_PUBLISH_FAILED);
    expect(founderStageError(RAW, "failed", null)).toBe(BUILD_INTERNAL_FAILURE);
  });
  it("a stage still being worked on gets the neutral line, a finished one gets none", () => {
    expect(founderStageError(RAW, "running", null)).toBe(BUILD_STAGE_RETRYING);
    expect(founderStageError(RAW, "done", null)).toBeNull();
    expect(founderStageError(null, "failed", "stage_failed")).toBeNull();
  });
  it("a spend-cap halt leaves its stage 'pending' with the error: once the run stopped it reads as stopped, not 'working on a fix'", () => {
    const raw = "Build stopped at build: build budget reached.";
    expect(founderStageError(raw, "pending", "budget_halted", true)).toBe(BUILD_OVER_BUDGET);
    expect(founderStageError(raw, "pending", "budget_halted", false)).toBe(BUILD_STAGE_RETRYING);
  });
});
