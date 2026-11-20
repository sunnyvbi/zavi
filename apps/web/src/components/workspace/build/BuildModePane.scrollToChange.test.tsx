// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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

import { BuildModePane, CHANGE_TITLE, SAVED_EDITS_TEXT, SAVE_FAILED_TEXT, SAVING_EDITS_TEXT } from "./BuildModePane";

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

const scrollIntoView = vi.fn();
const originalScrollIntoView = Element.prototype.scrollIntoView;
const FEED_HEIGHT = 2400;

beforeEach(() => {
  scrollIntoView.mockClear();
  sessionsState = { currentSessionId: "run-1", sessions: [], loaded: true };
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => FEED_HEIGHT });
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  vi.unstubAllGlobals();
});

const chatFeed = () => screen.getAllByText(/A bakery site/)[0].closest(".ws-scroll") as HTMLElement;

const applied = (status: string) => ({
  id: "ref-applied",
  status,
  message: "Applied 1 edit",
  created_at: "2026-09-29T07:30:00Z",
  updated_at: "2026-09-29T07:30:05Z",
});

const liveDone = (refines: unknown[]) =>
  session({
    run: run({ status: "done" }),
    publish: { status: "live", startedAt: null, url: "https://bakery.onrender.com" },
    refines,
  });

describe("the Build chat follows a change the founder just sent", () => {
  it("scrolls its own feed to the new Applied entry, and never scrolls the page around it", () => {
    sessionState = liveDone([]);
    const view = renderPane();
    const feed = chatFeed();
    feed.scrollTop = 120;

    sessionState = liveDone([applied("active")]);
    view.rerender(paneElement());

    expect(screen.getByText("Applied 1 edit")).toBeTruthy();
    expect(feed.scrollTop).toBe(FEED_HEIGHT);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("follows the change again when its status moves on", () => {
    sessionState = liveDone([applied("queued")]);
    const view = renderPane();
    const feed = chatFeed();
    feed.scrollTop = 0;

    sessionState = liveDone([applied("active")]);
    view.rerender(paneElement());

    expect(feed.scrollTop).toBe(FEED_HEIGHT);
  });
});

describe("a text edit the founder just sent from the preview", () => {
  it("shows its Applied line at once with a quiet saving note, not a running change card", () => {
    sessionState = {
      ...liveDone([]),
      savingEdits: [{ id: "saving:1", status: "saving", message: "Applied 2 edits", created_at: "2026-09-29T07:31:00Z", saving: true }],
    };
    renderPane();
    expect(screen.getByText("Applied 2 edits")).toBeTruthy();
    expect(screen.getByText(SAVING_EDITS_TEXT)).toBeTruthy();
    expect(screen.queryByText(CHANGE_TITLE)).toBeNull();
    expect(screen.queryByText("Update in progress")).toBeNull();
  });

  it("puts the working state on the agent's side, never as a Saving note under the founder's bubble", () => {
    sessionState = {
      ...liveDone([]),
      savingEdits: [{ id: "saving:1", status: "saving", message: "Applied 1 edit", created_at: "2026-09-29T07:31:00Z", saving: true }],
    };
    renderPane();
    expect(screen.queryByText(/^Saving/)).toBeNull();
    const turn = screen.getByTestId("saving-edits");
    const reply = screen.getByTestId("saving-edits-reply");
    const bubble = screen.getByText("Applied 1 edit");
    expect(reply.contains(bubble)).toBe(false);
    expect(turn.querySelectorAll("[role='status']")).toHaveLength(1);
    const status = reply.querySelector("[role='status']")!;
    expect(status.textContent).toBe(SAVING_EDITS_TEXT);
    expect(status.querySelector(".animate-spin")).not.toBeNull();
    expect(reply.querySelector("img")).not.toBeNull();
    expect(bubble.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("turns into the Ready in your preview card when the server confirms, with no spinner left", () => {
    sessionState = {
      ...liveDone([]),
      savingEdits: [{ id: "saving:1", status: "saved", message: "Changed the brand colour", created_at: "2026-09-29T07:31:00Z", saving: true }],
    };
    renderPane();
    const reply = screen.getByTestId("saving-edits-reply");
    expect(reply.textContent).toBe(SAVED_EDITS_TEXT);
    expect(reply.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByText(SAVING_EDITS_TEXT)).toBeNull();
  });

  it("a failed change shows the reason on the agent's side as an alert", () => {
    sessionState = {
      ...liveDone([]),
      savingEdits: [
        { id: "saving:1", status: "failed", message: "Changed the theme", created_at: "2026-09-29T07:31:00Z", saving: true, failure_message: "We couldn't save that change." },
      ],
    };
    renderPane();
    const alert = screen.getByTestId("saving-edits-reply").querySelector("[role='alert']")!;
    expect(alert.textContent).toBe(`${SAVE_FAILED_TEXT}We couldn't save that change.`);
    expect(screen.queryByText(SAVING_EDITS_TEXT)).toBeNull();
    expect(screen.queryByText(SAVED_EDITS_TEXT)).toBeNull();
  });
});
