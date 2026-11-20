// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

let sessionState: Record<string, unknown> = {};
const openBuildTab = vi.fn();

vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: vi.fn(),
  undoBuildRefine: vi.fn(),
  useBuildSession: () => sessionState,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({ currentSessionId: "run-1", sessions: [], loaded: true }),
  readBuildSessions: () => ({ currentSessionId: "run-1", sessions: [], loaded: true }),
  refreshBuildSessions: vi.fn(async () => {}),
  notifyBuildSessionsChanged: vi.fn(),
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn() }));
vi.mock("../WorkspaceShell", () => {
  const ctx = () => ({ tenantName: "Acme", role: "owner", openBuildTab });
  return { useWorkspace: ctx, useWorkspaceOptional: ctx };
});
vi.mock("@/components/voice/MicButton", () => ({ MicButton: () => null }));
vi.mock("@/lib/workspace/buildFraming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/buildFraming")>()),
  useSiteListFirst: () => false,
}));

import { BuildModePane, BuildStoppedPane, BuildTranscriptContent } from "./BuildModePane";
import { _resetStartAgainGuardForTests } from "./startAgainGuard";
import { startBuildSession } from "@/lib/workspace/useBuildSession";

const BRIEF = "A booking site for my yoga classes in Pune";
const OBJECTIVE = `Build product: Acme — ${BRIEF}`;

function stoppedSession() {
  return {
    loaded: true,
    notFound: false,
    loadError: null,
    authExpired: false,
    run: {
      id: "run-1",
      objective: OBJECTIVE,
      status: "failed",
      createdAt: "2026-10-05T05:45:00Z",
      updatedAt: "2026-10-05T05:48:18Z",
      stages: [
        { stage: "provision", status: "done", finished_at: "2026-10-05T05:46:00Z" },
        { stage: "build", status: "active" },
      ],
      failure: { class: "user_cancelled", message: "Cancelled from the workspace." },
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
    continueRun: vi.fn(async () => null),
    continuing: false,
    retry: vi.fn(),
  };
}

type StartResult = { id: string } | { error: string };

function deferredStarts() {
  const pending: Array<(r: StartResult) => void> = [];
  vi.mocked(startBuildSession).mockImplementation(() => new Promise<StartResult>((r) => pending.push(r)) as never);
  return pending;
}

function renderChatCardAndStoppedPane() {
  render(
    <>
      <section data-testid="chat-side">
        <BuildTranscriptContent sessionId="run-1" session={sessionState as never} publishOnRequest />
      </section>
      <section data-testid="preview-side">
        <BuildStoppedPane runId="run-1" objective={OBJECTIVE} />
      </section>
    </>,
  );
  const chat = () => within(within(screen.getByTestId("chat-side")).getByTestId("build-start-again")).getByRole("button");
  const pane = () => within(within(screen.getByTestId("preview-side")).getByTestId("build-start-again")).getByRole("button");
  return { chat, pane };
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  _resetStartAgainGuardForTests();
  vi.mocked(startBuildSession).mockReset();
  openBuildTab.mockReset();
  sessionState = stoppedSession();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

describe("Start again on a stopped build is one paid build across every surface that shows it", () => {
  it("the chat card and the Build stopped pane, both clicked while the first start is pending, start exactly one build and both show it starting", async () => {
    const pending = deferredStarts();
    const { chat, pane } = renderChatCardAndStoppedPane();

    await act(async () => {
      fireEvent.click(chat());
    });
    await act(async () => {
      fireEvent.click(pane());
    });

    expect(vi.mocked(startBuildSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startBuildSession)).toHaveBeenCalledWith({ idea: BRIEF, companyName: "Acme", figma: null });
    expect(chat().textContent).toContain("Starting again…");
    expect(pane().textContent).toContain("Starting again…");
    expect((pane() as HTMLButtonElement).disabled).toBe(true);

    await act(async () => pending[0]({ id: "run-2" }));
    expect(openBuildTab).toHaveBeenCalledTimes(1);
    expect(openBuildTab).toHaveBeenCalledWith("run-2");

    await act(async () => {
      fireEvent.click(pane());
    });
    expect(vi.mocked(startBuildSession)).toHaveBeenCalledTimes(1);
    expect(openBuildTab).toHaveBeenLastCalledWith("run-2");
  });

  it("a failed start frees both buttons, so the other surface can retry and that retry starts the build", async () => {
    const pending = deferredStarts();
    const { chat, pane } = renderChatCardAndStoppedPane();

    await act(async () => {
      fireEvent.click(pane());
    });
    await act(async () => pending[0]({ error: "Couldn't start the build (HTTP 502)." }));

    expect(openBuildTab).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("preview-side")).getByRole("alert").textContent).toBe("Couldn't start the build (HTTP 502).");
    expect((chat() as HTMLButtonElement).disabled).toBe(false);
    expect(chat().textContent).toContain("Start again");
    expect(pane().textContent).toContain("Start again");

    await act(async () => {
      fireEvent.click(chat());
    });
    expect(vi.mocked(startBuildSession)).toHaveBeenCalledTimes(2);
    expect(pane().textContent).toContain("Starting again…");
    await act(async () => pending[1]({ id: "run-3" }));
    expect(openBuildTab).toHaveBeenCalledWith("run-3");
  });

  it("the Build pane's Start again and the Build stopped pane share the guard too", async () => {
    const pending = deferredStarts();
    render(
      <>
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
        />
        <section data-testid="preview-side">
          <BuildStoppedPane runId="run-1" objective={OBJECTIVE} />
        </section>
      </>,
    );
    const failedActions = () => within(screen.getByTestId("build-failed-actions")).getAllByRole("button")[0];
    const pane = () => within(screen.getByTestId("preview-side")).getByRole("button");

    await act(async () => {
      fireEvent.click(pane());
    });
    await act(async () => {
      fireEvent.click(failedActions());
    });
    expect(vi.mocked(startBuildSession)).toHaveBeenCalledTimes(1);
    expect((failedActions() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending[0]({ id: "run-2" }));
    expect(vi.mocked(startBuildSession)).toHaveBeenCalledTimes(1);
  });

  it("after the chat card started the new build, the Build pane's button says Open the new build and opens it, even on a fresh mount", async () => {
    const pending = deferredStarts();
    const onOpenSession = vi.fn();
    const pane = () => (
      <BuildModePane
        sessionId="run-1"
        previewOpen={false}
        focusNonce={0}
        resetNonce={0}
        onOpenPreview={vi.fn()}
        onPreviewUnavailable={vi.fn()}
        onPreviewProgress={vi.fn()}
        onOpenSession={onOpenSession}
        onNewBuild={vi.fn()}
      />
    );
    const first = render(
      <>
        <section data-testid="chat-side">
          <BuildTranscriptContent sessionId="run-1" session={sessionState as never} publishOnRequest />
        </section>
        {pane()}
      </>,
    );
    const failedActions = () => within(screen.getByTestId("build-failed-actions")).getAllByRole("button")[0] as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(within(within(screen.getByTestId("chat-side")).getByTestId("build-start-again")).getByRole("button"));
    });
    await act(async () => pending[0]({ id: "run-2" }));
    expect(failedActions().textContent).toBe("Open the new build");
    expect(failedActions().disabled).toBe(false);

    await act(async () => {
      fireEvent.click(failedActions());
    });
    expect(onOpenSession).toHaveBeenCalledWith("run-2");
    expect(vi.mocked(startBuildSession)).toHaveBeenCalledTimes(1);

    first.unmount();
    onOpenSession.mockReset();
    render(pane());
    expect(failedActions().textContent).toBe("Open the new build");
    await act(async () => {
      fireEvent.click(failedActions());
    });
    expect(onOpenSession).toHaveBeenCalledWith("run-2");
    expect(vi.mocked(startBuildSession)).toHaveBeenCalledTimes(1);
  });
});
