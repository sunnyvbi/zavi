// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  build: { value: {} as Record<string, unknown> },
  session: { value: {} as Record<string, unknown> },
  ui: { mobileActions: true, publishWaitsForApp: true } as Record<string, boolean>,
  wide: false,
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
import { PUBLISH_WAITS_TITLE } from "../website/PublishTrigger";
import { SERVICE_BANNER_HEIGHT_VAR } from "../ServiceStatusBanner";

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

describe("DEL-1323 B38: a phone that loads mid-build can reach the build actions", () => {
  it("the build chat header offers Show the app, which opens the app pane with every build action", async () => {
    render(<WorkspaceLayout />);
    await flush();
    expect(screen.getByTestId("build-chat")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();

    const header = () => within(document.getElementById("zavi-main")!);
    const show = header().getByRole("button", { name: "Show the app" });
    expect(show.className.split(/\s+/)).toContain("lg:hidden");
    fireEvent.click(show);
    await flush();

    expect(header().queryByRole("button", { name: "Show the app" })).toBeNull();
    const more = screen.getAllByRole("button", { name: "More actions" })[0];
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "More actions" });
    const publish = within(menu).getByRole("menuitem", { name: /Publish/ });
    expect(publish.getAttribute("aria-disabled")).toBe("true");
    expect(menu.textContent).toContain(PUBLISH_WAITS_TITLE);
    expect(within(menu).getByRole("menuitem", { name: /App settings/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Domains/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Export/ })).toBeTruthy();
  });
});

describe("a cold first render mid-build, before the build flags have loaded", () => {
  it("keeps Publish waiting, using the flags the store holds before its first answer", async () => {
    const { NO_UI_FLAGS } = await vi.importActual<typeof import("@/lib/workspace/useBuildSessions")>("@/lib/workspace/useBuildSessions");
    h.ui = { ...NO_UI_FLAGS };
    h.wide = true;
    render(<WorkspaceLayout />);
    await flush();
    const pane = screen.getAllByTestId("preview-pane")[0];
    const publish = within(pane).getByRole("button", { name: /Publish/ });
    expect(publish.getAttribute("aria-disabled")).toBe("true");
    expect(pane.textContent).toContain(PUBLISH_WAITS_TITLE);
    fireEvent.click(publish);
    await flush();
    expect(screen.queryByTestId("publish-popover")).toBeNull();
  });
});

describe("QA B11: at phone width, Show the app shows the app, not a second chat", () => {
  it("one tap on Show the app lands on the app preview with the app's chat folded away", async () => {
    render(<WorkspaceLayout />);
    await flush();
    const header = () => within(document.getElementById("zavi-main")!);
    fireEvent.click(header().getByRole("button", { name: "Show the app" }));
    await flush();

    const preview = screen.getAllByTestId("preview-pane")[0];
    const hiddenAncestor = preview.closest(".max-lg\\:hidden");
    expect(hiddenAncestor).toBeNull();
    expect(screen.getByRole("complementary", { name: "App chat" }).getAttribute("data-narrow-hidden")).toBe("true");
    expect(screen.getAllByRole("button", { name: "Show the chat" }).length).toBeGreaterThan(0);
  });
});

describe("QA l5.16: the outage banner never sits on top of the build header", () => {
  it("the workspace shell starts below the banner's reserved height", async () => {
    const { container } = render(<WorkspaceLayout />);
    await flush();
    const shell = container.querySelector(".workspace-shell")!;
    expect(shell.className.split(/\s+/)).toContain(`pt-[var(${SERVICE_BANNER_HEIGHT_VAR},0px)]`);
    expect(shell.className).toContain("h-screen");
  });
});

describe("the desktop nav column on a phone before hydration", () => {
  it("hides the context column at phone widths, so server markup cannot cover the page", async () => {
    h.wide = true;
    const { container } = render(<WorkspaceLayout />);
    await flush();
    const context = container.querySelector('[data-workspace-column="context"]');
    expect(context).toBeTruthy();
    expect(context!.className.split(/\s+/)).toContain("compact:hidden");
    const others = Array.from(container.querySelectorAll("[data-workspace-column]")).filter((el) => el !== context);
    expect(others.length).toBeGreaterThan(0);
    for (const el of others) expect(el.className.split(/\s+/)).not.toContain("compact:hidden");
  });
});
