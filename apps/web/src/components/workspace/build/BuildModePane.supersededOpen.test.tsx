// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let sessionState: Record<string, unknown> = {};
let sessionsState: Record<string, unknown> = { currentSessionId: null, sessions: [], loaded: true };
const openStatic = vi.fn();

vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: vi.fn(),
  useBuildSession: () => sessionState,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => sessionsState,
  refreshBuildSessions: vi.fn(() => Promise.resolve()),
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

const OLD = "b0";
const CURRENT = "b1";
const OLD_REQUEST = "A landing page for the tinnitus app";

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

const oldRun = {
  id: OLD,
  objective: OLD_REQUEST,
  status: "done",
  createdAt: null,
  updatedAt: null,
  stages: [],
  failure: null,
};

function renderOldBuild() {
  const onOpenSession = vi.fn();
  render(
    <BuildModePane
      sessionId={OLD}
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
  return onOpenSession;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

afterEach(() => {
  cleanup();
  openStatic.mockReset();
});

describe("opening a build a newer one replaced", () => {
  const sessions = [
    { id: CURRENT, is_current: true },
    { id: OLD, is_current: false },
  ];

  it("shows THAT build, and never bounces to the current one on its own", async () => {
    sessionState = session({ run: oldRun, isCurrent: false });
    sessionsState = { currentSessionId: CURRENT, sessions, loaded: true };
    const onOpenSession = renderOldBuild();
    await settle();
    expect(screen.getByText(OLD_REQUEST)).toBeTruthy();
    expect(screen.getByText("A newer build replaced this app")).toBeTruthy();
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("still bounces nowhere once the session list arrives late", async () => {
    sessionState = session({ run: oldRun, isCurrent: false });
    sessionsState = { currentSessionId: null, sessions: [], loaded: false };
    const onOpenSession = renderOldBuild();
    await settle();
    sessionsState = { currentSessionId: CURRENT, sessions, loaded: true };
    cleanup();
    const again = renderOldBuild();
    await settle();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(again).not.toHaveBeenCalled();
    expect(screen.getByText(OLD_REQUEST)).toBeTruthy();
  });

  it("leaves the hop to the current build as the person's own click", async () => {
    sessionState = session({ run: oldRun, isCurrent: false });
    sessionsState = { currentSessionId: CURRENT, sessions, loaded: true };
    const onOpenSession = renderOldBuild();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Open latest build/ }));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith(CURRENT);
  });
});

describe("opening a build whose database was reclaimed", () => {
  it("says the build was retired and offers a new build, not a newer one", async () => {
    sessionState = session({ run: oldRun, isCurrent: false, retired: true });
    sessionsState = { currentSessionId: OLD, sessions: [{ id: OLD, is_current: false }], loaded: true };
    renderOldBuild();
    await settle();
    expect(screen.getByText("We retired this build")).toBeTruthy();
    expect(screen.queryByText("A newer build replaced this app")).toBeNull();
    expect(screen.queryByRole("button", { name: /Open latest build/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Start a new build/ })).toBeTruthy();
  });
});
