// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const confirmAction = vi.fn();
const cancelRun = vi.fn(async (_id?: string) => null as string | null);
let sessionState: Record<string, unknown> = {};

vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: vi.fn(),
  useBuildSession: () => sessionState,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({ currentSessionId: "run-1", sessions: [], loaded: true }),
  readBuildSessions: () => ({ currentSessionId: "run-1", sessions: [], loaded: true }),
  refreshBuildSessions: vi.fn(async () => {}),
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({
  confirmAction: (...args: unknown[]) => confirmAction(...args),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ tenantName: "Acme", role: "owner" }),
  useWorkspaceOptional: () => ({ tenantName: "Acme", role: "owner" }),
}));
vi.mock("@/components/voice/MicButton", () => ({ MicButton: () => null }));

import { BuildModePane } from "./BuildModePane";

function run(status: string) {
  return {
    id: "run-1",
    objective: "Build product: A bakery site",
    status,
    createdAt: "2026-09-25T07:00:00Z",
    updatedAt: "2026-09-25T07:10:00Z",
    stages: [{ stage: "provision", status: status === "done" ? "done" : "running" }],
    failure: null,
  };
}

function refine(id: string, status: string, created_at: string) {
  return { id, message: `change ${id}`, status, created_at };
}

function session(overrides: Record<string, unknown>) {
  return {
    loaded: true,
    notFound: false,
    loadError: null,
    authExpired: false,
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
    cancelRun,
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
    retry: vi.fn(),
    ...overrides,
  };
}

function renderPane() {
  return render(<Pane />);
}

function Pane() {
  return (
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
  );
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  confirmAction.mockReset();
  cancelRun.mockClear();
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

const liveApp = { run: run("done"), liveUrl: "https://bakery.example.com", previewKind: "final" };

describe("Build composer Stop", () => {
  it("a running build swaps Send for Stop in the composer and stops the build after confirming", async () => {
    sessionState = session({ run: run("active") });
    confirmAction.mockResolvedValue(true);
    renderPane();

    expect(screen.queryByRole("button", { name: "Build app" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send update" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop build" }));

    await waitFor(() => expect(cancelRun).toHaveBeenCalledTimes(1));
    expect(cancelRun.mock.calls[0][0]).toBeUndefined();
  });

  it("stops the change that is running, not the finished build under it or an older change", async () => {
    sessionState = session({
      ...liveApp,
      refines: [
        refine("ref-old", "done", "2026-09-25T08:00:00Z"),
        refine("ref-live", "running", "2026-09-25T09:00:00Z"),
      ],
    });
    confirmAction.mockResolvedValue(true);
    renderPane();

    fireEvent.click(screen.getByRole("button", { name: "Stop change" }));

    await waitFor(() => expect(cancelRun).toHaveBeenCalledTimes(1));
    expect(cancelRun).toHaveBeenCalledWith("ref-live");
    expect(confirmAction.mock.calls[0][0]).toMatchObject({ title: "Stop this change?" });
  });

  it("a failed change-stop says so beside the composer, not on the finished build card", async () => {
    sessionState = session({
      ...liveApp,
      refines: [refine("ref-live", "running", "2026-09-25T09:00:00Z")],
    });
    confirmAction.mockResolvedValue(true);
    cancelRun.mockResolvedValueOnce("Couldn't stop the build (HTTP 500).");
    renderPane();

    fireEvent.click(screen.getByRole("button", { name: "Stop change" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't stop the build (HTTP 500).");
    expect(alert.nextElementSibling?.querySelector("textarea") ?? alert.parentElement?.querySelector("textarea")).not.toBeNull();
  });

  it("a build that ran out of credits after a failed stop still offers no Retry in the Send slot", async () => {
    sessionState = session({ run: run("active") });
    confirmAction.mockResolvedValue(true);
    cancelRun.mockResolvedValueOnce("Couldn't stop the build (HTTP 500).");
    const view = renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Stop build" }));
    await screen.findByText("Couldn't stop the build (HTTP 500).");

    sessionState = session({
      run: { ...run("failed"), failure: { message: "insufficient_credits: repair dispatch refused" } },
    });
    view.rerender(<Pane />);

    expect(screen.queryByRole("button", { name: "Retry build" })).toBeNull();
  });

  it("a declined confirm stops nothing", async () => {
    sessionState = session({
      ...liveApp,
      refines: [refine("ref-live", "queued", "2026-09-25T09:00:00Z")],
    });
    confirmAction.mockResolvedValue(false);
    renderPane();

    fireEvent.click(screen.getByRole("button", { name: "Stop change" }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("typing a follow-up while a change runs brings Send back, so Stop never eats a message", () => {
    sessionState = session({
      ...liveApp,
      refines: [refine("ref-live", "running", "2026-09-25T09:00:00Z")],
    });
    renderPane();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Make the header darker" } });

    expect(screen.queryByRole("button", { name: "Stop change" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send update" })).toBeTruthy();
  });

  it("an idle live app shows Send, never Stop", () => {
    sessionState = session({ ...liveApp, refines: [refine("ref-old", "done", "2026-09-25T08:00:00Z")] });
    renderPane();

    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Send update" })).toBeTruthy();
  });

  it("a sent change spins a solid Send circle while it starts, then shows the Stop square once it runs", () => {
    sessionState = session({ ...liveApp, refineSubmitting: true });
    const { rerender } = renderPane();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Make the header darker" } });

    const sending = screen.getByRole("button", { name: "Send update" }) as HTMLButtonElement;
    expect(sending.getAttribute("aria-busy")).toBe("true");
    expect(sending.querySelector(".animate-spin")).not.toBeNull();
    expect(sending.querySelector(".lucide-arrow-up")).toBeNull();
    expect(sending.className).not.toContain("bg-ink/15");
    expect(sending.disabled).toBe(true);

    sessionState = session({
      ...liveApp,
      refines: [refine("ref-live", "running", "2026-09-25T09:00:00Z")],
    });
    rerender(<Pane />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });

    const stop = screen.getByRole("button", { name: "Stop change" });
    expect(stop.querySelector(".lucide-square")).not.toBeNull();
    expect(stop.querySelector(".animate-spin")).toBeNull();
  });

  it("the arrow returns once the running change settles", () => {
    sessionState = session({
      ...liveApp,
      refines: [refine("ref-live", "running", "2026-09-25T09:00:00Z")],
    });
    const { rerender } = renderPane();
    expect(screen.getByRole("button", { name: "Stop change" })).toBeTruthy();

    sessionState = session({
      ...liveApp,
      refines: [refine("ref-live", "failed", "2026-09-25T09:00:00Z")],
    });
    rerender(<Pane />);
    const send = screen.getByRole("button", { name: "Send update" });
    expect(send.querySelector(".lucide-arrow-up")).not.toBeNull();
    expect(send.querySelector(".animate-spin")).toBeNull();
  });

  it("a second press while the stop is in flight does nothing", () => {
    sessionState = session({ run: run("active"), stopping: true });
    renderPane();

    const stop = screen.getByRole("button", { name: "Stop build" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    fireEvent.click(stop);
    expect(confirmAction).not.toHaveBeenCalled();
  });
});
