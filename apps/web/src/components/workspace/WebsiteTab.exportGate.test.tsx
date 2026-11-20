// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: { value: {} as Record<string, unknown> },
  build: { value: {} as Record<string, unknown> },
  continueRun: { fn: null as null | ((...a: unknown[]) => Promise<{ code: string; message: string } | null>) },
  reads: { productUrl: 0 },
  chatProps: { last: null as null | { sendBlockedNotice?: string | null } },
  ui: { mobileActions: true } as Record<string, boolean>,
  refreshedAfterEdit: [] as string[],
}));

vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({
    loaded: true,
    currentSessionId: "s1",
    sessions: [],
    flags: { siteNames: false, siteRepoChip: false, siteListDetails: false },
    uiFlags: h.ui,
  }),
  notifyBuildSessionsChanged: () => {},
}));
vi.mock("./home/ExportToGithubButton", () => ({
  prefetchExportStatus: async () => undefined,
  refreshExportStatusAfterEdit: (buildId: string) => {
    h.refreshedAfterEdit.push(buildId);
    return Promise.resolve();
  },
  ExportToGithubButton: () => <div data-testid="export-github" />,
}));

vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({
    userEmail: "founder@example.com",
    openTab: vi.fn(),
    tabs: [{ id: "tab-build", payload: { kind: "build", sessionId: "s1" } }],
    setTabThreadId: vi.fn(),
  }),
}));
vi.mock("./home/calm/HomeChatPanel", () => ({
  HomeChatPanel: (p: { sendBlockedNotice?: string | null; narrowTrailing?: React.ReactNode }) => {
    h.chatProps.last = p;
    return <aside aria-label="Chat">{p.narrowTrailing}</aside>;
  },
}));
vi.mock("./website/WebsitePreview", () => ({
  WebsitePreview: (p: { headerActions?: React.ReactNode; body?: React.ReactNode; narrowTrailing?: React.ReactNode }) => (
    <div data-testid="preview-pane">
      <iframe data-testid="site-frame" title="Site preview" />
      <div data-testid="preview-narrow">{p.narrowTrailing}</div>
      {p.headerActions}
      {p.body ? <div data-testid="progress-body">{p.body}</div> : null}
    </div>
  ),
  chatEditErrorMessage: () => "",
}));
vi.mock("./website/WebsiteConsole", () => ({ WebsiteConsole: () => <div data-testid="console" /> }));
vi.mock("./build/BuildHistoryPanel", () => ({ BuildHistoryPanel: () => null }));
vi.mock("./build/AppCodePane", () => ({ AppCodePane: () => null, ReadOnlyBadge: () => null }));
vi.mock("./build/BuildFilesPane", () => ({ BuildFilesPane: () => null }));
vi.mock("./website/PublishPopover", () => ({
  PublishPopover: () => <div data-testid="publish-popover" />,
}));
vi.mock("./home/summaryState", () => ({ loadSummary: () => Promise.resolve(null) }));
vi.mock("@/lib/workspace/useBuildPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildPreview")>()),
  useBuildPreview: () => h.build.value,
  isTerminalBuildRun: (status: string | null) =>
    status === "done" || status === "failed" || status === "paused",
}));
vi.mock("@/lib/workspace/optimisticBuildStart", () => ({ useOptimisticBuildStart: () => false }));
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  useBuildSession: () => h.session.value,
}));
vi.mock("@/lib/workspace/useLiveEdit", () => ({
  useLiveEdit: () => ({
    state: {
      enabled: false,
      refine_active: false,
      preview: { status: "idle", url: null },
      draft: { ahead_by: 0, behind_by: 0, changes: [] },
    },
    frameUrl: null,
    refresh: vi.fn(),
    publish: vi.fn(),
    discard: vi.fn(),
    wake: vi.fn(),
  }),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => "t", update: () => {} } }));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
    if (path === "/api/connectors/product-url") h.reads.productUrl += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () =>
        path === "/api/connectors/product-url"
          ? { product_url: {} }
          : {
              resources: [
                { resource_kind: "domain", status: "ready", external_ref: { status: "live", hostname: "bikes.zaviagent.com" } },
                { resource_kind: "hosting", status: "ready", external_ref: { url: "https://bikes.onrender.com" } },
                { resource_kind: "repo", status: "ready", mode: "provisioned", external_ref: { html_url: "https://github.com/Praxis-build/bikes" } },
              ],
            },
    });
  },
}));

import { AppWorkspace } from "./WebsiteTab";

type Refine = { id: string; status: string; message: string; created_at: string };
const refine = (id: string): Refine => ({ id, status: "done", message: id, created_at: "2026-11-05T07:00:00Z" });

function setBuild(runStatus: string, previewUrl: string | null, previewState: "starting" | "stopped" | null = null, refines: Refine[] = []) {
  h.build.value = {
    loaded: true,
    previewState,
    classified: true,
    building: runStatus === "active",
    runStatus,
    runId: "s1",
    objective: "Build product: bikes",
    stages: [],
    createdAt: null,
    updatedAt: null,
    previewUrl,
    previewKind: previewUrl ? "final" : "none",
    failure: null,
    appReady: runStatus === "done",
    publish: { status: runStatus === "done" ? "live" : "none", startedAt: null, url: null, retryable: false },
    settledNonce: 0,
  };
  h.session.value = {
    loaded: true,
    run: { id: "s1", status: runStatus },
    isCurrent: true,
    retired: false,
    refines,
    refinesLoaded: true,
    cancelRun: vi.fn(async () => null),
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const chatPane = () => screen.getByRole("complementary", { name: "Chat" });

function openMenu(from: HTMLElement): HTMLElement {
  fireEvent.click(within(from).getByRole("button", { name: "More actions" }));
  return within(from).getByRole("menu", { name: "More actions" });
}

beforeEach(() => {
  h.ui = { mobileActions: true, publishWaitsForApp: true };
  h.refreshedAfterEdit = [];
  window.history.replaceState(null, "", "/workspace?tab=build");
});
afterEach(() => cleanup());

const bar = () => within(screen.getByTestId("preview-pane"));

describe("GitHub export only once the build is done", () => {
  it("while the build runs there is no GitHub button in the bar and no Export item on the phone menu", async () => {
    setBuild("active", "https://3000-sbx.e2b.app");
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(bar().queryByRole("button", { name: "GitHub export" })).toBeNull();
    expect(screen.queryByTestId("build-export")).toBeNull();
    const items = within(openMenu(chatPane())).getAllByRole("menuitem").map((el) => el.textContent?.trim());
    expect(items).not.toContain("Export");
    expect(items).toContain("App settings");
  });

  it("a failed build shows no GitHub button either", async () => {
    setBuild("failed", null);
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(bar().queryByRole("button", { name: "GitHub export" })).toBeNull();
    expect(within(openMenu(chatPane())).queryByRole("menuitem", { name: "Export" })).toBeNull();
  });

  it("a finished build shows the GitHub button, opens the export, and offers Export on the phone", async () => {
    setBuild("done", "https://bikes.onrender.com");
    render(<AppWorkspace variant="build" />);
    await flush();
    fireEvent.click(bar().getByRole("button", { name: "GitHub export" }));
    expect(screen.getByRole("dialog", { name: "Export your code" })).toBeTruthy();
    expect(within(screen.getByRole("dialog", { name: "Export your code" })).getByTestId("export-github")).toBeTruthy();
    expect(within(openMenu(chatPane())).getByRole("menuitem", { name: "Export" })).toBeTruthy();
  });

  it("an export dialog open on a finished build closes and its button leaves when a new build starts", async () => {
    setBuild("done", "https://bikes.onrender.com");
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    fireEvent.click(bar().getByRole("button", { name: "GitHub export" }));
    expect(screen.getByRole("dialog", { name: "Export your code" })).toBeTruthy();
    setBuild("active", "https://3000-sbx.e2b.app");
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(screen.queryByRole("dialog", { name: "Export your code" })).toBeNull();
    expect(bar().queryByRole("button", { name: "GitHub export" })).toBeNull();
    setBuild("done", "https://bikes.onrender.com");
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(bar().getByRole("button", { name: "GitHub export" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Export your code" })).toBeNull();
  });

  it("a finished build whose preview stopped or is starting again hides the GitHub button until the preview is back", async () => {
    setBuild("done", "https://bikes.onrender.com");
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    fireEvent.click(bar().getByRole("button", { name: "GitHub export" }));
    expect(screen.getByRole("dialog", { name: "Export your code" })).toBeTruthy();
    setBuild("done", null, "stopped");
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(screen.queryByRole("dialog", { name: "Export your code" })).toBeNull();
    expect(bar().queryByRole("button", { name: "GitHub export" })).toBeNull();
    expect(within(openMenu(chatPane())).queryByRole("menuitem", { name: "Export" })).toBeNull();
    setBuild("done", null, "starting");
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(bar().queryByRole("button", { name: "GitHub export" })).toBeNull();
    setBuild("done", "https://bikes.onrender.com");
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(bar().getByRole("button", { name: "GitHub export" })).toBeTruthy();
  });

  it("an edit that lands while the export dialog is closed refreshes the export status, so opening it shows Export again at once", async () => {
    setBuild("done", "https://bikes.onrender.com", null, [refine("r1")]);
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    expect(h.refreshedAfterEdit).toEqual([]);
    setBuild("done", "https://bikes.onrender.com", null, [refine("r1"), refine("r2")]);
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(h.refreshedAfterEdit).toEqual(["s1"]);
    fireEvent.click(bar().getByRole("button", { name: "GitHub export" }));
    expect(screen.getByRole("dialog", { name: "Export your code" })).toBeTruthy();
    setBuild("done", "https://bikes.onrender.com", null, [refine("r1"), refine("r2"), refine("r3")]);
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(h.refreshedAfterEdit).toEqual(["s1"]);
  });

  it("a click into the preview iframe closes the export dialog, like a click anywhere else on the page", async () => {
    setBuild("done", "https://bikes.onrender.com");
    render(<AppWorkspace variant="build" />);
    await flush();
    fireEvent.click(bar().getByRole("button", { name: "GitHub export" }));
    expect(screen.getByRole("dialog", { name: "Export your code" })).toBeTruthy();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.getByRole("dialog", { name: "Export your code" })).toBeTruthy();
    const frame = screen.getByTestId("site-frame") as HTMLIFrameElement;
    act(() => {
      frame.focus();
      window.dispatchEvent(new Event("blur"));
    });
    expect(document.activeElement).toBe(frame);
    expect(screen.queryByRole("dialog", { name: "Export your code" })).toBeNull();
  });
});
