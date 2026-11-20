// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

vi.mock("@/lib/workspace/builderClarifyFlag", () => ({
  isBuilderClarifyEnabled: () => false,
  isBuilderClarifyDynamicEnabled: () => false,
}));

import { BuildModePane } from "./BuildModePane";

const IDEA = "A landing page for my bakery";

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

function typeAndSend(text: string) {
  const box = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
  return box;
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

describe("BuildModePane send", () => {
  it("starts the build on send with no confirmation card", async () => {
    startBuildSession.mockResolvedValue({ id: "run-1" });
    const { onOpenSession } = renderPane(null);

    typeAndSend(IDEA);

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText(/Ready to build this app/i)).toBeNull();
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("run-1", true));
    expect(startBuildSession).toHaveBeenCalledTimes(1);
    expect(startBuildSession).toHaveBeenCalledWith({ idea: IDEA, companyName: "Acme" });
  });

  it("keeps the submit-time Build activation intent while the request resolves", async () => {
    let resolveStart!: (value: { id: string }) => void;
    startBuildSession.mockReturnValue(
      new Promise<{ id: string }>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const { onOpenSession, rerenderActive } = renderPane(null);

    typeAndSend(IDEA);
    rerenderActive(false);
    resolveStart({ id: "run-delayed" });

    await waitFor(() =>
      expect(onOpenSession).toHaveBeenCalledWith("run-delayed", true),
    );
  });

  it("shows a start error inline and keeps the draft", async () => {
    startBuildSession.mockResolvedValue({ error: "Not enough credits to start this build." });
    const { onOpenSession } = renderPane(null);

    const box = typeAndSend(IDEA);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Not enough credits to start this build.");
    expect(box.value).toBe(IDEA);
    expect(box.disabled).toBe(false);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("lets a failed build start a new one", async () => {
    sessionState = baseSession({
      loaded: true,
      run: {
        id: "run-old",
        objective: "Old app",
        status: "failed",
        createdAt: null,
        updatedAt: null,
        stages: [],
        failure: null,
      },
    });
    startBuildSession.mockResolvedValue({ id: "run-2" });
    const { onOpenSession } = renderPane("run-old");

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
    typeAndSend(IDEA);

    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("run-2", true));
    expect(startBuildSession).toHaveBeenCalledTimes(1);
  });
});

describe("preview progress while a build runs", () => {
  const STAGES = [
    { stage: "provision", status: "done" },
    { stage: "spec", status: "running" },
  ];

  it("hands the running build's stages to the preview pane so it can open itself", () => {
    sessionState = baseSession({
      loaded: true,
      run: {
        id: "run-1",
        objective: "Build product: A bakery site",
        status: "active",
        createdAt: null,
        updatedAt: null,
        stages: STAGES,
        failure: null,
      },
    });
    const { onPreviewProgress } = renderPane("run-1");
    expect(onPreviewProgress).toHaveBeenLastCalledWith({
      stages: STAGES,
      failure: null,
      failed: false,
    });
  });

  it("keeps handing over progress while an early preview already exists, so a build opened mid-run still opens its pane", () => {
    sessionState = baseSession({
      loaded: true,
      previewUrl: "https://early.example.com",
      previewKind: "early",
      run: {
        id: "run-1",
        objective: "Build product: A bakery site",
        status: "active",
        createdAt: null,
        updatedAt: null,
        stages: STAGES,
        failure: null,
      },
    });
    const { onPreviewProgress } = renderPane("run-1");
    expect(onPreviewProgress).toHaveBeenLastCalledWith({
      stages: STAGES,
      failure: null,
      failed: false,
    });
  });

  it("clears the progress once the build is done", () => {
    sessionState = baseSession({
      loaded: true,
      previewUrl: "https://live.example.com",
      previewKind: "final",
      liveUrl: "https://live.example.com",
      run: {
        id: "run-1",
        objective: "Build product: A bakery site",
        status: "done",
        createdAt: null,
        updatedAt: null,
        stages: STAGES.map((s) => ({ ...s, status: "done" })),
        failure: null,
      },
    });
    const { onPreviewProgress } = renderPane("run-1");
    expect(onPreviewProgress).toHaveBeenLastCalledWith(null);
  });
});

describe("a paused build (checkpoint model)", () => {
  const paused = (failureMessage: string | null, over: Record<string, unknown> = {}) =>
    baseSession({
      loaded: true,
      run: {
        id: "run-p",
        objective: "My app",
        status: "paused",
        createdAt: null,
        updatedAt: null,
        stages: [
          { stage: "provision", status: "done" },
          { stage: "spec", status: "done" },
          { stage: "scaffold", status: "done" },
          { stage: "build", status: "done" },
          { stage: "qa", status: "failed" },
        ],
        failure: failureMessage ? { message: failureMessage } : null,
      },
      ...over,
    });

  it("says the build paused, keeps finished steps, and offers Continue", async () => {
    sessionState = paused("qa failed after 3 repairs");
    renderPane("run-p");
    expect(screen.getByText("Build paused")).toBeTruthy();
    expect(screen.getByText(/Everything\s+before it is saved/)).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Continue build" });
    fireEvent.click(btn);
    await waitFor(() => expect(sessionState.continueRun).toHaveBeenCalledTimes(1));
  });

  it("out of credits: top up, then continue", () => {
    sessionState = paused("insufficient_credits: repair dispatch refused");
    renderPane("run-p");
    expect(screen.getByText(/Your build is paused: out of credits/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue build" })).toBeTruthy();
    expect(screen.queryByText(/This build stopped: out of credits/)).toBeNull();
  });

  it("shows why Continue was refused", async () => {
    sessionState = paused("qa failed");
    (sessionState.continueRun as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: "superseded",
      message: "A newer build replaced this one. Open your latest build instead.",
    });
    renderPane("run-p");
    fireEvent.click(screen.getByRole("button", { name: "Continue build" }));
    expect(await screen.findByText(/A newer build replaced this one/)).toBeTruthy();
  });

  it("a replaced (superseded) paused build offers no Continue", () => {
    sessionState = paused("qa failed", { isCurrent: false });
    renderPane("run-p");
    expect(screen.queryByRole("button", { name: "Continue build" })).toBeNull();
  });

  it("sends a change to a finished build as one refine of that build", async () => {
    const sendRefine = vi.fn(async () => null);
    sessionState = baseSession({
      loaded: true,
      run: { id: "s-done", status: "done", objective: IDEA, stages: [], createdAt: null, updatedAt: null, failure: null },
      liveUrl: "https://acme.example.com",
      sendRefine,
    });
    renderPane("s-done");
    typeAndSend("Change the hero title to Fresh bread daily");
    await waitFor(() => expect(sendRefine).toHaveBeenCalledTimes(1));
    expect(sendRefine).toHaveBeenCalledWith("Change the hero title to Fresh bread daily");
    expect(startBuildSession).not.toHaveBeenCalled();
  });
});

describe("BuildModePane opens the new build the moment it is sent", () => {
  it("swaps the start page for the new build's transcript before the start request answers", async () => {
    let resolveStart!: (value: { id: string }) => void;
    startBuildSession.mockReturnValue(new Promise<{ id: string }>((r) => (resolveStart = r)));
    const { onOpenSession } = renderPane(null);

    typeAndSend(IDEA);

    const pane = await screen.findByTestId("build-starting");
    expect(pane.textContent).toContain(IDEA);
    expect(pane.textContent).toContain("Setting up your build");
    expect(within(pane).getByRole("status").querySelector("svg")).toBeNull();
    expect((within(pane).getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText(/YOUR BUILDS/i)).toBeNull();
    expect(onOpenSession).not.toHaveBeenCalled();

    resolveStart({ id: "run-9" });
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("run-9", true));
  });

  it("goes back to the start page with the error and the idea when the build is refused", async () => {
    startBuildSession.mockResolvedValue({ error: "A build is already running. Stop it before starting another." });
    renderPane(null);

    typeAndSend(IDEA);

    await screen.findByText("A build is already running. Stop it before starting another.");
    expect(screen.queryByTestId("build-starting")).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(IDEA);
  });
});
