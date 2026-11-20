// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let sessionState: Record<string, unknown> = {};

const startBuildSession = vi.fn();
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
}));
vi.mock("@/components/voice/MicButton", () => ({
  MicButton: () => null,
}));

vi.mock("@/lib/workspace/builderClarifyFlag", () => ({
  isBuilderClarifyEnabled: () => false,
  isBuilderClarifyDynamicEnabled: () => false,
}));

import { BuildModePane } from "./BuildModePane";

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

function renderPane() {
  render(
    <BuildModePane
      sessionId="b1"
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
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  startBuildSession.mockReset();
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe("BuildModePane unresolved-session states", () => {
  it("shows the build composer with a notice when the session expired", () => {
    sessionState = session({ authExpired: true });
    renderPane();

    expect(screen.getByRole("textbox")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/Your session expired/)).toBeTruthy();
    expect(screen.queryByText(/HTTP 401/)).toBeNull();
    expect(screen.queryByText("This build isn't available")).toBeNull();
    expect(screen.queryByText("Couldn't load this build")).toBeNull();
  });

  it("shows the build composer with a notice when the build is not in this workspace", () => {
    sessionState = session({ notFound: true });
    renderPane();

    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(screen.getByText(/isn't in this workspace/)).toBeTruthy();
    expect(screen.queryByText("This build isn't available")).toBeNull();
  });

  it("keeps the composer usable so a failed id can start a new build", () => {
    sessionState = session({ notFound: true });
    renderPane();

    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
  });

  it("offers a retry, not a dead end, when the load errored", () => {
    const retry = vi.fn();
    sessionState = session({ loadError: "Couldn't reach the build service (HTTP 500).", retry });
    renderPane();

    expect(screen.getByRole("textbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("sends the user to login with a next back to this build", () => {
    sessionState = session({ authExpired: true });
    const location = { pathname: "/workspace", search: "?build=b1", href: "" };
    vi.stubGlobal("location", location as unknown as Location);
    renderPane();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(location.href).toBe(`/login?next=${encodeURIComponent("/workspace?build=b1")}`);
    vi.unstubAllGlobals();
  });

  it("shows why a start from this screen was refused, instead of looking like a no-op", async () => {
    startBuildSession.mockResolvedValue({ error: "You already have a build running." });
    sessionState = session({ notFound: true });
    renderPane();

    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "build me a booking page for my studio" } });
    fireEvent.click(screen.getByRole("button", { name: "Build app" }));

    await waitFor(() =>
      expect(screen.getByText("You already have a build running.")).toBeTruthy(),
    );
  });

  it("takes precedence over notFound, so a 401 never reads as a missing build", () => {
    sessionState = session({ authExpired: true, notFound: true });
    renderPane();

    expect(screen.getByText(/Your session expired/)).toBeTruthy();
    expect(screen.queryByText(/isn't in this workspace/)).toBeNull();
  });
});
