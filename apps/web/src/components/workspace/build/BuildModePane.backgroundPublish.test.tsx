// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let sessionState: Record<string, unknown> = {};
let sessionsState: Record<string, unknown> = { currentSessionId: "run-1", sessions: [], loaded: true };

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
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn() }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ tenantName: "Acme", role: "owner" }),
  useWorkspaceOptional: () => ({ tenantName: "Acme", role: "owner" }),
}));
vi.mock("@/components/voice/MicButton", () => ({ MicButton: () => null }));
vi.mock("@/lib/workspace/buildFraming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/buildFraming")>()),
  useSiteListFirst: () => false,
}));

import { BuildModePane, BACKGROUND_PUBLISH_PLACEHOLDER } from "./BuildModePane";

const DONE_STAGES = [
  { stage: "provision", status: "done", finished_at: "2026-09-29T07:01:00Z" },
  { stage: "spec", status: "done", finished_at: "2026-09-29T07:03:00Z" },
  { stage: "scaffold", status: "done", finished_at: "2026-09-29T07:06:00Z" },
  { stage: "build", status: "done", finished_at: "2026-09-29T07:12:30Z" },
];

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    objective: "Build product: A bakery site",
    status: "active",
    createdAt: "2026-09-29T07:00:00Z",
    updatedAt: "2026-09-29T07:40:00Z",
    stages: DONE_STAGES,
    failure: null,
    ...overrides,
  };
}

const sendRefine = vi.fn(async () => null);
const cancelRun = vi.fn(async () => null);
const continueRun = vi.fn(async (): Promise<{ code: string; message: string } | null> => null);

function session(overrides: Record<string, unknown> = {}) {
  return {
    loaded: true,
    notFound: false,
    loadError: null,
    authExpired: false,
    run: run(),
    isCurrent: true,
    retired: false,
    previewUrl: "https://3000-sbx.e2b.app",
    previewKind: "instant",
    liveUrl: null,
    repoUrl: null,
    refines: [],
    refinesLoaded: true,
    appReady: true,
    appReadyAt: "2026-09-29T07:13:00Z",
    publish: { status: "publishing", startedAt: "2026-09-29T07:12:40Z", url: "https://bakery.onrender.com" },
    sendRefine,
    refineSubmitting: false,
    cancelRun,
    stopping: false,
    continueRun,
    continuing: false,
    retry: vi.fn(),
    ...overrides,
  };
}

function renderPane(sessionId: string | null = "run-1") {
  return render(paneElement(sessionId));
}

function paneElement(sessionId: string | null = "run-1") {
  return (
    <BuildModePane
      sessionId={sessionId}
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

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  sendRefine.mockClear();
  cancelRun.mockClear();
  continueRun.mockReset();
  continueRun.mockResolvedValue(null);
  sessionsState = { currentSessionId: "run-1", sessions: [], loaded: true };
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const SITE_STAGES = [
  { stage: "provision", status: "done", finished_at: "2026-09-29T07:01:00Z" },
  { stage: "build", status: "done", finished_at: "2026-09-29T07:12:30Z" },
];

function liveSite(overrides: Record<string, unknown> = {}) {
  return session({
    run: run({ status: "done", stages: SITE_STAGES }),
    liveUrl: "https://bakery.zaviagent.com",
    previewKind: "final",
    previewUrl: "https://bakery.zaviagent.com",
    publish: { status: "live", startedAt: null, url: "https://bakery.zaviagent.com" },
    ...overrides,
  });
}

function listed(state: string) {
  sessionsState = {
    currentSessionId: "run-1",
    loaded: true,
    sessions: [{ id: "run-1", title: "A bakery site", state, run_status: "done", is_current: true, refine_count: 1 }],
  };
}

function trySend(text: string) {
  const box = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
  return box;
}

describe("Build pane while a live site republishes in the background", () => {
  it("locks the composer while the republish runs and never sends a change into it", () => {
    sessionState = liveSite();
    listed("building");
    const view = renderPane();
    const box = trySend("Change the hero title to Fresh bread daily");
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe(BACKGROUND_PUBLISH_PLACEHOLDER);
    expect(sendRefine).not.toHaveBeenCalled();
    expect(view.container.textContent ?? "").not.toMatch(/publish/i);
  });

  it("opens the composer again once the republish is done", () => {
    sessionState = liveSite();
    listed("ready");
    renderPane();
    const box = trySend("Change the hero title to Fresh bread daily");
    expect(box.disabled).toBe(false);
    expect(sendRefine).toHaveBeenCalledTimes(1);
  });

  it("does not lock the composer for a change that is already running in the chat", () => {
    sessionState = liveSite({
      refines: [{ id: "ref-1", status: "active", message: "Make the footer blue", created_at: "2026-09-29T07:30:00Z", updated_at: "2026-09-29T07:31:00Z" }],
    });
    listed("building");
    renderPane();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    expect(box.placeholder).not.toBe(BACKGROUND_PUBLISH_PLACEHOLDER);
  });
});
