import { describe, it, expect } from "vitest";
import {
  buildStatusPath,
  MAX_SETTLE_TICKS,
  NO_PUBLISH,
  FAST_POLL_MS,
  SETTLE_POLL_MS,
  isTerminalBuildRun,
  pollDelayMs,
  readPreviewUrl,
  shouldKeepPolling,
  toBuildPreviewState,
  type BuildPreviewState,
} from "./useBuildPreview";

const BASE: BuildPreviewState = {
  loaded: false,
  building: false,
  runStatus: null,
  runId: null,
  objective: null,
  stages: [],
  createdAt: null,
  updatedAt: null,
  previewUrl: null,
  previewKind: "none",
  failure: null,
  appReady: false,
  publish: NO_PUBLISH,
  settledNonce: 0,
};

describe("isTerminalBuildRun", () => {
  it("treats every stopped conductor status as terminal", () => {
    for (const s of ["done", "failed", "halted", "cancelled", "canceled"]) {
      expect(isTerminalBuildRun(s)).toBe(true);
    }
  });

  it("treats in-flight and unknown statuses as still moving", () => {
    for (const s of ["active", "provisioning", "proposed", "something_new"]) {
      expect(isTerminalBuildRun(s)).toBe(false);
    }
    expect(isTerminalBuildRun(null)).toBe(false);
    expect(isTerminalBuildRun(undefined)).toBe(false);
  });
});

describe("readPreviewUrl — never frames an address the server didn't vouch for", () => {
  it("returns the url for every servable kind", () => {
    expect(
      readPreviewUrl({ url: "https://sbx.e2b.app", kind: "instant" }),
    ).toBe("https://sbx.e2b.app");
    expect(
      readPreviewUrl({ url: "https://a.onrender.com", kind: "early" }),
    ).toBe("https://a.onrender.com");
    expect(
      readPreviewUrl({ url: "https://a.onrender.com", kind: "final" }),
    ).toBe("https://a.onrender.com");
  });

  it("returns null for kind 'none' even if a url leaks through", () => {
    expect(
      readPreviewUrl({ url: "https://not-serving.example", kind: "none" }),
    ).toBeNull();
  });

  it("returns null for a missing/blank url or a missing block", () => {
    expect(readPreviewUrl({ url: null, kind: "early" })).toBeNull();
    expect(readPreviewUrl({ url: "", kind: "final" })).toBeNull();
    expect(readPreviewUrl(null)).toBeNull();
    expect(readPreviewUrl(undefined)).toBeNull();
  });
});

describe("shouldKeepPolling — bounded watch", () => {
  it("does not poll at all when the tenant has no build run", () => {
    expect(shouldKeepPolling(null, "none", 0)).toBe(false);
  });

  it("keeps polling while the run is in flight", () => {
    expect(shouldKeepPolling("active", "none", 0)).toBe(true);
    expect(shouldKeepPolling("active", "early", 99)).toBe(true);
  });

  it("stops immediately on a failed/halted/cancelled run — nothing more will move", () => {
    expect(shouldKeepPolling("failed", "none", 0)).toBe(false);
    expect(shouldKeepPolling("halted", "early", 0)).toBe(false);
    expect(shouldKeepPolling("cancelled", "none", 0)).toBe(false);
  });

  it("waits out the settle window on a done run whose host hasn't flipped ready", () => {
    expect(shouldKeepPolling("done", "early", 0)).toBe(true);
    expect(shouldKeepPolling("done", "none", MAX_SETTLE_TICKS - 1)).toBe(true);
  });

  it("caps the settle window so a stuck deploy can't poll forever", () => {
    expect(shouldKeepPolling("done", "none", MAX_SETTLE_TICKS)).toBe(false);
    expect(shouldKeepPolling("done", "none", MAX_SETTLE_TICKS + 50)).toBe(
      false,
    );
  });

  it("stops as soon as the shipped app is serving", () => {
    expect(shouldKeepPolling("done", "final", 0)).toBe(false);
  });
});

describe("pollDelayMs", () => {
  it("streams fast while building and backs off once terminal", () => {
    expect(pollDelayMs("active")).toBe(FAST_POLL_MS);
    expect(pollDelayMs(null)).toBe(FAST_POLL_MS);
    expect(pollDelayMs("done")).toBe(SETTLE_POLL_MS);
  });
});

describe("toBuildPreviewState", () => {
  it("reports building for an in-flight run and exposes its preview", () => {
    const next = toBuildPreviewState(
      {
        run: {
          id: "run-1",
          objective: "Build product: A customer portal",
          status: "active",
          created_at: "2026-07-27T10:00:00Z",
          stages: [{ stage: "build", status: "running" }],
        },
        preview: { url: "https://sbx.e2b.app", kind: "instant" },
      },
      BASE,
    );
    expect(next.building).toBe(true);
    expect(next.loaded).toBe(true);
    expect(next.previewUrl).toBe("https://sbx.e2b.app");
    expect(next.previewKind).toBe("instant");
    expect(next.stages).toHaveLength(1);
    expect(next.runId).toBe("run-1");
    expect(next.objective).toBe("Build product: A customer portal");
  });

  it("is not building when the tenant has never built anything", () => {
    const next = toBuildPreviewState({ run: null }, BASE);
    expect(next.building).toBe(false);
    expect(next.runStatus).toBeNull();
    expect(next.previewUrl).toBeNull();
    expect(next.loaded).toBe(true);
  });

  it("bumps settledNonce once on the in-flight → terminal edge", () => {
    const building = toBuildPreviewState(
      {
        run: { status: "active", stages: [] },
        preview: { url: null, kind: "none" },
      },
      BASE,
    );
    expect(building.settledNonce).toBe(0);

    const finished = toBuildPreviewState(
      {
        run: { status: "done", stages: [] },
        preview: { url: "https://app.onrender.com", kind: "final" },
      },
      building,
    );
    expect(finished.settledNonce).toBe(1);
    expect(finished.building).toBe(false);

    const settlePoll = toBuildPreviewState(
      {
        run: { status: "done", stages: [] },
        preview: { url: "https://app.onrender.com", kind: "final" },
      },
      finished,
    );
    expect(settlePoll.settledNonce).toBe(1);
  });

  it("does not bump settledNonce for a build that was already terminal on arrival", () => {
    const first = toBuildPreviewState(
      {
        run: { status: "done", stages: [] },
        preview: { url: "https://a.app", kind: "final" },
      },
      BASE,
    );
    expect(first.settledNonce).toBe(0);
  });

  it("bumps on a failed finish too, so the tab stops waiting on a dead build", () => {
    const building = toBuildPreviewState(
      { run: { status: "active", stages: [] } },
      BASE,
    );
    const failed = toBuildPreviewState(
      {
        run: {
          status: "failed",
          stages: [],
          failure: { message: "scaffold blew up" },
        },
      },
      building,
    );
    expect(failed.settledNonce).toBe(1);
    expect(failed.building).toBe(false);
    expect(failed.failure?.message).toBe("scaffold blew up");
  });
});

describe("previewCompiling", () => {
  it("is true only for a live sandbox preview the server reports as mid-compile", () => {
    const base = { run: { id: "r", status: "active", stages: [] } };
    expect(toBuildPreviewState({ ...base, preview: { url: "https://3000-x.e2b.app", kind: "instant", compiling: true } } as never, BASE).previewCompiling).toBe(true);
    expect(toBuildPreviewState({ ...base, preview: { url: "https://app.onrender.com", kind: "early", compiling: true } } as never, BASE).previewCompiling).toBe(false);
    expect(toBuildPreviewState({ ...base, preview: { url: "https://3000-x.e2b.app", kind: "instant" } } as never, BASE).previewCompiling).toBe(false);
  });
});

describe("app ready before publish", () => {
  const publishing = { status: "publishing", started_at: "2026-09-29T10:00:00Z", url: "https://bakery.onrender.com" };
  const tick = (status: string, appReady: boolean, publish: Record<string, unknown> | undefined, prev: BuildPreviewState) =>
    toBuildPreviewState({ run: { id: "run-1", status, stages: [] }, app_ready: appReady, publish } as never, prev);

  it("settles once when the app turns ready and never again when publishing goes live", () => {
    const building = tick("active", false, { status: "none", started_at: null, url: null }, BASE);
    const ready = tick("active", true, publishing, building);
    expect(ready.settledNonce).toBe(1);
    expect(ready.building).toBe(true);
    expect(ready.appReady).toBe(true);
    expect(ready.publish).toEqual({ status: "publishing", startedAt: "2026-09-29T10:00:00Z", url: "https://bakery.onrender.com", retryable: false });
    const still = tick("active", true, publishing, ready);
    expect(still.settledNonce).toBe(1);
    const live = tick("done", false, { status: "live", started_at: null, url: "https://bakery.com" }, still);
    expect(live.settledNonce).toBe(1);
    expect(live.publish.status).toBe("live");
    const failed = tick("paused", true, { ...publishing, status: "failed" }, still);
    expect(failed.settledNonce).toBe(1);
  });

  it("does not settle on a cold open that lands mid-publish", () => {
    const cold = tick("active", true, publishing, BASE);
    expect(cold.settledNonce).toBe(0);
    expect(tick("done", false, { status: "live", started_at: null, url: "https://b.com" }, cold).settledNonce).toBe(0);
  });

  it("keeps polling while publishing even if the run already reads terminal", () => {
    expect(shouldKeepPolling("done", "final", 0, "publishing")).toBe(true);
    expect(shouldKeepPolling("paused", "instant", 0, "publishing")).toBe(true);
    expect(shouldKeepPolling("done", "final", 0, "live")).toBe(false);
    expect(shouldKeepPolling("paused", "instant", 0, "failed")).toBe(false);
  });

  it("drops an unknown publish status to none", () => {
    expect(tick("active", false, { status: "bogus" }, BASE).publish.status).toBe("none");
    expect(tick("active", false, undefined, BASE).publish).toEqual(NO_PUBLISH);
  });

  it("marks a failed publish retryable only when the server says Continue would take it", () => {
    const failed = { status: "failed", started_at: null, url: null };
    expect(tick("paused", true, { ...failed, retryable: true }, BASE).publish.retryable).toBe(true);
    expect(tick("paused", true, { ...failed, retryable: false }, BASE).publish.retryable).toBe(false);
    expect(tick("failed", true, failed, BASE).publish.retryable).toBe(false);
    expect(tick("active", true, { ...publishing, retryable: true }, BASE).publish.retryable).toBe(false);
  });
});

describe("new-flow site sessions", () => {
  it("exposes the run's own site block (url, repo, status) so the pane never falls back to tenant hosting", () => {
    const next = toBuildPreviewState(
      {
        run: { id: "run-s", status: "failed", stages: [{ stage: "build", status: "failed" }] },
        preview: { url: null, kind: "none" },
        site: {
          id: "4e697436-edc6-4e18-9d92-17adccbf898f",
          hostname: "dog-grooming-693dfbdb-4e6974.zaviagent.com",
          status: "failed",
          live_url: null,
          admin_url: "https://dog-grooming-693dfbdb-4e6974.zaviagent.com/admin",
          repo_url: "https://github.com/Zavi-Latest-Build/dog-grooming-693dfbdb-4e6974",
        },
      },
      BASE,
    );
    expect(next.site).toEqual({
      id: "4e697436-edc6-4e18-9d92-17adccbf898f",
      status: "failed",
      liveUrl: null,
      repoUrl: "https://github.com/Zavi-Latest-Build/dog-grooming-693dfbdb-4e6974",
      publishFailed: false,
      unpublished: null,
    });
  });

  it("is null for an old-flow run (no site block) and ignores a malformed block", () => {
    expect(toBuildPreviewState({ run: { id: "r", status: "active" } }, BASE).site).toBeNull();
    expect(
      toBuildPreviewState({ run: { id: "r", status: "active" }, site: { live_url: "https://x" } as never }, BASE).site,
    ).toBeNull();
    const evil = toBuildPreviewState(
      { run: { id: "r", status: "done" }, site: { id: "s1", status: "live", live_url: "javascript:alert(1)", repo_url: "http://x" } },
      BASE,
    );
    expect(evil.site).toEqual({ id: "s1", status: "live", liveUrl: null, repoUrl: null, publishFailed: false, unpublished: null });
  });
});

describe("buildStatusPath scope (many sites per workspace)", () => {
  it("a session reads its own run; the workspace surface reads only the workspace app", () => {
    expect(buildStatusPath("r-1")).toBe("/api/workspace/autopilot/build-status?run_id=r-1");
    expect(buildStatusPath("r-1", "workspace")).toBe("/api/workspace/autopilot/build-status?run_id=r-1");
    expect(buildStatusPath(null, "workspace")).toBe("/api/workspace/autopilot/build-status?app=workspace");
    expect(buildStatusPath(null)).toBe("/api/workspace/autopilot/build-status");
  });
});

describe("toBuildPreviewState reads whether a finished build's preview is gone", () => {
  const done = { run: { id: "r1", status: "done", stages: [] }, preview: { url: null, kind: "none" as const } };

  it.each(["stopped", "starting"] as const)("keeps %s", (state) => {
    expect(toBuildPreviewState({ ...done, preview_state: state }, BASE).previewState).toBe(state);
  });

  it.each([undefined, null, "live", 1, { state: "stopped" }])("drops anything else (%s)", (state) => {
    expect(toBuildPreviewState({ ...done, preview_state: state }, BASE).previewState).toBeNull();
  });
});
