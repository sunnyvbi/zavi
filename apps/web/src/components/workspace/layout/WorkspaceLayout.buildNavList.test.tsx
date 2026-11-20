// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  build: { value: {} as Record<string, unknown> },
  session: { value: {} as Record<string, unknown> },
  ui: { mobileActions: true, publishWaitsForApp: true } as Record<string, boolean>,
  wide: false,
  sid: "s1" as string | null,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => new URLSearchParams("tab=build"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    tabs: [{ id: "tab-build", kind: "build", title: "Build", payload: { kind: "build", sessionId: h.sid, threadId: null } }],
    activeTabId: "tab-build",
    setActiveTab: vi.fn(),
    openTab: vi.fn(),
    openBuildTab: vi.fn(),
    openAgentTab: vi.fn(),
    buildSessionId: h.sid,
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
      sessionId: string | null;
      onPreviewProgress: (progress: unknown) => void;
      onOpenPreview: (target: unknown) => void;
    }) => {
      useEffect(() => {
        if (!p.sessionId) return;
        p.onPreviewProgress({ stages: [], failure: null, failed: false });
        p.onOpenPreview({
          url: "https://cake-co.zavi.site",
          appName: "Cake Co",
          kind: "final",
          status: "done",
          objective: "Build product: cakes",
        });
      }, [p.sessionId]);
      return p.sessionId ? <div data-testid="build-chat" /> : <section data-testid="build-site-list" aria-label="Your sites" />;
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
  HomeChatPanel: (p: { narrowTrailing?: React.ReactNode }) => <aside aria-label="App chat">{p.narrowTrailing}</aside>,
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

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function isShown(el: HTMLElement | null): boolean {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.classList.contains("hidden") || node.hidden || node.getAttribute("aria-hidden") === "true") return false;
  }
  return !!el;
}

beforeEach(() => {
  h.sid = "s1";
  h.wide = true;
  h.build.value = {
    loaded: true,
    classified: true,
    building: false,
    runStatus: "done",
    runId: "s1",
    objective: "Build product: cakes",
    stages: [],
    createdAt: null,
    updatedAt: null,
    previewUrl: "https://cake-co.zavi.site",
    previewKind: "final",
    failure: null,
    appReady: true,
    publish: { status: "live", startedAt: null, url: "https://cake-co.zavi.site", retryable: false },
    site: null,
    settledNonce: 0,
  };
  h.session.value = {
    loaded: true,
    run: { id: "s1", status: "done" },
    isCurrent: true,
    retired: false,
    refines: [],
    refinesLoaded: true,
    cancelRun: vi.fn(async () => null),
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
  };
  window.history.replaceState(null, "", "/workspace?tab=build&build=s1");
  window.matchMedia = ((query: string) => ({
    matches: h.wide ? query.includes("min-width") : query.includes("max-width"),
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
});

describe("l4.1: Build in the sidebar from inside a build shows Your sites, like a fresh load", () => {
  it("leaving a build for the list drops the old preview and shows the list, not an empty chat beside it", async () => {
    const view = render(<WorkspaceLayout />);
    await flush();
    expect(screen.getByTestId("preview-pane")).toBeTruthy();

    h.sid = null;
    view.rerender(<WorkspaceLayout />);
    await flush();

    expect(screen.queryByTestId("preview-pane")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "App chat" })).toBeNull();
    expect(isShown(screen.getByTestId("build-site-list"))).toBe(true);
  });

  it("matches a fresh load of the list", async () => {
    h.sid = null;
    window.history.replaceState(null, "", "/workspace?tab=build");
    render(<WorkspaceLayout />);
    await flush();
    expect(screen.queryByTestId("preview-pane")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "App chat" })).toBeNull();
    expect(isShown(screen.getByTestId("build-site-list"))).toBe(true);
  });

  it("opening another build from the list still brings its preview", async () => {
    const view = render(<WorkspaceLayout />);
    await flush();
    h.sid = null;
    view.rerender(<WorkspaceLayout />);
    await flush();
    h.sid = "s2";
    view.rerender(<WorkspaceLayout />);
    await flush();
    expect(screen.getByTestId("preview-pane")).toBeTruthy();
  });
});
