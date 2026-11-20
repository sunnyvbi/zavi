// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

import { BUILDING_CHANGE_PLACEHOLDER, BuildModePane } from "./BuildModePane";
import { BUILD_CHANGE_BUSY_MESSAGE } from "@/lib/workspace/useBuildSession";

const HELD = "Your site is still building. I'll make this change as soon as it finishes.";
const CHANGE = "Our prices start at $80 for a standard clean";

function buildingRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    objective: "Build product: A cleaning site",
    status: "active",
    createdAt: null,
    updatedAt: null,
    stages: [
      { stage: "provision", status: "done" },
      { stage: "scaffold", status: "running" },
    ],
    failure: null,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    loaded: true,
    notFound: false,
    loadError: null,
    run: buildingRun(),
    isCurrent: true,
    previewUrl: null,
    previewKind: "none",
    liveUrl: null,
    repoUrl: null,
    refines: [],
    refinesLoaded: true,
    sendRefine: vi.fn(async () => ({ kind: "held", message: HELD })),
    refineSubmitting: false,
    cancelRun: vi.fn(),
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
    retry: vi.fn(),
    ...overrides,
  };
}

function pane() {
  return (
    <BuildModePane
      sessionId="run-1"
      active
      previewOpen={false}
      focusNonce={0}
      resetNonce={0}
      onOpenPreview={vi.fn()}
      onPreviewUnavailable={vi.fn()}
      onPreviewProgress={vi.fn()}
      onOpenSession={vi.fn()}
      onNewBuild={vi.fn()}
    />
  );
}

function send(text: string) {
  const box = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
  return box;
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  startBuildSession.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

describe("the Build chat while the site is still building", () => {
  it("stays open, sends a change of this build (never a new build), and shows it is held", async () => {
    sessionState = session();
    render(pane());
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    expect(box.placeholder).toBe(BUILDING_CHANGE_PLACEHOLDER);
    send(CHANGE);
    await waitFor(() => expect(screen.getByTestId("build-change-held").textContent).toBe(HELD));
    expect(sessionState.sendRefine).toHaveBeenCalledWith(CHANGE);
    expect(startBuildSession).not.toHaveBeenCalled();
    expect(box.value).toBe("");
  });

  it("a busy refusal keeps the words in the box and says why", async () => {
    sessionState = session({ sendRefine: vi.fn(async () => BUILD_CHANGE_BUSY_MESSAGE) });
    render(pane());
    const box = send(CHANGE);
    await waitFor(() => expect(screen.getByText(BUILD_CHANGE_BUSY_MESSAGE)).toBeTruthy());
    expect(box.value).toBe(CHANGE);
    expect(screen.queryByTestId("build-change-held")).toBeNull();
  });

  it("the held line goes away once the build finishes", async () => {
    sessionState = session();
    const view = render(pane());
    send(CHANGE);
    await waitFor(() => expect(screen.getByTestId("build-change-held")).toBeTruthy());
    sessionState = session({ run: buildingRun({ status: "done", stages: [{ stage: "provision", status: "done" }, { stage: "scaffold", status: "done" }] }) });
    view.rerender(pane());
    await waitFor(() => expect(screen.queryByTestId("build-change-held")).toBeNull());
  });

  it("a failed build never takes a held change: send starts a new build instead", async () => {
    sessionState = session({ run: buildingRun({ status: "failed" }) });
    startBuildSession.mockResolvedValue({ id: "run-2" });
    render(pane());
    send("A landing page for my cleaning business");
    await waitFor(() => expect(startBuildSession).toHaveBeenCalledTimes(1));
    expect(sessionState.sendRefine).not.toHaveBeenCalled();
  });

  it("a build a newer one replaced takes no change at all", () => {
    sessionState = session({ isCurrent: false });
    render(pane());
    const box = screen.queryByRole("textbox") as HTMLTextAreaElement | null;
    expect(box === null || box.disabled).toBe(true);
    expect(sessionState.sendRefine).not.toHaveBeenCalled();
  });
});
