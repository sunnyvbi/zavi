// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const startBuildSession = vi.fn();
let sessionState: Record<string, unknown> = {};

vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: (...args: unknown[]) => startBuildSession(...args),
  useBuildSession: () => sessionState,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({ currentSessionId: null }),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ tenantName: "Acme" }),
  useWorkspaceOptional: () => ({ tenantName: "Acme", role: "owner" }),
}));
vi.mock("@/components/voice/MicButton", () => ({
  MicButton: () => null,
}));

import { BuildModePane } from "./BuildModePane";
import { WORKSPACE_MODE_SUGGESTION_CHIPS } from "../ZaviWelcome";

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    loaded: false,
    notFound: false,
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
    continueRun: vi.fn(async () => null),
    continuing: false,
    retry: vi.fn(),
    ...overrides,
  };
}

function renderPane(
  sessionId: string | null,
  onOpenSession = vi.fn(),
  onPreviewProgress = vi.fn(),
  active = true,
) {
  const pane = (isActive: boolean) => (
    <BuildModePane
      sessionId={sessionId}
      active={isActive}
      previewOpen={false}
      focusNonce={0}
      resetNonce={0}
      onOpenPreview={vi.fn()}
      onPreviewUnavailable={vi.fn()}
      onPreviewProgress={onPreviewProgress}
      onOpenSession={onOpenSession}
      onNewBuild={vi.fn()}
    />
  );
  const view = render(pane(active));
  return {
    onOpenSession,
    onPreviewProgress,
    rerenderActive: (isActive: boolean) => view.rerender(pane(isActive)),
  };
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  startBuildSession.mockReset();
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

function withRun(status: string, extra: Record<string, unknown> = {}) {
  return baseSession({
    loaded: true,
    run: {
      id: "run-old",
      objective: "Build product: A laptop rental storefront",
      status,
      createdAt: null,
      updatedAt: null,
      stages: [],
      failure: null,
    },
    ...extra,
  });
}

const BUILD_CHIPS = WORKSPACE_MODE_SUGGESTION_CHIPS.build.map((chip) => chip.prompt);

describe("idea suggestions under the Build composer", () => {
  it("a failed build shows no idea chips under the composer", () => {
    sessionState = withRun("failed");
    renderPane("run-old");
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    for (const prompt of BUILD_CHIPS) {
      expect(screen.queryAllByRole("button", { name: prompt })).toHaveLength(0);
    }
  });

  it("the empty Build screen still offers them", () => {
    sessionState = baseSession({ loaded: true });
    renderPane(null);
    for (const prompt of BUILD_CHIPS) {
      expect(screen.getAllByRole("button", { name: prompt }).length).toBeGreaterThan(0);
    }
  });
});
