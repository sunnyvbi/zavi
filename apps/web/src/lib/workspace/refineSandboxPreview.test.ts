import { describe, expect, it } from "vitest";
import { nextSandboxFrameUrl, refineSandboxPreviewRunId } from "./refineSandboxPreview";
import type { BuildRefine } from "./useBuildSession";

function refine(over: Partial<BuildRefine> = {}): BuildRefine {
  return {
    id: over.id ?? "cr",
    message: "Build a shopping cart",
    status: "active",
    created_at: "2026-09-29T05:39:16Z",
    engineer_run_id: "ar_engineer",
    kind: "change",
    ...over,
  };
}

const live = (proxyUrl: string) => ({ kind: "live" as const, proxyUrl, path: null, outcome: null });

describe("refineSandboxPreviewRunId", () => {
  it("returns the engineer run of an in-flight change so its sandbox preview can be shown before Render deploys", () => {
    expect(refineSandboxPreviewRunId([refine({ status: "done", engineer_run_id: "ar_old" }), refine()])).toBe(
      "ar_engineer",
    );
  });

  it("only looks at the newest refine: an older in-flight one behind a finished one does not take over the preview", () => {
    expect(
      refineSandboxPreviewRunId([refine({ engineer_run_id: "ar_old" }), refine({ status: "done", engineer_run_id: "ar_new" })]),
    ).toBeNull();
  });

  it.each(["done", "failed", "halted", "paused", "cancelled", "canceled"])(
    "a %s refine hands the preview back to the hosted app",
    (status) => {
      expect(refineSandboxPreviewRunId([refine({ status })])).toBeNull();
    },
  );

  it.each(["active", "provisioning", "queued"])("a %s refine keeps the sandbox preview", (status) => {
    expect(refineSandboxPreviewRunId([refine({ status })])).toBe("ar_engineer");
  });

  it("a change parked for review keeps its own branch preview flow", () => {
    expect(refineSandboxPreviewRunId([refine({ awaiting_review: true })])).toBeNull();
  });

  it("restore and undo rows never show a sandbox draft", () => {
    expect(refineSandboxPreviewRunId([refine({ kind: "restore" })])).toBeNull();
    expect(refineSandboxPreviewRunId([refine({ kind: "undo" })])).toBeNull();
  });

  it("a refine whose engineer has not been dispatched yet has nothing to poll", () => {
    expect(refineSandboxPreviewRunId([refine({ engineer_run_id: null })])).toBeNull();
    expect(refineSandboxPreviewRunId([refine({ engineer_run_id: "" })])).toBeNull();
    expect(refineSandboxPreviewRunId([refine({ engineer_run_id: undefined })])).toBeNull();
  });

  it("legacy rows without a kind are treated as changes", () => {
    expect(refineSandboxPreviewRunId([refine({ kind: undefined })])).toBe("ar_engineer");
  });

  it("no refines, no sandbox preview", () => {
    expect(refineSandboxPreviewRunId([])).toBeNull();
  });
});

describe("nextSandboxFrameUrl", () => {
  const first = "https://api.zaviagent.com/api/workspace/engineer-preview/ar/?__pt=token-1";
  const rotated = "https://api.zaviagent.com/api/workspace/engineer-preview/ar/?__pt=token-2";

  it("pins the first live URL so the re-signed token on every poll does not reload the frame", () => {
    const a = nextSandboxFrameUrl(null, live(first));
    const b = nextSandboxFrameUrl(a, live(rotated));
    const c = nextSandboxFrameUrl(b, live("https://api.zaviagent.com/api/workspace/engineer-preview/ar/?__pt=token-3"));
    expect([a, b, c]).toEqual([first, first, first]);
  });

  it("drops the frame when the preview dies so the hosted app shows instead of a dead proxy page", () => {
    expect(nextSandboxFrameUrl(first, { kind: "expired", reason: "idle", canRestart: true })).toBeNull();
  });

  it("shows nothing while the sandbox is still booting or the feature is off", () => {
    expect(nextSandboxFrameUrl(null, { kind: "starting" })).toBeNull();
    expect(nextSandboxFrameUrl(first, { kind: "hidden" })).toBeNull();
  });

  it("after a preview dies and comes back, the new URL is used", () => {
    const dead = nextSandboxFrameUrl(first, { kind: "expired", reason: "idle", canRestart: true });
    expect(nextSandboxFrameUrl(dead, live(rotated))).toBe(rotated);
  });
});
