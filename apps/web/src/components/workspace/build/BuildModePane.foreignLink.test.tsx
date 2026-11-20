// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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

Element.prototype.scrollIntoView = vi.fn();

async function renderWithUrl(search: string) {
  window.history.replaceState(null, "", `/workspace${search}`);
  vi.resetModules();
  const { BuildModePane } = await import("./BuildModePane");
  const onOpenSession = vi.fn();
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
  window.history.replaceState(null, "", "/");
});

describe("QA l4.6: a build link that is not in this workspace", () => {
  it("opened from a pasted ?build= link, it says so and never swaps in my own build", async () => {
    sessionState = session({ notFound: true });
    sessionsState = { currentSessionId: "mine", sessions: [], loaded: true };
    const { onOpenSession } = await renderWithUrl("?tab=build&build=b1");
    await vi.waitFor(() => expect(screen.getByText(/isn't in this workspace/)).toBeTruthy());
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("restored without a link (after a workspace switch), it still goes to this workspace's current build", async () => {
    sessionState = session({ notFound: true });
    sessionsState = { currentSessionId: "mine", sessions: [], loaded: true };
    const { onOpenSession } = await renderWithUrl("?tab=build");
    await vi.waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("mine"));
  });
});
