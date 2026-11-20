import { describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { canRetryFailedBuild, canStopBuild } from "./BuildModePane";

const NOW = Date.parse("2026-09-30T08:00:00Z");
const failedRun = {
  status: "failed",
  updatedAt: "2026-09-30T07:39:09Z",
  stages: [
    { stage: "spec", status: "done" },
    { stage: "scaffold", status: "failed" },
  ],
  failure: {
    class: "stage_failed",
    message: "app_database_setup_failed: Couldn't set up your site's database. No changes were published. Retry.",
  },
};
const base = { loaded: true, isCurrent: true, retired: false, appReady: false, run: failedRun };

describe("canRetryFailedBuild", () => {
  it("offers a retry for a crashed build, the Cake Studio case", () => {
    expect(canRetryFailedBuild(base, NOW)).toBe(true);
  });

  it("still offers it just inside the 7-day window", () => {
    expect(canRetryFailedBuild({ ...base, run: { ...failedRun, updatedAt: "2026-09-23T08:01:00Z" } }, NOW)).toBe(true);
  });

  it("offers it when the failed step is one the status payload does not list, like qa or deploy", () => {
    const runWithStages = { ...failedRun, stages: [{ stage: "build", status: "done" }] };
    expect(canRetryFailedBuild({ ...base, run: runWithStages }, NOW)).toBe(true);
  });

  it("offers a retry for a paused build", () => {
    expect(canRetryFailedBuild({ ...base, run: { status: "paused", failure: null } }, NOW)).toBe(true);
  });

  it.each([
    ["not loaded", { ...base, loaded: false }],
    ["no run", { ...base, run: null }],
    ["superseded", { ...base, isCurrent: false }],
    ["retired", { ...base, retired: true }],
    ["app already ready", { ...base, appReady: true }],
    ["running", { ...base, run: { status: "active", failure: null } }],
    ["done", { ...base, run: { status: "done", failure: null } }],
    ["stopped by the founder", { ...base, run: { ...failedRun, failure: { class: "user_cancelled" } } }],
    ["reaped as stale", { ...base, run: { ...failedRun, failure: { class: "stale_reaped" } } }],
    ["cancelled", { ...base, run: { status: "cancelled", failure: null } }],
    ["it failed more than 7 days ago, which the server refuses as expired", { ...base, run: { ...failedRun, updatedAt: "2026-09-23T07:59:00Z" } }],
    ["the failure time is unknown", { ...base, run: { ...failedRun, updatedAt: null } }],
    ["hosting failed at setup, which the server refuses to continue", { ...base, run: { ...failedRun, failure: { class: "stage_failed", stage: "provision", message: "Couldn't set up your site's hosting, so this build couldn't start. Start a new build in a few minutes. If it keeps happening, contact support." } } }],
    ["a coach run took precedence", { ...base, run: { ...failedRun, failure: { class: "coach_precedence" } } }],
  ])("hides it when %s", (_label, session) => {
    expect(canRetryFailedBuild(session, NOW)).toBe(false);
  });

  it("hides it when the wallet ran dry, since a retry would only be refused", () => {
    const run = {
      status: "failed",
      failure: { class: "stage_failed", message: "repair dispatch failed (insufficient_credits)" },
    };
    expect(canRetryFailedBuild({ ...base, run: { ...failedRun, ...run } }, NOW)).toBe(false);
  });
});

describe("canStopBuild", () => {
  const running = { loaded: true, isCurrent: true, retired: false, appReady: false, run: { status: "active" } };

  it("offers Stop while the build is constructing, the Cake Studio retry case", () => {
    expect(canStopBuild(running)).toBe(true);
    expect(canStopBuild({ ...running, run: { status: "queued" } })).toBe(true);
  });

  it.each([
    ["not loaded", { ...running, loaded: false }],
    ["no run", { ...running, run: null }],
    ["superseded", { ...running, isCurrent: false }],
    ["retired", { ...running, retired: true }],
    ["the app is already ready in the preview", { ...running, appReady: true }],
    ["done", { ...running, run: { status: "done" } }],
    ["failed", { ...running, run: { status: "failed" } }],
    ["paused", { ...running, run: { status: "paused" } }],
    ["cancelled", { ...running, run: { status: "cancelled" } }],
  ])("hides Stop when %s", (_label, session) => {
    expect(canStopBuild(session)).toBe(false);
  });

  it("never offers Stop and Retry for the same build at once", () => {
    for (const status of ["active", "queued", "failed", "paused", "done", "cancelled"]) {
      const session = { ...running, run: { ...failedRun, status } };
      expect(canStopBuild(session) && canRetryFailedBuild(session, NOW)).toBe(false);
    }
  });
});
