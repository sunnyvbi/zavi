// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const h = vi.hoisted(() => ({
  build: { value: {} as Record<string, unknown> },
  session: { value: {} as Record<string, unknown> },
  ui: { mobileActions: true, publishWaitsForApp: true } as Record<string, boolean>,
  wide: false,
  finePointer: false,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => new URLSearchParams("tab=build"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    tabs: [{ id: "tab-build", kind: "build", title: "Build", payload: { kind: "build", sessionId: "s1" } }],
    activeTabId: "tab-build",
    setActiveTab: vi.fn(),
    openTab: vi.fn(),
    openBuildTab: vi.fn(),
    openAgentTab: vi.fn(),
    buildSessionId: "s1",
    userEmail: "founder@example.com",
    setTabThreadId: vi.fn(),
  }),
}));
vi.mock("../navigation/useWorkspaceLocation", () => ({ useWorkspaceLocation: () => ({ tab: "build" }) }));
vi.mock("./useNewTaskLanding", () => ({ useNewTaskLanding: () => {} }));
vi.mock("./ContextPanel", () => ({ ContextPanel: () => null, ContextRail: () => null }));
vi.mock("./View360", () => ({ View360: () => null }));
vi.mock("./ChannelsPanel", () => ({ ChannelsPanel: () => null }));
vi.mock("./ChannelsPage", () => ({ useOpenChannelSlug: () => null }));
vi.mock("./WorkspaceDrawer", () => ({ WorkspaceDrawer: () => null }));
vi.mock("./CompactNavOverlay", () => ({ CompactNavOverlay: () => null }));
vi.mock("../WorkspacePane", () => ({ WorkspacePane: () => <div data-testid="grow-pane" /> }));
vi.mock("../useProductUrl", () => ({
  useProductUrlState: () => ({ status: "ok", value: {} }),
  retryProductUrl: vi.fn(),
}));
vi.mock("../build/BuildModePane", async (importOriginal) => {
  const { useEffect } = await import("react");
  return {
    ...(await importOriginal<typeof import("../build/BuildModePane")>()),
    BuildModePane: (p: {
      onPreviewProgress: (progress: unknown) => void;
      onOpenPreview: (target: unknown) => void;
    }) => {
      useEffect(() => {
        p.onPreviewProgress({ stages: [], failure: null, failed: false });
        p.onOpenPreview({
          url: "https://3000-sbx.e2b.app",
          appName: "Cake Co",
          kind: "instant",
          status: "building",
          objective: "Build product: cakes",
        });
      }, []);
      return <div data-testid="build-chat" />;
    },
  };
});
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({
    loaded: true,
    failed: false,
    currentSessionId: "s1",
    sessions: [{ id: "s1", title: "Cake Co", state: "building", run_status: "active" }],
    flags: { siteNames: false, siteRepoChip: false, siteListDetails: false },
    uiFlags: h.ui,
  }),
  notifyBuildSessionsChanged: () => {},
}));
vi.mock("../home/ExportToGithubButton", () => ({ ExportToGithubButton: () => null, prefetchExportStatus: async () => undefined }));
vi.mock("../home/calm/HomeChatPanel", () => ({
  HomeChatPanel: (p: { narrowTrailing?: React.ReactNode; narrowHidden?: boolean }) => (
    <aside aria-label="App chat" data-narrow-hidden={p.narrowHidden ? "true" : "false"}>
      {p.narrowTrailing}
    </aside>
  ),
}));
vi.mock("../website/WebsitePreview", () => ({
  WebsitePreview: (p: { headerActions?: React.ReactNode; narrowTrailing?: React.ReactNode }) => (
    <div data-testid="preview-pane">
      {p.narrowTrailing}
      {p.headerActions}
    </div>
  ),
  chatEditErrorMessage: () => "",
}));
vi.mock("../website/WebsiteConsole", () => ({ WebsiteConsole: () => null }));
vi.mock("../build/BuildHistoryPanel", () => ({ BuildHistoryPanel: () => null }));
vi.mock("../build/AppCodePane", () => ({ AppCodePane: () => null, ReadOnlyBadge: () => null }));
vi.mock("../build/BuildFilesPane", () => ({ BuildFilesPane: () => null }));
vi.mock("../website/PublishPopover", () => ({ PublishPopover: () => <div data-testid="publish-popover" /> }));
vi.mock("../home/summaryState", () => ({ loadSummary: () => Promise.resolve(null) }));
vi.mock("@/lib/workspace/useBuildPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildPreview")>()),
  useBuildPreview: () => h.build.value,
  isTerminalBuildRun: (status: string | null) => status === "done" || status === "failed" || status === "paused",
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
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => "t", update: () => {}, close: () => {} } }));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (path === "/api/connectors/product-url" ? { product_url: {} } : { resources: [] }),
    }),
}));

import { WorkspaceLayout } from "./WorkspaceLayout";

function setMidBuild() {
  h.build.value = {
    loaded: true,
    classified: true,
    building: true,
    runStatus: "active",
    runId: "s1",
    objective: "Build product: cakes",
    stages: [],
    createdAt: null,
    updatedAt: null,
    previewUrl: "https://3000-sbx.e2b.app",
    previewKind: "instant",
    failure: null,
    appReady: false,
    publish: { status: "none", startedAt: null, url: null, retryable: false },
    site: null,
    settledNonce: 0,
  };
  h.session.value = {
    loaded: true,
    run: { id: "s1", status: "active" },
    isCurrent: true,
    retired: false,
    refines: [],
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

beforeEach(() => {
  h.ui = { mobileActions: true, publishWaitsForApp: true };
  setMidBuild();
  window.history.replaceState(null, "", "/workspace?tab=build");
  window.matchMedia = ((query: string) => ({
    matches: query.includes("pointer") ? h.finePointer : h.wide ? query.includes("min-width") : query.includes("max-width"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  h.wide = false;
  h.finePointer = false;
});

function scrollable(el: Element, top: number, left = 0) {
  const box = { top, left };
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => box.top, set: (v: number) => { box.top = v; } });
  Object.defineProperty(el, "scrollLeft", { configurable: true, get: () => box.left, set: (v: number) => { box.left = v; } });
  return box;
}

function pageScroll(y: number) {
  Object.defineProperty(window, "scrollY", { configurable: true, value: y });
  Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
}

describe("a focus or scrollIntoView deep in a column never moves the whole workspace", () => {
  afterEach(() => {
    pageScroll(0);
    vi.restoreAllMocks();
  });

  it("the shell snaps a programmatic scroll back to the top, so the columns keep the full height", async () => {
    h.wide = true;
    const { container } = render(<WorkspaceLayout />);
    await flush();
    const shell = container.querySelector(".workspace-shell")!;
    const box = scrollable(shell, 360, 40);
    fireEvent.scroll(shell);
    expect(box).toEqual({ top: 0, left: 0 });
  });

  it("the page itself is pinned at the top on desktop, so the shell is never pushed up past the viewport", async () => {
    h.wide = true;
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(<WorkspaceLayout />);
    await flush();
    scrollTo.mockClear();
    pageScroll(360);
    fireEvent.scroll(window);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("a phone keeps its own page scroll for the on-screen keyboard", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(<WorkspaceLayout />);
    await flush();
    pageScroll(360);
    fireEvent.scroll(window);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("a tablet keeps the page scroll Safari makes to lift a focused field above the keyboard", async () => {
    h.wide = true;
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const { container } = render(<WorkspaceLayout />);
    await flush();
    const field = document.createElement("textarea");
    container.appendChild(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    scrollTo.mockClear();
    pageScroll(360);
    fireEvent.scroll(window);
    expect(scrollTo).not.toHaveBeenCalled();
    field.blur();
    fireEvent.scroll(window);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("a mouse-driven desktop still undoes the page scroll from focusing the chat box after send", async () => {
    h.wide = true;
    h.finePointer = true;
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const { container } = render(<WorkspaceLayout />);
    await flush();
    const field = document.createElement("textarea");
    container.appendChild(field);
    field.focus();
    scrollTo.mockClear();
    pageScroll(360);
    fireEvent.scroll(window);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});
