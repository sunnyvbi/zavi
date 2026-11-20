// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

let sessionState: Record<string, unknown> = {};
let sessionsState: Record<string, unknown> = { currentSessionId: "run-1", sessions: [], loaded: true };
const openBuildTab = vi.fn();

vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: vi.fn(),
  undoBuildRefine: vi.fn(),
  useBuildSession: () => sessionState,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => sessionsState,
  readBuildSessions: () => sessionsState,
  refreshBuildSessions: vi.fn(async () => {}),
  notifyBuildSessionsChanged: vi.fn(),
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn() }));
let role = "owner";
vi.mock("../WorkspaceShell", () => {
  const ctx = () => ({ tenantName: "Acme", role, openBuildTab });
  return { useWorkspace: ctx, useWorkspaceOptional: ctx };
});
vi.mock("@/components/voice/MicButton", () => ({ MicButton: () => null }));
vi.mock("@/lib/workspace/buildFraming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/buildFraming")>()),
  useSiteListFirst: () => false,
}));

import { BuildModePane, BuildTranscriptContent } from "./BuildModePane";
import { startBuildSession } from "@/lib/workspace/useBuildSession";
import { START_SITE_ROLE_ERROR } from "@/lib/workspace/buildRoles";
import { BUILD_STOPPED_BY_YOU, BUILD_STOPPED_BY_YOU_RESTART } from "@zavi/shared";
import { _resetStartAgainGuardForTests } from "./startAgainGuard";

const BRIEF = "A booking site for my yoga classes in Pune";
const continueRun = vi.fn(async () => ({ code: "not_resumable", message: "This build can't be retried from where it stopped. Start a new build." }));

function stoppedSession(overrides: Record<string, unknown> = {}, failureClass = "user_cancelled") {
  return {
    loaded: true,
    notFound: false,
    loadError: null,
    authExpired: false,
    run: {
      id: "run-1",
      objective: `Build product: Acme — ${BRIEF}`,
      status: "failed",
      createdAt: "2026-10-05T05:45:00Z",
      updatedAt: "2026-10-05T05:48:18Z",
      stages: [
        { stage: "provision", status: "done", finished_at: "2026-10-05T05:46:00Z" },
        { stage: "build", status: "active" },
      ],
      failure: { class: failureClass, message: "Cancelled from the workspace." },
    },
    isCurrent: true,
    retired: false,
    previewUrl: null,
    previewKind: "none",
    liveUrl: null,
    refines: [],
    refinesLoaded: true,
    appReady: false,
    appReadyAt: null,
    publish: { status: "none", startedAt: null, url: null, retryable: false },
    sendRefine: vi.fn(async () => null),
    refineSubmitting: false,
    cancelRun: vi.fn(async () => null),
    stopping: false,
    continueRun,
    continuing: false,
    retry: vi.fn(),
    ...overrides,
  };
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  _resetStartAgainGuardForTests();
  vi.mocked(startBuildSession).mockReset();
  continueRun.mockClear();
  openBuildTab.mockReset();
  sessionsState = { currentSessionId: "run-1", sessions: [], loaded: true };
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

describe("Build pane after the founder pressed Stop (l1.5)", () => {
  it("offers Start again, which starts a new build with the same brief and never asks Continue (which refuses a stop)", async () => {
    vi.mocked(startBuildSession).mockResolvedValue({ id: "run-2" });
    sessionState = stoppedSession();
    render(
      <BuildModePane
        sessionId="run-1"
        previewOpen={false}
        focusNonce={0}
        resetNonce={0}
        onOpenPreview={vi.fn()}
        onPreviewUnavailable={vi.fn()}
        onPreviewProgress={vi.fn()}
        onOpenSession={vi.fn()}
        onNewBuild={vi.fn()}
      />,
    );
    expect(screen.getByText("Build stopped")).toBeTruthy();
    expect(document.body.textContent).toContain(BUILD_STOPPED_BY_YOU_RESTART);
    expect(document.body.textContent).not.toContain(BUILD_STOPPED_BY_YOU);
    const actions = screen.getByTestId("build-failed-actions");
    await act(async () => {
      fireEvent.click(within(actions).getByRole("button", { name: "Start again" }));
    });
    expect(continueRun).not.toHaveBeenCalled();
    expect(vi.mocked(startBuildSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startBuildSession)).toHaveBeenCalledWith({ idea: BRIEF, companyName: "Acme" });
  });
});

describe("Build pane after a stop whose brief is too long to resend (l1.5)", () => {
  it("keeps the message-box stop line, since Start again only puts the brief back in the composer", () => {
    sessionState = stoppedSession({ run: { ...(stoppedSession().run as Record<string, unknown>), objective: "x".repeat(500) } });
    render(
      <BuildModePane
        sessionId="run-1"
        previewOpen={false}
        focusNonce={0}
        resetNonce={0}
        onOpenPreview={vi.fn()}
        onPreviewUnavailable={vi.fn()}
        onPreviewProgress={vi.fn()}
        onOpenSession={vi.fn()}
        onNewBuild={vi.fn()}
      />,
    );
    expect(screen.getByTestId("build-failed-actions")).toBeTruthy();
    expect(document.body.textContent).toContain(BUILD_STOPPED_BY_YOU);
    expect(document.body.textContent).not.toContain(BUILD_STOPPED_BY_YOU_RESTART);
  });
});

describe("the chat card of a build the founder stopped (l1.5)", () => {
  const card = (session: Record<string, unknown>) =>
    render(<BuildTranscriptContent sessionId="run-1" session={session as never} publishOnRequest />);

  it("carries Start again under the stopped line; it starts the same brief and opens the new build", async () => {
    let resolve: (v: { id: string }) => void = () => {};
    vi.mocked(startBuildSession).mockImplementation(() => new Promise((r) => (resolve = r)));
    card(stoppedSession());
    expect(document.body.textContent).toContain(BUILD_STOPPED_BY_YOU_RESTART);
    expect(document.body.textContent).not.toContain(BUILD_STOPPED_BY_YOU);
    const button = within(screen.getByTestId("build-start-again")).getByRole("button", { name: "Start again" });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(vi.mocked(startBuildSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startBuildSession)).toHaveBeenCalledWith({ idea: BRIEF, companyName: "Acme", figma: null });
    expect(openBuildTab).not.toHaveBeenCalled();
    await act(async () => resolve({ id: "run-2" }));
    expect(openBuildTab).toHaveBeenCalledWith("run-2");
  });

  it("a replaced build, a crash, or a build that already got its preview gets no Start again", () => {
    const replaced = card(stoppedSession({ isCurrent: false }));
    expect(screen.queryByTestId("build-start-again")).toBeNull();
    replaced.unmount();
    const crashed = card(stoppedSession({}, "stage_failed"));
    expect(screen.queryByTestId("build-start-again")).toBeNull();
    crashed.unmount();
    card(stoppedSession({ appReady: true }));
    expect(screen.queryByTestId("build-start-again")).toBeNull();
  });

  it("the server's founder-coded stop line is replaced by the Start again line wherever the button shows", () => {
    card(
      stoppedSession({
        run: {
          ...(stoppedSession().run as Record<string, unknown>),
          failure: { class: "user_cancelled", code: "stopped_by_you", message: BUILD_STOPPED_BY_YOU },
        },
      }),
    );
    expect(screen.getByTestId("build-start-again")).toBeTruthy();
    expect(document.body.textContent).toContain(BUILD_STOPPED_BY_YOU_RESTART);
    expect(document.body.textContent).not.toContain(BUILD_STOPPED_BY_YOU);
  });

  it("where no Start again button shows, or it would start a fresh brief, the stop line stays the message-box one", () => {
    const replaced = card(stoppedSession({ isCurrent: false }));
    expect(screen.queryByTestId("build-start-again")).toBeNull();
    expect(document.body.textContent).toContain(BUILD_STOPPED_BY_YOU);
    expect(document.body.textContent).not.toContain(BUILD_STOPPED_BY_YOU_RESTART);
    replaced.unmount();

    const longBrief = card(
      stoppedSession({ run: { ...(stoppedSession().run as Record<string, unknown>), objective: "x".repeat(500) } }),
    );
    expect(within(screen.getByTestId("build-start-again")).getByRole("button").textContent).toBe("Start a new build");
    expect(document.body.textContent).toContain(BUILD_STOPPED_BY_YOU);
    expect(document.body.textContent).not.toContain(BUILD_STOPPED_BY_YOU_RESTART);
    longBrief.unmount();
  });
});

describe("a member cannot start a stopped build again", () => {
  afterEach(() => {
    role = "owner";
  });

  it("the pane's Start again says only an owner or admin can, and starts nothing", async () => {
    role = "member";
    sessionState = stoppedSession();
    render(
      <BuildModePane
        sessionId="run-1"
        previewOpen={false}
        focusNonce={0}
        resetNonce={0}
        onOpenPreview={vi.fn()}
        onPreviewUnavailable={vi.fn()}
        onPreviewProgress={vi.fn()}
        onOpenSession={vi.fn()}
        onNewBuild={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("build-failed-actions")).getByRole("button", { name: "Start again" }));
    });
    expect(vi.mocked(startBuildSession)).not.toHaveBeenCalled();
    expect(screen.getAllByText(START_SITE_ROLE_ERROR).length).toBeGreaterThan(0);
  });

  it("the chat card's Start again says the same and starts nothing", async () => {
    role = "member";
    render(<BuildTranscriptContent sessionId="run-1" session={stoppedSession() as never} publishOnRequest />);
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("build-start-again")).getByRole("button", { name: "Start again" }));
    });
    expect(vi.mocked(startBuildSession)).not.toHaveBeenCalled();
    expect(screen.getAllByText(START_SITE_ROLE_ERROR).length).toBeGreaterThan(0);
  });
});
