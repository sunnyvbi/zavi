// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const startBuildSession = vi.fn();
const apiFetch = vi.fn();
let sessionState: Record<string, unknown> = {};

vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: (...args: unknown[]) => startBuildSession(...args),
  useBuildSession: () => sessionState,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({ currentSessionId: null }),
}));
let role: string | null = "member";
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ tenantName: "Acme", role }),
  useWorkspaceOptional: () => ({ tenantName: "Acme", role }),
}));
vi.mock("@/components/voice/MicButton", () => ({ MicButton: () => null }));
vi.mock("@/lib/workspace/builderClarifyFlag", () => ({
  isBuilderClarifyEnabled: () => true,
  isBuilderClarifyDynamicEnabled: () => false,
}));

import { BuildModePane, START_SITE_ROLE_ERROR, START_SITE_VIEWER_ERROR, canStartNewSite } from "./BuildModePane";

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
    sendRefine: vi.fn(async () => null),
    refineSubmitting: false,
    cancelRun: vi.fn(),
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
    retry: vi.fn(),
    ...overrides,
  };
}

function renderPane(sessionId: string | null) {
  const onOpenSession = vi.fn();
  render(
    <BuildModePane
      sessionId={sessionId}
      active
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

function composer(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: /describe/i }) as HTMLTextAreaElement;
}

function typeAndSend(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.keyDown(composer(), { key: "Enter" });
}

function planReply(markdown: string) {
  return { ok: true, status: 200, json: async () => ({ plan_markdown: markdown }) };
}

const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => {
  startBuildSession.mockReset();
  apiFetch.mockReset();
  sessionState = baseSession();
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
});

describe("a member is told before the questions that only an owner or admin starts a site", () => {
  it("a member's idea never opens the questions or reaches the server, and the typed idea stays", () => {
    role = "member";
    renderPane(null);
    typeAndSend("A site for a neighbourhood bike repair shop");
    expect(screen.queryByText("What do you have in mind for the name?")).toBeNull();
    expect(screen.getByText(START_SITE_ROLE_ERROR)).toBeTruthy();
    expect(startBuildSession).not.toHaveBeenCalled();
    expect(composer().value).toBe("A site for a neighbourhood bike repair shop");
  });

  it("a viewer is refused without being told they can change sites", () => {
    role = "viewer";
    renderPane(null);
    typeAndSend("A site for a neighbourhood bike repair shop");
    expect(screen.getByText(START_SITE_VIEWER_ERROR)).toBeTruthy();
    expect(screen.queryByText(START_SITE_ROLE_ERROR)).toBeNull();
    expect(startBuildSession).not.toHaveBeenCalled();
  });

  it("an admin still gets the questions first", () => {
    role = "admin";
    renderPane(null);
    typeAndSend("A site for a neighbourhood bike repair shop");
    expect(screen.getByText("What do you have in mind for the name?")).toBeTruthy();
    expect(screen.queryByText(START_SITE_ROLE_ERROR)).toBeNull();
  });

  it("an unknown role is left to the server, which still checks it", () => {
    expect(canStartNewSite(null)).toBe(true);
    expect(canStartNewSite(undefined)).toBe(true);
    expect(canStartNewSite("owner")).toBe(true);
    expect(canStartNewSite("member")).toBe(false);
  });
});
