import { describe, it, expect } from "vitest";
import { BUILD_PUBLISH_FAILED, BUILD_STAGE_RETRYING } from "@zavi/shared";
import {
  buildFailureCopy,
  buildFailureLine,
  changeFailureCopy,
  isOutOfCreditsBuild,
  isOutOfCreditsFailure,
  stageErrorLine,
  BUILD_OUT_OF_CREDITS,
  BUILD_NO_CREDITS_TO_START,
  CHANGE_OUT_OF_CREDITS,
  BUILD_OVER_BUDGET,
  BUILD_PROVIDER_BUSY,
  BUILD_INTERNAL_FAILURE,
} from "./buildFailureCopy";

describe("buildFailureCopy", () => {
  it("humanises the exact string a founder saw in prod", () => {
    expect(
      buildFailureCopy(
        "repair dispatch failed (insufficient_credits); last failure: insufficient_credits",
        { startedWork: true },
      ),
    ).toBe(BUILD_OUT_OF_CREDITS);
  });

  it("says 'partway through' only when a step really finished first", () => {
    const reason = "repair dispatch failed (insufficient_credits); last failure: insufficient_credits";
    expect(buildFailureCopy(reason)).toBe(BUILD_NO_CREDITS_TO_START);
    expect(buildFailureCopy(reason, { startedWork: false })).toBe(BUILD_NO_CREDITS_TO_START);
    expect(BUILD_NO_CREDITS_TO_START).not.toMatch(/partway/i);
    expect(isOutOfCreditsFailure(reason)).toBe(true);
    expect(isOutOfCreditsFailure("Deploy did not reach a live serving state.")).toBe(false);
  });

  it("never tells anyone that a top-up is the only way out", () => {
    for (const copy of [BUILD_OUT_OF_CREDITS, BUILD_NO_CREDITS_TO_START]) {
      expect(copy).toMatch(/top up or upgrade/i);
    }
    expect(CHANGE_OUT_OF_CREDITS).not.toMatch(/top up/i);
  });

  it("a change refused for credits gets change copy, not build copy", () => {
    expect(changeFailureCopy("repair dispatch failed (insufficient_credits); last failure: insufficient_credits")).toBe(
      CHANGE_OUT_OF_CREDITS,
    );
    expect(CHANGE_OUT_OF_CREDITS).not.toMatch(/build|partway/i);
    expect(changeFailureCopy("The deploy timed out.")).toBeNull();
    expect(changeFailureCopy(null)).toBeNull();
  });

  it("maps spend-cap and provider-capacity failures", () => {
    expect(buildFailureCopy("halted: over_cap")).toBe(BUILD_OVER_BUDGET);
    expect(buildFailureCopy("budget_halted")).toBe(BUILD_OVER_BUDGET);
    expect(buildFailureCopy("provider_capacity: 529 overloaded")).toBe(BUILD_PROVIDER_BUSY);
    expect(buildFailureCopy("Claude Code returned an error result: API Error: 429 rate_limit_error")).toBe(BUILD_PROVIDER_BUSY);
  });

  it("never shows raw pipeline text: the QA error and any unknown reason get the generic line", () => {
    for (const raw of [
      "onSiteSandboxReady: the running preview could not be stopped (exit 1)",
      'Stage "build" finished but no code reached the provisioned repo (Praxis-build/mohit-93bd8436) after 10 min.',
      "Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has been revoked",
      "Deploy did not reach a live serving state.",
      "Login form rejected a valid password",
    ]) {
      expect(buildFailureCopy(raw)).toBe(BUILD_INTERNAL_FAILURE);
    }
  });

  it("handles null/undefined/empty without inventing a failure", () => {
    expect(buildFailureCopy(null)).toBeNull();
    expect(buildFailureCopy(undefined)).toBeNull();
    expect(buildFailureCopy("")).toBeNull();
  });
});

describe("setup failure copy written by the backend", () => {
  it.each([
    "Couldn't set up your site's code project, so this build couldn't start. Start a new build in a few minutes. If it keeps happening, contact support.",
    "Couldn't set up your site's hosting, so this build couldn't start. Start a new build in a few minutes. If it keeps happening, contact support.",
    "Couldn't set up your site's hosting. No changes were published. Retry.",
    "Couldn't set up your site's database. No changes were published. Retry.",
  ])("reaches the founder word for word, not as the generic internal-failure line: %s", (copy) => {
    expect(buildFailureCopy(copy)).toBe(copy);
    expect(buildFailureCopy(`app_database_setup_failed: ${copy}`)).toBe(copy);
  });
});

describe("buildFailureLine: the /build-status failure block", () => {
  it("a body with a founder code is shown as the server sent it", () => {
    expect(buildFailureLine({ class: "deploy_failed", code: "publish_failed", message: BUILD_PUBLISH_FAILED })).toBe(
      BUILD_PUBLISH_FAILED,
    );
  });

  it("an older body (no code) is mapped by class, never shown raw", () => {
    expect(buildFailureLine({ class: "deploy_failed", message: "render deploy dep-123 failed: exit 1" })).toBe(
      BUILD_PUBLISH_FAILED,
    );
    expect(
      buildFailureLine({ class: "stage_failed", message: "onSiteSandboxReady: the running preview could not be stopped (exit 1)" }),
    ).toBe(BUILD_INTERNAL_FAILURE);
  });

  it("no failure, no line", () => {
    expect(buildFailureLine(null)).toBeNull();
  });

  it("knows a credits stop by its code, or by the raw text of an older body", () => {
    expect(isOutOfCreditsBuild({ code: "out_of_credits", message: BUILD_OUT_OF_CREDITS })).toBe(true);
    expect(isOutOfCreditsBuild({ code: "internal", message: "insufficient_credits" })).toBe(false);
    expect(isOutOfCreditsBuild({ message: "repair dispatch failed (insufficient_credits)" })).toBe(true);
    expect(isOutOfCreditsBuild(null)).toBe(false);
  });
});

describe("stageErrorLine", () => {
  it("shows founder lines as sent and maps a raw stage error", () => {
    expect(stageErrorLine(BUILD_STAGE_RETRYING)).toBe(BUILD_STAGE_RETRYING);
    expect(stageErrorLine(BUILD_PUBLISH_FAILED)).toBe(BUILD_PUBLISH_FAILED);
    expect(stageErrorLine("npm run build exited 1")).toBe(BUILD_INTERNAL_FAILURE);
    expect(stageErrorLine(null)).toBeNull();
  });
});

describe("BUILD_OVER_BUDGET copy", () => {
  it("names the safety limit and never points at a control that does not exist", () => {
    expect(BUILD_OVER_BUDGET).toBe(
      "This build stopped at its safety limit before it finished. Nothing further will be charged. Start it again to continue.",
    );
    expect(BUILD_OVER_BUDGET).not.toMatch(/raise the build limit/);
  });
});
