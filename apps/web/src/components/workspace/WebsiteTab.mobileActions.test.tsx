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
import { PUBLISH_WAITS_TITLE } from "./website/PublishTrigger";

function setBuild(runStatus: string, previewUrl: string | null) {
  h.build.value = {
    loaded: true,
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

const chatPane = () => screen.getByRole("complementary", { name: "Chat" });

function openMenu(from: HTMLElement): HTMLElement {
  fireEvent.click(within(from).getByRole("button", { name: "More actions" }));
  return within(from).getByRole("menu", { name: "More actions" });
}

beforeEach(() => {
  h.ui = { mobileActions: true, publishWaitsForApp: true };
  setBuild("done", "https://bikes.onrender.com");
  window.history.replaceState(null, "", "/workspace?tab=build");
});
afterEach(() => cleanup());

describe("DEL-1323 B38: build actions on a phone", () => {
  it("the chat view, which a phone shows first, has a phone-only actions menu with every build action", async () => {
    render(<AppWorkspace variant="build" />);
    await flush();
    const wrap = within(chatPane()).getByTestId("build-mobile-actions");
    expect(wrap.className.split(/\s+/)).toContain("lg:hidden");
    const menu = openMenu(chatPane());
    const items = within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim());
    expect(items).toEqual([
      "Preview",
      "Publish",
      "Open bikes.zaviagent.com",
      "Copy live address",
      "App settings",
      "Domains",
      "Export",
    ]);
    const open = within(menu).getByRole("menuitem", { name: "Open bikes.zaviagent.com" }) as HTMLAnchorElement;
    expect(open.href).toBe("https://bikes.zaviagent.com/");
    expect(open.target).toBe("_blank");
  });

  it("the app pane has the same menu, and its clipped bar actions are hidden below the desktop breakpoint", async () => {
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(within(screen.getByTestId("preview-narrow")).getByTestId("build-mobile-actions")).toBeTruthy();
    const githubInBar = within(screen.getByTestId("preview-pane")).getByRole("button", { name: "GitHub export" });
    const barGroup = githubInBar.parentElement!;
    expect(barGroup.className.split(/\s+/)).toContain("max-lg:hidden");
  });

  it("Publish from the chat view opens the publish panel on a phone-sized sheet", async () => {
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(screen.queryByTestId("build-mobile-sheet")).toBeNull();
    fireEvent.click(within(openMenu(chatPane())).getByRole("menuitem", { name: "Publish" }));
    const sheet = screen.getByTestId("build-mobile-sheet");
    expect(sheet.className.split(/\s+/)).toContain("lg:hidden");
    expect(within(sheet).getByTestId("publish-popover")).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the Publish sheet closes when publishing stops being possible, and does not pop back open on its own when it is possible again", async () => {
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    fireEvent.click(within(openMenu(chatPane())).getByRole("menuitem", { name: "Publish" }));
    expect(within(screen.getByTestId("build-mobile-sheet")).getByTestId("publish-popover")).toBeTruthy();

    setBuild("active", null);
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(screen.queryByTestId("publish-popover")).toBeNull();
    expect(screen.queryByTestId("build-mobile-sheet")).toBeNull();

    setBuild("done", "https://bikes.onrender.com");
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(screen.queryByTestId("publish-popover")).toBeNull();
    expect(screen.queryByTestId("build-mobile-sheet")).toBeNull();

    fireEvent.click(within(openMenu(chatPane())).getByRole("menuitem", { name: "Publish" }));
    expect(within(screen.getByTestId("build-mobile-sheet")).getByTestId("publish-popover")).toBeTruthy();
  });

  it("an open Export sheet is left alone when the publish state changes", async () => {
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    fireEvent.click(within(openMenu(chatPane())).getByRole("menuitem", { name: "Export" }));
    setBuild("active", null);
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(within(screen.getByTestId("build-mobile-sheet")).getByTestId("export-github")).toBeTruthy();
  });

  it("Export opens the export panel; App settings and Domains open the settings console", async () => {
    render(<AppWorkspace variant="build" />);
    await flush();
    fireEvent.click(within(openMenu(chatPane())).getByRole("menuitem", { name: "Export" }));
    expect(within(screen.getByTestId("build-mobile-sheet")).getByTestId("export-github")).toBeTruthy();
    expect(screen.queryByTestId("console")).toBeNull();
    fireEvent.click(within(openMenu(chatPane())).getByRole("menuitem", { name: "App settings" }));
    expect(screen.getByRole("region", { name: "App settings" })).toBeTruthy();
    fireEvent.click(within(openMenu(chatPane())).getByRole("menuitem", { name: "Domains" }));
    expect(new URLSearchParams(window.location.search).get("section")).toBe("domains");
    expect(screen.getByTestId("console")).toBeTruthy();
  });

  it("before anything is built, Publish and the live address say why they are off", async () => {
    setBuild("active", null);
    render(<AppWorkspace variant="build" />);
    await flush();
    const menu = openMenu(chatPane());
    const publish = within(menu).getAllByRole("menuitem").find((el) => el.textContent?.startsWith("Publish"))!;
    expect(publish.getAttribute("aria-disabled")).toBe("true");
    expect(publish.textContent).toContain(PUBLISH_WAITS_TITLE);
    fireEvent.click(publish);
    expect(screen.queryByTestId("build-mobile-sheet")).toBeNull();
    const live = within(menu).getAllByRole("menuitem").find((el) => el.textContent?.startsWith("Live address"))!;
    expect(live.getAttribute("aria-disabled")).toBe("true");
    expect(live.textContent).toContain("Not live yet");
  });

  it("unpublished edits put a visible Publish button beside the menu, and it opens the publish sheet", async () => {
    h.build.value = {
      ...h.build.value,
      site: {
        id: "site-1",
        status: "live",
        liveUrl: "https://bikes.zaviagent.com",
        repoUrl: null,
        unpublished: { count: 2, changes: [{ id: "c2", kind: "edit", at: "2026-10-30T00:00:00Z", message: "New hero" }], publish: { status: "none", startedAt: null, url: null, retryable: false } },
      },
    };
    render(<AppWorkspace variant="build" />);
    await flush();
    const button = within(chatPane()).getByTestId("build-mobile-publish");
    expect(button.textContent).toBe("Publish");
    expect(button.closest("[data-testid='build-mobile-actions']")!.className.split(/\s+/)).toContain("lg:hidden");
    expect(screen.queryByTestId("build-mobile-sheet")).toBeNull();
    fireEvent.click(button);
    expect(within(screen.getByTestId("build-mobile-sheet")).getByTestId("publish-popover")).toBeTruthy();
  });

  it("a live site with nothing waiting keeps Publish inside the menu only", async () => {
    h.build.value = {
      ...h.build.value,
      site: { id: "site-1", status: "live", liveUrl: "https://bikes.zaviagent.com", repoUrl: null, unpublished: null },
    };
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(screen.queryByTestId("build-mobile-publish")).toBeNull();
    expect(within(openMenu(chatPane())).getByRole("menuitem", { name: "Publish" })).toBeTruthy();
  });

  it("a changes publish already running hides the visible button", async () => {
    h.build.value = {
      ...h.build.value,
      site: {
        id: "site-1",
        status: "live",
        liveUrl: "https://bikes.zaviagent.com",
        repoUrl: null,
        unpublished: { count: 1, changes: [{ id: "c1", kind: "edit", at: "2026-10-30T00:00:00Z", message: null }], publish: { status: "publishing", startedAt: "2026-10-30T00:01:00Z", url: null, retryable: false } },
      },
    };
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(screen.queryByTestId("build-mobile-publish")).toBeNull();
  });

  it("while the site is still building there is no visible Publish button", async () => {
    setBuild("active", null);
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(screen.queryByTestId("build-mobile-publish")).toBeNull();
  });

  it("a failed publish that can be retried shows Retry publish outside the menu", async () => {
    h.build.value = { ...h.build.value, publish: { status: "failed", startedAt: null, url: null, retryable: true } };
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(within(chatPane()).getByTestId("build-mobile-publish").textContent).toBe("Retry publish");
  });

  it("with the setting off there is no menu and the bar actions are not hidden", async () => {
    h.ui = {};
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(screen.queryByTestId("build-mobile-actions")).toBeNull();
    const githubInBar = within(screen.getByTestId("preview-pane")).getByRole("button", { name: "GitHub export" });
    expect(githubInBar.parentElement!.className.split(/\s+/)).not.toContain("max-lg:hidden");
  });
});
