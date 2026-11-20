import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const RENDER_BREAKER = 200;

const h = vi.hoisted(() => ({
  session: { value: {} as Record<string, unknown> },
  renders: { count: 0 },
  wide: true,
  workspace: { value: {} as Record<string, unknown> },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => new URLSearchParams("tab=home"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => h.workspace.value,
}));
vi.mock("../navigation/useWorkspaceLocation", () => ({ useWorkspaceLocation: () => ({ tab: "home" }) }));
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
  const actual = await importOriginal<typeof import("../build/BuildModePane")>();
  return {
    ...actual,
    BuildModePane: (p: Parameters<typeof actual.BuildModePane>[0]) => {
      h.renders.count += 1;
      if (h.renders.count > RENDER_BREAKER) return null;
      return <actual.BuildModePane {...p} />;
    },
  };
});
vi.mock("@/lib/workspace/useBuildSessions", async (importOriginal) => {
  const value = {
    loaded: true,
    failed: false,
    currentSessionId: "s1",
    sessions: [{ id: "s1", title: "Cake Co", state: "ready", run_status: "done" }],
    flags: { siteNames: false, siteRepoChip: false, siteListDetails: false },
    uiFlags: {},
  };
  return {
    ...(await importOriginal<typeof import("@/lib/workspace/useBuildSessions")>()),
    useBuildSessions: () => value,
    notifyBuildSessionsChanged: () => {},
    refreshBuildSessions: () => Promise.resolve(),
  };
});
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  useBuildSession: () => h.session.value,
}));
vi.mock("@/lib/workspace/useBuildPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildPreview")>()),
  useBuildPreview: () => ({ loaded: false }),
}));
vi.mock("@/lib/workspace/optimisticBuildStart", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/optimisticBuildStart")>()),
  useOptimisticBuildStart: () => false,
}));
vi.mock("../home/ExportToGithubButton", () => ({ ExportToGithubButton: () => null, prefetchExportStatus: async () => undefined }));
vi.mock("../home/calm/HomeChatPanel", () => ({ HomeChatPanel: () => null }));
vi.mock("../website/WebsitePreview", () => ({
  WebsitePreview: () => <div data-testid="preview-pane" />,
  chatEditErrorMessage: () => "",
}));
vi.mock("../website/WebsiteConsole", () => ({ WebsiteConsole: () => null }));
vi.mock("../build/BuildHistoryPanel", () => ({ BuildHistoryPanel: () => null }));
vi.mock("../build/AppCodePane", () => ({ AppCodePane: () => null, ReadOnlyBadge: () => null }));
vi.mock("../build/BuildFilesPane", () => ({ BuildFilesPane: () => null }));
vi.mock("../home/summaryState", () => ({ loadSummary: () => Promise.resolve(null) }));
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => "t", update: () => {}, close: () => {} } }));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (path === "/api/connectors/product-url" ? { product_url: {} } : { resources: [], refines: [] }),
    }),
}));

import { INITIAL_SESSION } from "@/lib/workspace/useBuildSession";
import { WorkspaceLayout } from "./WorkspaceLayout";

const homeTab = { id: "tab-home", kind: "home", title: "Home", payload: { kind: "home" } };
const buildTab = { id: "tab-build", kind: "build", title: "Build", payload: { kind: "build", sessionId: "s1" } };
const operatorTab = { id: "tab-operator", kind: "agent", title: "Zavi", payload: { kind: "agent", slug: "operator" } };

function setWorkspace(activeTabId: string) {
  h.workspace.value = {
    tabs: [homeTab, buildTab, operatorTab],
    activeTabId,
    setActiveTab: vi.fn(),
    openTab: vi.fn(),
    openBuildTab: vi.fn(),
    openAgentTab: vi.fn(),
    buildSessionId: "s1",
    userEmail: "founder@example.com",
    setTabThreadId: vi.fn(),
    tenantName: "Cake Co",
    role: "owner",
  };
}

function setLiveBuild() {
  h.session.value = {
    ...INITIAL_SESSION,
    loaded: true,
    run: {
      id: "s1",
      status: "done",
      objective: "Build product: cakes",
      stages: [],
      failure: null,
      createdAt: "2026-10-05T10:00:00.000Z",
      updatedAt: "2026-10-05T10:20:00.000Z",
    },
    isCurrent: true,
    previewUrl: "https://cakes.zavi.app",
    previewKind: "final",
    liveUrl: "https://cakes.zavi.app",
    appReady: true,
    refinesLoaded: true,
    sendRefine: vi.fn(async () => null),
    refineSubmitting: false,
    cancelRun: vi.fn(async () => null),
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
    retry: vi.fn(),
  };
}

function setStoppedPreview(previewState: "stopped" | "starting") {
  setLiveBuild();
  h.session.value = {
    ...h.session.value,
    previewUrl: null,
    previewKind: null,
    liveUrl: null,
    previewState,
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

let consoleError: MockInstance<Parameters<typeof console.error>, ReturnType<typeof console.error>>;

beforeEach(() => {
  h.renders.count = 0;
  setWorkspace("tab-home");
  setLiveBuild();
  window.history.replaceState(null, "", "/workspace?tab=home");
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
  Element.prototype.scrollIntoView = () => {};
  consoleError = vi.spyOn(console, "error");
});

afterEach(() => {
  cleanup();
  consoleError.mockRestore();
  h.wide = true;
});

function depthWarnings() {
  return consoleError.mock.calls.filter((call) =>
    call.some((arg) => String(arg).includes("Maximum update depth exceeded")),
  );
}

describe("QA l3.5: a live build mounted behind Home does not loop the Build pane", () => {
  it.each([
    ["wide", true],
    ["narrow", false],
  ])("reloading /workspace?tab=home with a live build settles (%s)", async (_label, wide) => {
    h.wide = wide;
    render(<WorkspaceLayout />);
    await flush();
    await flush();

    expect(depthWarnings()).toEqual([]);
    expect(h.renders.count).toBeLessThan(15);
    expect(screen.queryByTestId("preview-pane")).toBeNull();
  });

  it("the live app still opens once the founder switches to the Build tab", async () => {
    const view = render(<WorkspaceLayout />);
    await flush();
    setWorkspace("tab-build");
    window.history.replaceState(null, "", "/workspace?tab=build");
    view.rerender(<WorkspaceLayout />);
    await flush();
    await flush();

    expect(depthWarnings()).toEqual([]);
    expect(screen.getByTestId("preview-pane")).toBeTruthy();
  });
});

describe("a build whose preview stopped, mounted behind another tab, does not loop the Build pane", () => {
  it.each([
    ["home, stopped, wide", "tab-home", "stopped", true],
    ["home, starting, wide", "tab-home", "starting", true],
    ["home, stopped, narrow", "tab-home", "stopped", false],
    ["Zavi chat, stopped, wide", "tab-operator", "stopped", true],
  ] as const)("reloading off the Build tab settles (%s)", async (_label, tabId, previewState, wide) => {
    h.wide = wide;
    setWorkspace(tabId);
    setStoppedPreview(previewState);
    render(<WorkspaceLayout />);
    await flush();
    await flush();

    expect(depthWarnings()).toEqual([]);
    expect(h.renders.count).toBeGreaterThan(0);
    expect(h.renders.count).toBeLessThan(15);
    expect(screen.queryByTestId("preview-pane")).toBeNull();
  });

  it("the stopped preview still opens its pane once the founder switches to the Build tab", async () => {
    setStoppedPreview("stopped");
    const view = render(<WorkspaceLayout />);
    await flush();
    const offSurfaceRenders = h.renders.count;
    setWorkspace("tab-build");
    window.history.replaceState(null, "", "/workspace?tab=build");
    view.rerender(<WorkspaceLayout />);
    await flush();
    await flush();

    expect(depthWarnings()).toEqual([]);
    expect(offSurfaceRenders).toBeLessThan(15);
    expect(h.renders.count - offSurfaceRenders).toBeLessThan(15);
    expect(screen.getByTestId("preview-pane")).toBeTruthy();
  });
});
