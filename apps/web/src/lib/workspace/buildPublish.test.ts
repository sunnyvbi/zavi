import { describe, expect, it } from "vitest";
import { BUILD_CHECKS_FAILED, BUILD_FIXES_EXHAUSTED, SITE_DATABASE_SLOW, SITE_DATABASE_WAITING, SITE_PUBLISH_PLATFORM_RETRY } from "@zavi/shared";
import { buildPublishesOnRequest, publishRequestStillPending, publishWentLive, readBuildPublish, type PublishWatch } from "./buildPublish";

describe("readBuildPublish: a founder never sees the pipeline's raw text", () => {
  const failed = (reason: string) => readBuildPublish({ status: "failed", started_at: null, url: null, retryable: false, reason });

  it("keeps a founder line the server sent", () => {
    expect(failed(BUILD_CHECKS_FAILED).reason).toBe(BUILD_CHECKS_FAILED);
    expect(readBuildPublish({ status: "publishing", fixing: true, reason: BUILD_FIXES_EXHAUSTED }).reason).toBe(BUILD_FIXES_EXHAUSTED);
  });

  it("a publish waiting for a site database keeps the founder line; never the raw shard error", () => {
    expect(readBuildPublish({ status: "publishing", waiting: true, reason: SITE_DATABASE_WAITING })).toMatchObject({
      status: "publishing",
      waiting: true,
      reason: SITE_DATABASE_WAITING,
    });
    const raw = readBuildPublish({ status: "publishing", waiting: true, reason: "no shard capacity in prod" });
    expect(raw.waiting).toBe(true);
    expect("reason" in raw).toBe(false);
    expect("waiting" in readBuildPublish({ status: "failed", waiting: true, reason: SITE_DATABASE_SLOW })).toBe(false);
    expect(failed(SITE_DATABASE_SLOW).reason).toBe(SITE_DATABASE_SLOW);
  });

  it("a publish that kept hitting a platform problem shows our line (try again)", () => {
    expect(SITE_PUBLISH_PLATFORM_RETRY).toMatch(/temporary problem on our side/);
    expect(failed(SITE_PUBLISH_PLATFORM_RETRY).reason).toBe(SITE_PUBLISH_PLATFORM_RETRY);
  });

  it("drops a raw signal from an older server, so the surface's own line shows", () => {
    for (const raw of [
      "The site's smoke check failed: journey checkout returned 500",
      "Publishing kept failing: pooled backend unavailable: shard naqobauofmyxxixfcwwm lacks schema 0011_site_publish_fence",
      "Site hosting is not configured.",
    ]) {
      expect("reason" in failed(raw)).toBe(false);
      expect("reason" in readBuildPublish({ status: "publishing", fixing: true, reason: raw })).toBe(false);
    }
  });
});

const watch = (over: Partial<PublishWatch> = {}): PublishWatch => ({
  runId: "run-1",
  runStatus: "active",
  appReady: false,
  publishStatus: "none",
  ...over,
});

describe("publish on request: a finished build is not a live site", () => {
  it("a build that ends done without publishing never reports went live", () => {
    const ready = watch({ appReady: true });
    const done = watch({ runStatus: "done", publishStatus: "none" });
    expect(publishWentLive(ready, done, true)).toBe(false);
    expect(publishWentLive(watch(), done, true)).toBe(false);
    expect(publishWentLive(done, done, true)).toBe(false);
  });

  it("a later publish of that done run reports went live exactly on the publishing to live edge", () => {
    const done = watch({ runStatus: "done" });
    const publishing = watch({ runStatus: "done", publishStatus: "publishing" });
    const live = watch({ runStatus: "done", publishStatus: "live" });
    expect(publishWentLive(done, publishing, true)).toBe(false);
    expect(publishWentLive(publishing, publishing, true)).toBe(false);
    expect(publishWentLive(publishing, live, true)).toBe(true);
    expect(publishWentLive(live, live, true)).toBe(false);
  });

  it("a publish that lands between two polls still reports went live", () => {
    expect(publishWentLive(watch({ runStatus: "done" }), watch({ runStatus: "done", publishStatus: "live" }), true)).toBe(true);
  });

  it("a failed publish, a first read and another run never report went live", () => {
    const publishing = watch({ runStatus: "done", publishStatus: "publishing" });
    expect(publishWentLive(publishing, watch({ runStatus: "done", publishStatus: "failed" }), true)).toBe(false);
    expect(publishWentLive(null, watch({ runStatus: "done", publishStatus: "live" }), true)).toBe(false);
    expect(publishWentLive(publishing, watch({ runId: "run-2", runStatus: "done", publishStatus: "live" }), true)).toBe(false);
  });

  it("with the setting off a build that finishes after publishing still reports went live once", () => {
    const publishing = watch({ appReady: true, publishStatus: "publishing" });
    const done = watch({ runStatus: "done", publishStatus: "live" });
    expect(publishWentLive(publishing, done)).toBe(true);
    expect(publishWentLive(done, done)).toBe(false);
    expect(publishWentLive(watch({ appReady: true }), watch({ runStatus: "done" }))).toBe(true);
  });
});

describe("publish on request: the real status payload (app_ready true while unpublished)", () => {
  const builtUnpublished = watch({ runStatus: "done", appReady: true, publishStatus: "none" });

  it("a build finishing as done, app ready, publish none is never reported as went live", () => {
    expect(publishWentLive(watch(), builtUnpublished, true)).toBe(false);
    expect(publishWentLive(watch({ appReady: true }), builtUnpublished, true)).toBe(false);
    expect(publishWentLive(builtUnpublished, builtUnpublished, true)).toBe(false);
  });

  it("the same run going none, publishing, live reports went live once, when app ready drops and publish is live", () => {
    const publishing = watch({ runStatus: "done", appReady: true, publishStatus: "publishing" });
    const live = watch({ runStatus: "done", appReady: false, publishStatus: "live" });
    expect(publishWentLive(builtUnpublished, publishing, true)).toBe(false);
    expect(publishWentLive(publishing, live, true)).toBe(true);
    expect(publishWentLive(live, live, true)).toBe(false);
    expect(publishWentLive(publishing, watch({ runStatus: "done", appReady: true, publishStatus: "failed" }), true)).toBe(false);
  });
});

describe("publish on request: telling a new attempt from the failure that was already on screen", () => {
  const OLD = "2026-10-02T09:00:00Z";
  const NEW = "2026-10-02T09:05:00Z";

  it("keeps waiting while the status still shows nothing or the old failure", () => {
    expect(publishRequestStillPending("none", null, null)).toBe(true);
    expect(publishRequestStillPending("failed", OLD, OLD)).toBe(true);
  });

  it("stops waiting once the attempt is seen publishing or live", () => {
    expect(publishRequestStillPending("publishing", NEW, OLD)).toBe(false);
    expect(publishRequestStillPending("live", NEW, null)).toBe(false);
  });

  it("a failure with a new start time is the new attempt failing, even if publishing was never seen", () => {
    expect(publishRequestStillPending("failed", NEW, OLD)).toBe(false);
    expect(publishRequestStillPending("failed", NEW, null)).toBe(false);
  });
});

describe("publish on request is read off the build, not only the setting", () => {
  const stages = (...names: string[]) => names.map((stage) => ({ stage }));

  it("a site run with no publish stage publishes on request whatever the setting says", () => {
    expect(buildPublishesOnRequest(stages("provision", "build"), false)).toBe(true);
    expect(buildPublishesOnRequest(stages("provision", "build"), true)).toBe(true);
  });

  it("a run that has a publish stage keeps today's behavior whatever the setting says", () => {
    expect(buildPublishesOnRequest(stages("provision", "build", "deploy"), true)).toBe(false);
    expect(buildPublishesOnRequest(stages("provision", "build", "deploy"), false)).toBe(false);
  });

  it("an earlier-builder run with no publish row still publishes on its own", () => {
    expect(buildPublishesOnRequest(stages("provision", "spec", "scaffold", "build"), true)).toBe(false);
    expect(buildPublishesOnRequest(stages("provision", "spec", "scaffold", "build", "qa"), false)).toBe(false);
  });

  it("before any stage is known the setting decides", () => {
    expect(buildPublishesOnRequest([], true)).toBe(true);
    expect(buildPublishesOnRequest([], false)).toBe(false);
  });
});
