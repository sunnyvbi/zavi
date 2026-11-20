import { describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import {
  STAGE_TO_STEP_KEY,
  STEP_LABELS,
  buildProjectName,
  deriveBuildSteps,
} from "./BuildModePane";

const PIPELINE_STAGES = ["provision", "spec", "scaffold", "build", "qa", "deploy"];

describe("deriveBuildSteps", () => {
  it("shows one active milestone while a build is moving", () => {
    const steps = deriveBuildSteps(
      [
        { stage: "provision", status: "done" },
        { stage: "spec", status: "done" },
        { stage: "scaffold", status: "done" },
        { stage: "build", status: "running" },
        { stage: "qa", status: "queued" },
      ],
      "active",
      "building",
    );

    expect(steps.map((step) => step.state)).toEqual([
      "done",
      "done",
      "done",
      "active",
      "pending",
      "pending",
    ]);
  });

  it("maps every visible step to exactly one real pipeline stage", () => {
    const stepKeys = STEP_LABELS.map(([key]) => key);
    const mapped = Object.entries(STAGE_TO_STEP_KEY);
    expect(mapped.map(([stage]) => stage).sort()).toEqual([...PIPELINE_STAGES].sort());
    expect([...mapped.map(([, key]) => key)].sort()).toEqual([...stepKeys].sort());
    expect(new Set(mapped.map(([, key]) => key)).size).toBe(mapped.length);
    expect(STEP_LABELS.map(([, label]) => label)).not.toContain("Adding components");
    expect(STEP_LABELS.map(([, label]) => label)).not.toContain("Applying styles");
    expect(STEP_LABELS.map(([, label]) => label)).not.toContain("Deploying");
    expect(STEP_LABELS.at(-1)).toEqual(["deploy", "Publishing to your address"]);
  });

  it.each([
    ["with qa and a deploy row", PIPELINE_STAGES],
    ["with qa and no deploy row", PIPELINE_STAGES.filter((s) => s !== "deploy")],
    ["without qa", PIPELINE_STAGES.filter((s) => s !== "qa" && s !== "deploy")],
  ])("ticks at most one step per stage transition %s", (_name, pipeline) => {
    const snapshot = (current: number, currentStatus: string) =>
      pipeline.map((stage, index) => ({
        stage,
        status: index < current ? "done" : index === current ? currentStatus : "queued",
      }));
    const doneCount = (rows: ReturnType<typeof snapshot>) =>
      deriveBuildSteps(rows, "active", "building").filter((s) => s.state === "done").length;
    const activeKey = (rows: ReturnType<typeof snapshot>) =>
      deriveBuildSteps(rows, "active", "building").find((s) => s.state === "active")?.key;

    let previous = doneCount(snapshot(0, "running"));
    expect(previous).toBe(0);
    for (let current = 1; current <= pipeline.length; current += 1) {
      const rows = snapshot(current, "running");
      const done = doneCount(rows);
      expect(done - previous).toBeLessThanOrEqual(1);
      expect(done).toBeGreaterThanOrEqual(previous);
      if (current < pipeline.length) {
        expect(activeKey(rows)).toBe(STAGE_TO_STEP_KEY[pipeline[current]]);
      } else {
        expect(activeKey(rows)).toBe("deploy");
      }
      previous = done;
    }
  });

  it("lists only milestones that map to a real backend stage", () => {
    const steps = deriveBuildSteps([], null, "none");
    expect(steps.map((step) => step.key)).toEqual(["workspace", "interface", "deploy"]);
  });

  it("never shows a Checking your app step a build without qa can only skip", () => {
    const stages = [
      { stage: "provision", status: "done" },
      { stage: "spec", status: "done" },
      { stage: "scaffold", status: "done" },
      { stage: "build", status: "running" },
    ];
    const building = deriveBuildSteps(stages, "active", "building");
    expect(building.map((step) => [step.key, step.state])).toEqual([
      ["workspace", "done"],
      ["understanding", "done"],
      ["structure", "done"],
      ["interface", "active"],
      ["deploy", "pending"],
    ]);

    const deploying = deriveBuildSteps(
      stages.map((stage) => ({ ...stage, status: "done" })),
      "active",
      "building",
    );
    expect(deploying.map((step) => [step.key, step.state])).toEqual([
      ["workspace", "done"],
      ["understanding", "done"],
      ["structure", "done"],
      ["interface", "done"],
      ["deploy", "active"],
    ]);

    expect(
      deriveBuildSteps(stages, "done", "building").map((step) => step.key),
    ).not.toContain("checks");
  });

  it("moves straight from the interface to the checks when qa starts", () => {
    const steps = deriveBuildSteps(
      [
        { stage: "provision", status: "done" },
        { stage: "spec", status: "done" },
        { stage: "scaffold", status: "done" },
        { stage: "build", status: "done" },
        { stage: "qa", status: "running" },
      ],
      "active",
      "building",
    );
    expect(steps.map((step) => step.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "active",
      "pending",
    ]);
  });

  it("shows provisioning as its own milestone before the spec starts", () => {
    const steps = deriveBuildSteps(
      [
        { stage: "provision", status: "running" },
        { stage: "spec", status: "queued" },
      ],
      "active",
      "building",
    );
    expect(steps[0]).toMatchObject({ key: "workspace", state: "active" });
    expect(steps[1]).toMatchObject({ key: "understanding", state: "pending" });
  });

  it("moves to Understanding once provisioning is done and the spec is dispatched", () => {
    const steps = deriveBuildSteps(
      [
        { stage: "provision", status: "done" },
        { stage: "spec", status: "dispatched" },
        { stage: "scaffold", status: "pending" },
      ],
      "active",
      "building",
    );
    expect(steps[0].state).toBe("done");
    expect(steps[1]).toMatchObject({ key: "understanding", state: "active" });
    expect(steps.slice(2).every((step) => step.state === "pending")).toBe(true);
  });

  it("marks every milestone complete when the app is live", () => {
    const steps = deriveBuildSteps([], "done", "live");
    expect(steps.every((step) => step.state === "done")).toBe(true);
  });

  it("places a failed deploy at the final milestone", () => {
    const steps = deriveBuildSteps(
      [
        { stage: "provision", status: "done" },
        { stage: "spec", status: "done" },
        { stage: "scaffold", status: "done" },
        { stage: "build", status: "done" },
        { stage: "qa", status: "done" },
      ],
      "failed",
      "failed",
    );
    expect(steps.at(-1)?.state).toBe("failed");
  });
});

describe("activityFooter", () => {
  it("never says a stopped build was 'stopped for' its whole run time", async () => {
    const { activityFooter } = await import("./BuildModePane");
    expect(activityFooter("failed", false, 3211)).toBe(
      "Ran 53m 31s before stopping",
    );
    expect(activityFooter("failed", false, 3211, true)).toBe(
      "Ran 53m 31s before failing",
    );
    expect(activityFooter("failed", true, 90)).toBe("Paused after 1m 30s");
    expect(activityFooter("failed", true, 90, true)).toBe("Paused after 1m 30s");
    expect(activityFooter("ready", false, 1314)).toBe("Built in 21m 54s");
    expect(activityFooter("building", false, 45)).toBe("Working for 45s");
  });
});

describe("buildProjectName", () => {
  it("creates a short readable slug from the build objective", () => {
    expect(
      buildProjectName(
        "Build product: A cool portfolio for a product designer with case studies",
        "Praxis",
      ),
    ).toBe("a-cool-portfolio-for-a-product");
  });

  it("falls back to the tenant name", () => {
    expect(buildProjectName(null, "Acme Studio")).toBe("acme-studio-app");
  });
});

describe("friendlyFailure", () => {
  it("keeps a short plain reason and replaces a raw plan dump with a friendly line", async () => {
    const { friendlyFailure } = await import("./BuildModePane");
    expect(friendlyFailure("The deploy timed out.")).toBe(
      "The deploy timed out.",
    );
    expect(
      friendlyFailure(
        "## Plan Swap the SVG car silhouette\n## Files - `lib/brand.ts`",
      ),
    ).toMatch(/^Something went wrong/);
    expect(friendlyFailure(null)).toMatch(/^Something went wrong/);
    expect(friendlyFailure("x".repeat(400))).toMatch(/^Something went wrong/);
  });
});

describe("buildLoadErrorCopy", () => {
  it("turns a bare browser transport error into actionable build copy", async () => {
    const { buildLoadErrorCopy } = await import("./BuildModePane");
    expect(buildLoadErrorCopy("Failed to fetch")).toBe(
      "We couldn't load this build. Check your connection, then try again.",
    );
    expect(
      buildLoadErrorCopy("Couldn't reach the build service (HTTP 503)."),
    ).toBe("Couldn't reach the build service (HTTP 503).");
  });
});

describe("changeProgressDetail", () => {
  it("shows only the real elapsed time when there is nothing to estimate from", async () => {
    const { changeProgressDetail } = await import("./BuildModePane");
    expect(changeProgressDetail(185)).toBe("3m 5s elapsed");
    expect(changeProgressDetail(16, null)).toBe("16s elapsed");
  });

  it("compares with the founder's own recent changes, and says when this one runs long", async () => {
    const { changeProgressDetail } = await import("./BuildModePane");
    expect(changeProgressDetail(20, 95)).toBe("20s elapsed · Your recent changes took about 2 minutes");
    expect(changeProgressDetail(10, 40)).toBe("10s elapsed · Your recent changes took under a minute");
    expect(changeProgressDetail(150, 95)).toBe("2m 30s elapsed · Taking longer than your recent changes");
    expect(changeProgressDetail(140, 95)).toBe("2m 20s elapsed · Your recent changes took about 2 minutes");
    expect(changeProgressDetail(50, 30)).toBe("50s elapsed · Your recent changes took under a minute");
  });
});

describe("typicalChangeSeconds", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 6, 6, 0, s)).toISOString();
  const change = (id: string, secs: number, extra: Record<string, unknown> = {}) => ({
    id,
    message: "m",
    status: "done",
    created_at: at(0),
    finished_at: at(secs),
    ...extra,
  });

  it("is the median of the last five finished changes", async () => {
    const { typicalChangeSeconds } = await import("./BuildModePane");
    const refines = [change("a", 900), change("b", 60), change("c", 80), change("d", 100), change("e", 70), change("f", 400)];
    expect(typicalChangeSeconds(refines as never)).toBe(80);
  });

  it("needs two real samples, and ignores running, failed, undo and restore turns", async () => {
    const { typicalChangeSeconds } = await import("./BuildModePane");
    expect(typicalChangeSeconds([change("a", 60)] as never)).toBeNull();
    expect(
      typicalChangeSeconds([
        change("a", 60),
        change("b", 30, { status: "failed" }),
        change("c", 30, { status: "running", finished_at: null }),
        change("d", 30, { kind: "undo" }),
        change("e", 30, { kind: "restore" }),
      ] as never),
    ).toBeNull();
    expect(typicalChangeSeconds([change("a", 60), change("b", 120, { kind: "change" })] as never)).toBe(90);
  });
});

describe("preview links", () => {
  it("allows only http(s) destinations", async () => {
    const { safePreviewHref } = await import("./BuildModePane");
    expect(safePreviewHref("https://app.example/path")).toBe(
      "https://app.example/path",
    );
    expect(safePreviewHref("javascript:alert(1)")).toBeNull();
    expect(safePreviewHref("not a url")).toBeNull();
  });

  it("gives a parked change no link at all rather than the old live app", async () => {
    const { refinePreviewHref } = await import("./BuildModePane");
    expect(
      refinePreviewHref(
        {
          id: "refine-2",
          message: "Add pricing",
          status: "done",
          created_at: "2026-09-28T08:00:00.000Z",
          awaiting_review: true,
          preview_url: null,
        },
        "https://sandbox.example",
        "https://live.example",
      ),
    ).toBeNull();
  });

  it("uses a parked branch preview but the live app after an update ships", async () => {
    const { refinePreviewHref } = await import("./BuildModePane");
    const base = {
      id: "refine-1",
      message: "Add pricing",
      status: "done",
      created_at: "2026-09-28T08:00:00.000Z",
      preview_url: "https://branch.example",
    };
    expect(
      refinePreviewHref(
        { ...base, awaiting_review: true },
        "https://sandbox.example",
        "https://live.example",
      ),
    ).toBe("https://branch.example/");
    expect(
      refinePreviewHref(
        { ...base, awaiting_review: false },
        "https://sandbox.example",
        "https://live.example",
      ),
    ).toBe("https://live.example/");
  });
});

describe("lastBuildActivity", () => {
  it("picks the newest of the build and its changes", async () => {
    const { lastBuildActivity } = await import("./BuildModePane");
    expect(
      lastBuildActivity(
        {
          createdAt: "2026-09-24T06:55:00Z",
          updatedAt: "2026-09-24T07:20:00Z",
        },
        [
          {
            id: "a",
            message: "m",
            status: "done",
            created_at: "2026-09-24T10:58:00Z",
          },
        ],
      ),
    ).toBe("2026-09-24T10:58:00Z");
    expect(lastBuildActivity(null, [])).toBeNull();
  });
});

describe("deriveBuildSteps — graph-derived for a new-flow site run", () => {
  const site = (build: string, deploy = "pending") => [
    { stage: "provision", status: "done" },
    { stage: "build", status: build },
    { stage: "deploy", status: deploy },
  ];

  it("shows only the steps the run's graph has", () => {
    const steps = deriveBuildSteps(site("running"), "active", "building");
    expect(steps.map((s) => [s.key, s.state])).toEqual([
      ["workspace", "done"],
      ["interface", "active"],
      ["deploy", "pending"],
    ]);
  });

  it("marks the failed stage failed, with no phantom step ticked", () => {
    const steps = deriveBuildSteps(site("failed"), "failed", "failed");
    expect(steps.map((s) => [s.key, s.state])).toEqual([
      ["workspace", "done"],
      ["interface", "failed"],
      ["deploy", "pending"],
    ]);
  });

  it("a finished site run is all done, over its own steps only", () => {
    const steps = deriveBuildSteps(site("done", "done"), "done", "live");
    expect(steps.map((s) => s.key)).toEqual(["workspace", "interface", "deploy"]);
    expect(steps.every((s) => s.state === "done")).toBe(true);
  });

  it("before any stage row arrives, shows the site steps, never the old four-step list", () => {
    const onRequest = deriveBuildSteps([], "active", "building", true);
    expect(onRequest.map((s) => [s.key, s.state])).toEqual([
      ["workspace", "active"],
      ["interface", "pending"],
    ]);
    const publishing = deriveBuildSteps([], "active", "building", false);
    expect(publishing.map((s) => s.key)).toEqual(["workspace", "interface", "deploy"]);
    for (const steps of [onRequest, publishing]) {
      expect(steps.some((s) => s.key === "understanding" || s.key === "structure")).toBe(false);
    }
  });
});

describe("builtSiteUrl", () => {
  it("frames the preview for a site never published, the live address once it is, and nothing unsafe", async () => {
    const { builtSiteUrl } = await import("./BuildModePane");
    const preview = "https://preview.lumen.zavi.site/";
    const live = "https://lumen.com/";
    expect(builtSiteUrl({ previewUrl: preview, liveUrl: live, sitePublished: false })).toBe(preview);
    expect(builtSiteUrl({ previewUrl: preview, liveUrl: live, sitePublished: true })).toBe(live);
    expect(builtSiteUrl({ previewUrl: preview, liveUrl: null })).toBe(preview);
    expect(builtSiteUrl({ previewUrl: "javascript:alert(1)", liveUrl: null })).toBeNull();
    expect(builtSiteUrl({ previewUrl: null, liveUrl: null })).toBeNull();
  });
});
