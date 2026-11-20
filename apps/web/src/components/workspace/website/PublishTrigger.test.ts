import { describe, expect, it, vi } from "vitest";

vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var" } }));

import { publishTriggerMode, siteAwaitingFirstBuild, siteNeverPublished, sitePublishOnRequest } from "./PublishTrigger";
import { deriveBuildSteps } from "../build/BuildModePane";
import { readBuildPublish } from "@/lib/workspace/buildPublish";
import { BUILD_CHECKS_FAILED, BUILD_FIXES_EXHAUSTED } from "@zavi/shared";

describe("Publish stays off until a real build exists (B25)", () => {
  const site = (status: string, liveUrl: string | null = null) => ({ status, liveUrl });

  it("a new site with only the starter (build not done, never live) cannot be published", () => {
    expect(siteAwaitingFirstBuild(site("building"), false, "none")).toBe(true);
    expect(publishTriggerMode(false, "none", false, true)).toBe("waiting");
  });

  it("once the app is built, or the site was ever live, Publish is on", () => {
    expect(siteAwaitingFirstBuild(site("publishing"), true, "publishing")).toBe(false);
    expect(siteAwaitingFirstBuild(site("live", "https://a.zaviagent.com"), false, "live")).toBe(false);
    expect(siteAwaitingFirstBuild(site("live"), false, "live")).toBe(false);
    expect(siteAwaitingFirstBuild(site("paused"), false, "none")).toBe(false);
    expect(siteAwaitingFirstBuild(null, false, "none")).toBe(false);
  });

  it("publishing and retry still win over not_built", () => {
    expect(publishTriggerMode(true, "publishing", false, true)).toBe("publishing");
    expect(publishTriggerMode(true, "failed", true, false)).toBe("retry");
    expect(publishTriggerMode(undefined, "none", false, false)).toBe("publish");
  });
});

describe("publish on request: a built, never-published site gets a working Publish", () => {
  const site = (status: string, liveUrl: string | null = null) => ({ status, liveUrl });
  const mode = (
    on: boolean,
    s: { status: string; liveUrl: string | null },
    runStatus: string,
    appReady: boolean,
    publishStatus: "none" | "publishing" | "live" | "failed",
    canRetry = false,
  ) =>
    publishTriggerMode(
      appReady,
      publishStatus,
      canRetry,
      siteAwaitingFirstBuild(s, appReady, publishStatus),
      sitePublishOnRequest(on, s, runStatus) === "ready",
    );

  it("a done build of a never-published site is an enabled Publish, not waiting forever", () => {
    expect(mode(true, site("building"), "done", false, "none")).toBe("publish");
    expect(mode(true, site("building"), "done", true, "none")).toBe("publish");
  });

  it("with the setting off the same site stays waiting", () => {
    expect(mode(false, site("building"), "done", false, "none")).toBe("waiting");
  });

  it("the build itself still waits, and publishing still shows as publishing", () => {
    expect(mode(true, site("building"), "active", false, "none")).toBe("waiting");
    expect(sitePublishOnRequest(true, site("building"), "active")).toBe("building");
    expect(mode(true, site("publishing"), "done", false, "publishing")).toBe("publishing");
    expect(mode(true, site("publishing"), "done", true, "publishing")).toBe("publishing");
  });

  it("a failed publish of a done build offers Publish again, never a dead waiting button or a run retry", () => {
    expect(mode(true, site("building"), "done", false, "failed")).toBe("publish");
    expect(mode(true, site("failed"), "done", true, "failed", true)).toBe("publish");
    expect(mode(true, site("building"), "done", true, "failed", false)).toBe("publish");
  });

  it("a site that was ever published is not on the publish-on-request path", () => {
    expect(sitePublishOnRequest(true, site("live", "https://a.zaviagent.com"), "done")).toBeNull();
    expect(sitePublishOnRequest(true, site("live"), "done")).toBeNull();
    expect(sitePublishOnRequest(true, site("paused"), "done")).toBeNull();
    expect(sitePublishOnRequest(true, null, "done")).toBeNull();
    expect(siteNeverPublished(site("building"))).toBe(true);
    expect(siteNeverPublished(site("waking"))).toBe(false);
  });

  it("a paused pre-setting run whose publish failed keeps Retry publish", () => {
    expect(mode(true, site("building"), "paused", true, "failed", true)).toBe("retry");
  });

  const stages = (...names: string[]) => names.map((stage) => ({ stage }));
  const modeFor = (
    setting: boolean,
    runStages: Array<{ stage: string }>,
    runStatus: string,
    appReady: boolean,
    publishStatus: "none" | "publishing" | "live" | "failed",
    canRetry = false,
  ) =>
    publishTriggerMode(
      appReady,
      publishStatus,
      canRetry,
      siteAwaitingFirstBuild(site("building"), appReady, publishStatus),
      sitePublishOnRequest(setting, site("building"), runStatus, runStages) === "ready",
    );

  it("setting off or missing: a done run with no publish stage and a never-published site still gets Publish", () => {
    expect(sitePublishOnRequest(false, site("building"), "done", stages("provision", "build"))).toBe("ready");
    expect(modeFor(false, stages("provision", "build"), "done", false, "none")).toBe("publish");
    expect(modeFor(false, stages("provision", "build"), "done", true, "none")).toBe("publish");
  });

  it("setting off with a publish stage present is exactly today's behavior", () => {
    const withDeploy = stages("provision", "build", "deploy");
    expect(sitePublishOnRequest(false, site("building"), "done", withDeploy)).toBeNull();
    expect(modeFor(false, withDeploy, "active", false, "none")).toBe("waiting");
    expect(modeFor(false, withDeploy, "active", true, "publishing")).toBe("publishing");
    expect(modeFor(false, withDeploy, "paused", true, "failed", true)).toBe("retry");
  });

  it("setting on with a publish stage present (a build started before it was turned on) keeps publishing and retry", () => {
    const withDeploy = stages("provision", "build", "deploy");
    expect(sitePublishOnRequest(true, site("building"), "active", withDeploy)).toBeNull();
    expect(sitePublishOnRequest(true, site("building"), "paused", withDeploy)).toBeNull();
    expect(modeFor(true, withDeploy, "active", false, "none")).toBe("waiting");
    expect(modeFor(true, withDeploy, "active", true, "publishing")).toBe("publishing");
    expect(modeFor(true, withDeploy, "paused", true, "failed", true)).toBe("retry");
  });
});

describe("publish on request: the build card has no publishing step", () => {
  const twoStage = [
    { stage: "provision", status: "done" },
    { stage: "build", status: "active" },
  ];

  it("a new site run shows two steps and never a publishing step", () => {
    const steps = deriveBuildSteps(twoStage, "active", "building", true);
    expect(steps.map((s) => s.key)).toEqual(["workspace", "interface"]);
    expect(steps.map((s) => s.label).join(" ")).not.toMatch(/publish/i);
    expect(steps[1]?.state).toBe("active");
  });

  it("the same run shows two steps with the setting off too, because its graph has no publish stage", () => {
    const steps = deriveBuildSteps(twoStage, "active", "building");
    expect(steps.map((s) => s.key)).toEqual(["workspace", "interface"]);
  });

  it("a run with a publish stage shows three steps, publishing last, with the setting off or on", () => {
    const threeStage = [...twoStage, { stage: "deploy", status: "pending" }];
    for (const setting of [false, true]) {
      const steps = deriveBuildSteps(threeStage, "active", "building", setting);
      expect(steps.map((s) => s.key)).toEqual(["workspace", "interface", "deploy"]);
      expect(steps[2]?.label).toBe("Publishing to your address");
    }
  });

  it("an earlier-builder run with no publish row keeps its publishing step with the setting on", () => {
    const old = ["provision", "spec", "scaffold", "build"].map((stage) => ({ stage, status: "done" }));
    expect(deriveBuildSteps(old, "active", "building", true).at(-1)?.key).toBe("deploy");
  });

  it("before any stage is known nothing promises publishing", () => {
    expect(deriveBuildSteps([], "provisioning", "building", true).some((s) => s.key === "deploy")).toBe(false);
    expect(deriveBuildSteps([], "provisioning", "building").some((s) => s.key === "deploy")).toBe(true);
  });

  it("both stages done with the run still closing shows no spinner on a finished step", () => {
    const done = twoStage.map((s) => ({ ...s, status: "done" }));
    expect(deriveBuildSteps(done, "active", "building", true).every((s) => s.state === "done")).toBe(true);
    expect(deriveBuildSteps(done, "done", "none", true).map((s) => s.state)).toEqual(["done", "done"]);
  });
});

describe("a stopped publish never keeps a spinner, and says why (B12/B19)", () => {
  it("a PAUSED run's failed deploy step shows failed, not active", () => {
    const steps = deriveBuildSteps(
      [
        { stage: "provision", status: "done" },
        { stage: "build", status: "done" },
        { stage: "deploy", status: "failed" },
      ],
      "paused",
      "building",
    );
    expect(steps.find((s) => s.key === "deploy")?.state).toBe("failed");
    expect(steps.some((s) => s.state === "active")).toBe(false);
  });

  it("reads the failure reason and the fix-in-progress flag from build-status", () => {
    expect(readBuildPublish({ status: "failed", retryable: true, reason: BUILD_CHECKS_FAILED })).toMatchObject({
      status: "failed",
      retryable: true,
      reason: BUILD_CHECKS_FAILED,
    });
    expect(readBuildPublish({ status: "publishing", fixing: true, reason: BUILD_FIXES_EXHAUSTED })).toMatchObject({
      status: "publishing",
      fixing: true,
      reason: BUILD_FIXES_EXHAUSTED,
    });
    expect(readBuildPublish({ status: "publishing", started_at: null, url: null })).toEqual({
      status: "publishing",
      startedAt: null,
      url: null,
      retryable: false,
    });
    expect(readBuildPublish({ status: "live", reason: "x" }).reason).toBeUndefined();
  });
});
