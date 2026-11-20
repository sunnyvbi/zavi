// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

let sessionState: Record<string, unknown> = {};
let sessionsState: Record<string, unknown> = { currentSessionId: null, sessions: [], loaded: true };
const openStatic = vi.fn();

vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: vi.fn(),
  useBuildSession: () => sessionState,
}));
const refreshBuildSessions = vi.fn(() => Promise.resolve());
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => sessionsState,
  refreshBuildSessions: () => refreshBuildSessions(),
  readBuildSessions: () => sessionsState,
}));
vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => ({ tenantName: "Acme" }) }));
vi.mock("../layout/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../layout/shared")>()),
  useOpenStatic: () => openStatic,
}));
vi.mock("@/components/voice/MicButton", () => ({ MicButton: () => null }));

import { BuildModePane } from "./BuildModePane";

Element.prototype.scrollIntoView = vi.fn();

function session(overrides: Record<string, unknown>) {
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

const failedRun = {
  id: "b1",
  objective: "A landing page",
  status: "failed",
  createdAt: null,
  updatedAt: null,
  stages: [],
  failure: { message: "boom" },
};

function renderPane(onOpenSession = vi.fn()) {
  render(
    <BuildModePane
      sessionId="b1"
      previewOpen={false}
      focusNonce={0}
      resetNonce={0}
      onOpenPreview={vi.fn()}
      onPreviewUnavailable={vi.fn()}
      onPreviewProgress={vi.fn()}
      onOpenSession={onOpenSession}
      onNewBuild={vi.fn()}
    />,
  );
  return { onOpenSession };
}

afterEach(() => {
  cleanup();
  openStatic.mockReset();
});

describe("a build from another workspace", () => {
  it("goes to this workspace's current build", () => {
    sessionState = session({ notFound: true });
    sessionsState = { currentSessionId: "cur", sessions: [], loaded: true };
    const { onOpenSession } = renderPane();
    expect(onOpenSession).toHaveBeenCalledWith("cur");
  });

  it("asks for the build list again when it failed to load", async () => {
    refreshBuildSessions.mockClear();
    sessionState = session({ notFound: true });
    sessionsState = { currentSessionId: null, sessions: [], loaded: false };
    const { onOpenSession } = renderPane();
    await vi.waitFor(() => expect(refreshBuildSessions).toHaveBeenCalledTimes(2));
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("stays put when this workspace has no build yet", () => {
    sessionState = session({ notFound: true });
    sessionsState = { currentSessionId: null, sessions: [], loaded: true };
    const { onOpenSession } = renderPane();
    expect(onOpenSession).not.toHaveBeenCalled();
  });
});

describe("a failed build", () => {
  const sessions = [
    { id: "b1", is_current: true, state: "failed", run_status: "failed", created_at: "2026-09-30T08:00:00Z" },
    { id: "b0", is_current: false, state: "ready", run_status: "done", created_at: "2026-09-29T08:00:00Z" },
  ];

  it("sends the founder nowhere: no pointer to the Website dashboard or to a replaced build that has no preview", () => {
    sessionState = session({ run: failedRun });
    sessionsState = { currentSessionId: "b1", sessions, loaded: true };
    renderPane();
    expect(screen.queryByRole("button", { name: /Open Website tab|Open that build/ })).toBeNull();
    expect(screen.queryByText(/Website tab shows|earlier build finished/)).toBeNull();
    expect(openStatic).not.toHaveBeenCalledWith("website");
  });

  it("never claims a failed historical build is ready, even when an older live URL exists", () => {
    sessionState = session({
      run: {
        ...failedRun,
        createdAt: "2026-09-28T10:00:00Z",
        updatedAt: "2026-09-28T11:02:27Z",
        failure: {
          message:
            'Stage "build" finished but no code reached the provisioned repo (Praxis-build/internal) after 10 min; seed placeholder remains.',
        },
      },
      liveUrl: "https://older-app.example",
      previewKind: "final",
    });
    sessionsState = { currentSessionId: "b1", sessions, loaded: true };
    renderPane();

    expect(screen.getByText("Build failed")).toBeTruthy();
    expect(screen.queryByText("Build stopped")).toBeNull();
    expect(screen.getByText(/Ran .* before failing/)).toBeTruthy();
    expect(screen.getByText(/couldn't finish/i)).toBeTruthy();
    expect(screen.queryByText("Your app is ready")).toBeNull();
    expect(screen.queryByText(/Built in/)).toBeNull();
    expect(screen.queryByText(/provisioned repo|Praxis-build|seed placeholder/i)).toBeNull();
  });

  it("never tells the founder a failed build left the live site alone, since it may have left the placeholder", () => {
    sessionState = session({
      run: {
        ...failedRun,
        failure: {
          message:
            'Stage "build" finished but no code reached the provisioned repo (Praxis-build/internal) after 10 min; seed placeholder remains.',
        },
      },
    });
    sessionsState = { currentSessionId: "b1", sessions, loaded: true };
    renderPane();
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/couldn't finish/i);
    expect(text).not.toMatch(/wasn't touched|Nothing live|previous version|unchanged|still live|what is live right now/i);
    expect(text).not.toMatch(/didn't finish/i);
  });

  it("lines the retry buttons up on the right edge, like the Website notice button", () => {
    sessionState = session({ run: failedRun });
    sessionsState = { currentSessionId: "b1", sessions, loaded: true };
    renderPane();
    const actions = screen.getByTestId("build-failed-actions");
    expect(actions.className).toMatch(/\bjustify-end\b/);
    expect(actions.className).not.toMatch(/\bjustify-(start|between|center)\b/);
    expect(
      within(actions).getByRole("button", { name: /Try again with the same idea/ }),
    ).toBeTruthy();
    expect(within(actions).getByRole("button", { name: /Start a new build/ })).toBeTruthy();
  });

  it.each(["cancelled", "halted"])("keeps a %s build reading as stopped, not failed", (status) => {
    sessionState = session({ run: { ...failedRun, status } });
    sessionsState = { currentSessionId: "b1", sessions, loaded: true };
    renderPane();
    expect(screen.getByText("Build stopped")).toBeTruthy();
    expect(screen.queryByText("Build failed")).toBeNull();
    expect(screen.getByText(/Ran .* before stopping/)).toBeTruthy();
  });

  it.each(["user_cancelled", "stale_reaped"])(
    "reads a failed run the backend stored as %s as stopped, since Stop writes status failed",
    (failureClass) => {
      sessionState = session({
        run: { ...failedRun, status: "failed", failure: { class: failureClass, message: "Build was stopped by the user." } },
      });
      sessionsState = { currentSessionId: "b1", sessions, loaded: true };
      renderPane();
      expect(screen.getByText("Build stopped")).toBeTruthy();
      expect(screen.queryByText("Build failed")).toBeNull();
      expect(screen.getByText(/Ran .* before stopping/)).toBeTruthy();
    },
  );

  it("still reads a genuinely errored run as failed", () => {
    sessionState = session({ run: { ...failedRun, failure: { class: "dispatch_failed", message: "boom" } } });
    sessionsState = { currentSessionId: "b1", sessions, loaded: true };
    renderPane();
    expect(screen.getByText("Build failed")).toBeTruthy();
    expect(screen.getByText(/Ran .* before failing/)).toBeTruthy();
  });
});
