// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

let sessionState: Record<string, unknown> = {};

vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: vi.fn(),
  useBuildSession: () => sessionState,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({ currentSessionId: null }),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ tenantName: "Acme" }),
}));
vi.mock("@/components/voice/MicButton", () => ({
  MicButton: () => null,
}));

import { BuildModePane } from "./BuildModePane";

const STAGES = [
  { stage: "provision", status: "done" },
  { stage: "spec", status: "done" },
  { stage: "build", status: "done" },
  { stage: "deploy", status: "done" },
];

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    loaded: true,
    notFound: false,
    authExpired: false,
    loadError: null,
    run: null,
    isCurrent: true,
    previewUrl: null,
    previewKind: "none",
    liveUrl: null,
    repoUrl: null,
    refines: [],
    refinesLoaded: true,
    sendRefine: vi.fn(),
    refineSubmitting: false,
    cancelRun: vi.fn(),
    stopping: false,
    retry: vi.fn(),
    ...overrides,
  };
}

function run(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    objective: "Build product: A landing page for my private rentals",
    status,
    createdAt: null,
    updatedAt: null,
    stages: STAGES,
    failure: null,
    ...overrides,
  };
}

function renderPane(previewOpen: boolean, wanted = true) {
  const onOpenPreview = vi.fn();
  const onPreviewUnavailable = vi.fn();
  const onPreviewWanted = vi.fn();
  render(
    <BuildModePane
      sessionId="run-1"
      previewOpen={previewOpen}
      focusNonce={0}
      resetNonce={0}
      onOpenPreview={onOpenPreview}
      onPreviewUnavailable={onPreviewUnavailable}
      onPreviewWanted={wanted ? onPreviewWanted : undefined}
      onPreviewProgress={vi.fn()}
      onOpenSession={vi.fn()}
      onNewBuild={vi.fn()}
    />,
  );
  return { onOpenPreview, onPreviewUnavailable, onPreviewWanted };
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  sessionState = baseSession();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

describe("a servable preview opens the pane on its own", () => {
  it("opens the preview for a finished build reopened later, with no in-flight progress to ride in on", () => {
    sessionState = baseSession({
      run: run("done"),
      previewUrl: "https://live.example.com",
      previewKind: "final",
      liveUrl: "https://live.example.com",
    });

    const { onOpenPreview } = renderPane(false);

    expect(onOpenPreview).toHaveBeenCalledTimes(1);
    expect(onOpenPreview.mock.calls[0][0]).toMatchObject({
      url: "https://live.example.com",
      kind: "final",
    });
  });

  it("opens the sandbox preview of a build whose deploy failed, because the link is still servable", () => {
    sessionState = baseSession({
      run: run("failed", {
        stages: [
          { stage: "provision", status: "done" },
          { stage: "spec", status: "done" },
          { stage: "build", status: "done" },
          { stage: "deploy", status: "failed" },
        ],
        failure: { stage: "deploy", message: "Deploy did not reach a live serving state." },
      }),
      previewUrl: "https://sbx.e2b.app",
      previewKind: "instant",
    });

    const { onOpenPreview, onPreviewUnavailable } = renderPane(false);

    expect(onOpenPreview.mock.calls[0][0]).toMatchObject({
      url: "https://sbx.e2b.app",
      kind: "instant",
    });
    expect(onPreviewUnavailable).not.toHaveBeenCalled();
  });

  it("tears an open pane down when the failed build has no servable link, and leaves a closed pane alone", () => {
    sessionState = baseSession({
      run: run("failed", {
        stages: [
          { stage: "provision", status: "done" },
          { stage: "deploy", status: "failed" },
        ],
        failure: { stage: "deploy", message: "Deploy did not reach a live serving state." },
      }),
    });

    const closed = renderPane(false);
    expect(closed.onOpenPreview).not.toHaveBeenCalled();
    expect(closed.onPreviewUnavailable).not.toHaveBeenCalled();

    cleanup();

    const open = renderPane(true);
    expect(open.onOpenPreview).not.toHaveBeenCalled();
    expect(open.onPreviewUnavailable).toHaveBeenCalled();
  });
});

describe("a finished build whose preview is gone keeps the preview side open", () => {
  it.each([
    ["stopped", false],
    ["stopped", true],
    ["starting", false],
    ["starting", true],
  ])("asks for the pane when the preview is %s (pane open: %s) and never tears it down", (previewState, open) => {
    sessionState = baseSession({ run: run("done"), previewState });

    const { onOpenPreview, onPreviewUnavailable, onPreviewWanted } = renderPane(open);

    expect(onPreviewWanted).toHaveBeenCalled();
    expect(onPreviewUnavailable).not.toHaveBeenCalled();
    expect(onOpenPreview).not.toHaveBeenCalled();
  });

  it("a servable preview still opens itself instead", () => {
    sessionState = baseSession({
      run: run("done"),
      previewUrl: "https://sbx.e2b.app",
      previewKind: "instant",
      previewState: null,
    });

    const { onOpenPreview, onPreviewWanted } = renderPane(false);

    expect(onOpenPreview).toHaveBeenCalledTimes(1);
    expect(onPreviewWanted).not.toHaveBeenCalled();
  });

  it("a build replaced by a newer one does not reopen its pane", () => {
    sessionState = baseSession({ run: run("done"), previewState: "stopped", isCurrent: false });

    const { onPreviewWanted, onPreviewUnavailable } = renderPane(true);

    expect(onPreviewWanted).not.toHaveBeenCalled();
    expect(onPreviewUnavailable).toHaveBeenCalled();
  });

  it("a build with no preview state and no link still tears an open pane down", () => {
    sessionState = baseSession({ run: run("done") });

    const { onPreviewWanted, onPreviewUnavailable } = renderPane(true);

    expect(onPreviewWanted).not.toHaveBeenCalled();
    expect(onPreviewUnavailable).toHaveBeenCalled();
  });
});
