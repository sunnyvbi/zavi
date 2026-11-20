// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  preview: {} as Record<string, unknown>,
  calls: [] as Array<{ path: string; method?: string; body?: unknown }>,
  restart: { ok: true, status: 202, body: { ok: true, preview_state: "starting" } as unknown },
  resumed: [] as Array<unknown>,
}));

vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({
    userEmail: "founder@example.com",
    openTab: vi.fn(),
    tabs: [{ id: "tab-build", payload: { kind: "build", sessionId: "s1" } }],
    setTabThreadId: vi.fn(),
  }),
}));
vi.mock("./home/calm/HomeChatPanel", () => ({ HomeChatPanel: () => <aside aria-label="Chat" /> }));
vi.mock("./website/WebsitePreview", () => ({
  WebsitePreview: ({
    body,
    liveUrl,
    siteApp,
    appId,
    builtApp,
  }: {
    body?: React.ReactNode;
    liveUrl?: string | null;
    siteApp?: boolean;
    appId?: string | null;
    builtApp?: boolean;
  }) => (
    <div
      data-testid="frame"
      data-live={liveUrl ?? ""}
      data-site-app={siteApp ? "yes" : "no"}
      data-app-id={appId ?? ""}
      data-built-app={builtApp ? "yes" : "no"}
    >
      {body}
    </div>
  ),
  AppStartingScreen: () => null,
  chatEditErrorMessage: () => "",
}));
vi.mock("./website/WebsiteConsole", () => ({ WebsiteConsole: () => null }));
vi.mock("./build/BuildHistoryPanel", () => ({ BuildHistoryPanel: () => null }));
vi.mock("./build/AppCodePane", () => ({ AppCodePane: () => null, ReadOnlyBadge: () => null }));
vi.mock("./build/BuildFilesPane", () => ({ BuildFilesPane: () => null }));
vi.mock("./website/PublishPopover", () => ({ PublishPopover: () => null }));
vi.mock("./home/summaryState", () => ({ loadSummary: () => Promise.resolve(null) }));
vi.mock("@/lib/workspace/useBuildPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildPreview")>()),
  useBuildPreview: () => ({
    building: false,
    loaded: true,
    classified: true,
    previewUrl: null,
    runStatus: "done",
    runId: "s1",
    stages: [],
    failure: null,
    settledNonce: 0,
    ...h.preview,
  }),
  isTerminalBuildRun: (status: string) => status !== "running",
}));
vi.mock("@/lib/workspace/optimisticBuildStart", () => ({ useOptimisticBuildStart: () => false }));
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  useBuildSession: () => ({
    loaded: true,
    run: { id: "s1", status: "done" },
    isCurrent: true,
    retired: false,
    refines: [],
    refinesLoaded: true,
    cancelRun: vi.fn(async () => null),
    stopping: false,
  }),
}));
vi.mock("@/lib/workspace/useLiveEdit", () => ({
  useLiveEdit: () => ({
    state: {
      enabled: false,
      refine_active: false,
      preview: { status: "none", url: null },
      draft: { ahead_by: 0, behind_by: 0, changes: [] },
    },
    known: "unknown",
    frameUrl: null,
    resolveEnabled: async () => false,
    refresh: vi.fn(),
    publish: vi.fn(),
    discard: vi.fn(),
    wake: vi.fn(),
  }),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => "t", update: () => {} } }));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts: { method?: string; body?: string } = {}) => {
    h.calls.push({ path, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (path === "/api/workspace/autopilot/build-preview/restart") {
      const r = h.restart;
      return Promise.resolve({ ok: r.ok, status: r.status, json: async () => r.body });
    }
    const body = path === "/api/connectors/product-url" ? { product_url: {} } : { resources: [] };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  },
}));

import { AppWorkspace } from "./WebsiteTab";
import { BUILD_RUN_RESUMED_EVENT } from "@/lib/workspace/buildPublish";

const SITE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SITE = { id: SITE_ID, hostname: "rental.zavi.site", liveUrl: null, status: "building", repoUrl: null };
const restartCalls = () => h.calls.filter((c) => c.path === "/api/workspace/autopilot/build-preview/restart");
const onResumed = (e: Event) => h.resumed.push((e as CustomEvent).detail);

beforeEach(() => {
  h.calls.length = 0;
  h.resumed.length = 0;
  h.restart = { ok: true, status: 202, body: { ok: true, preview_state: "starting" } };
  h.preview = { site: SITE, previewState: "stopped" };
  window.addEventListener(BUILD_RUN_RESUMED_EVENT, onResumed);
});
afterEach(() => {
  window.removeEventListener(BUILD_RUN_RESUMED_EVENT, onResumed);
  cleanup();
});

describe("the preview side of a finished build whose preview stopped", () => {
  it("says the preview stopped and offers Restart, instead of an endless loading spinner", async () => {
    render(<AppWorkspace variant="build" appUrl={null} />);
    await act(async () => {});
    expect(screen.getByText("Your preview stopped")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Restart preview/ })).toBeTruthy();
    expect(screen.queryByText("Loading preview")).toBeNull();
  });

  it("Restart asks the server for this build's preview once and switches to starting at once", async () => {
    render(<AppWorkspace variant="build" appUrl={null} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Restart preview/ }));
    });
    expect(restartCalls()).toEqual([
      { path: "/api/workspace/autopilot/build-preview/restart", method: "POST", body: { run_id: "s1" } },
    ]);
    expect(h.resumed).toContainEqual({ runId: "s1" });
    expect(screen.getByText("Starting your preview")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Restart preview/ })).toBeNull();
  });

  it("a refused restart shows why and offers Restart again", async () => {
    h.restart = { ok: false, status: 409, body: { error: { code: "build_in_progress", message: "A build is running. Try again when it finishes." } } };
    render(<AppWorkspace variant="build" appUrl={null} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Restart preview/ }));
    });
    expect(screen.getByRole("alert").textContent).toBe("A build is running. Try again when it finishes.");
    expect(screen.getByRole("button", { name: /Restart preview/ })).toBeTruthy();
  });

  it("a restart already under way shows starting with nothing to press", async () => {
    h.preview = { site: SITE, previewState: "starting" };
    render(<AppWorkspace variant="build" appUrl={null} />);
    await act(async () => {});
    expect(screen.getByText("Starting your preview")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Restart preview/ })).toBeNull();
    expect(restartCalls()).toEqual([]);
  });

  it("frames the app as soon as the restarted preview serves", async () => {
    const view = render(<AppWorkspace variant="build" appUrl={null} />);
    await act(async () => {});
    h.preview = { site: SITE, previewState: null, previewUrl: "https://5173-sbx.e2b.app", previewKind: "instant" };
    view.rerender(<AppWorkspace variant="build" appUrl={null} />);
    await act(async () => {});
    expect(screen.queryByTestId("preview-stopped-card")).toBeNull();
    expect(screen.getAllByTestId("frame").some((f) => f.getAttribute("data-live") === "https://5173-sbx.e2b.app")).toBe(true);
  });
});

describe("waiting states swap inside one preview, never a remount", () => {
  it("stopped, starting and loading keep the same preview chrome element, and loading is a full waiting card", async () => {
    const view = render(<AppWorkspace variant="build" appUrl={null} />);
    await act(async () => {});
    const chrome = screen.getByTestId("frame");
    expect(screen.getByTestId("preview-stopped-card")).toBeTruthy();
    h.preview = { site: SITE, previewState: "starting" };
    view.rerender(<AppWorkspace variant="build" appUrl={null} />);
    await act(async () => {});
    expect(screen.getByText("Starting your preview")).toBeTruthy();
    expect(screen.getByTestId("frame")).toBe(chrome);
    h.preview = { site: SITE, previewState: null };
    view.rerender(<AppWorkspace variant="build" appUrl={null} />);
    await act(async () => {});
    expect(screen.getByTestId("frame")).toBe(chrome);
    const card = screen.getByTestId("preview-pending-card");
    expect(card.hasAttribute("data-waiting-card")).toBe(true);
    expect(card.textContent).toContain("Loading preview");
  });
});

describe("the framed preview knows it is the founder's own Zavi site", () => {
  it("a site session's preview is a Zavi site, so Edit never calls it external", async () => {
    h.preview = { site: SITE, previewState: null, previewUrl: "https://5173-sbx.e2b.app", previewKind: "instant" };
    render(<AppWorkspace variant="build" appUrl={null} />);
    await act(async () => {});
    const framed = screen.getAllByTestId("frame").find((f) => f.getAttribute("data-live") === "https://5173-sbx.e2b.app");
    expect(framed?.getAttribute("data-site-app")).toBe("yes");
  });

  it("an old-builder app is not marked as a site", async () => {
    h.preview = { site: null, previewState: null, previewUrl: "https://bikes.onrender.com", previewKind: "final" };
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await act(async () => {});
    const frames = screen.getAllByTestId("frame").filter((f) => f.getAttribute("data-live"));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.getAttribute("data-site-app") === "no")).toBe(true);
  });
});

describe("the inline editor on a site session", () => {
  it("keys the preview's edits by the site, not the sandbox host, and arms the full editor", async () => {
    h.preview = { site: SITE, previewState: null, previewUrl: "https://5173-sbx.e2b.app", previewKind: "instant" };
    const view = render(<AppWorkspace variant="build" appUrl={null} />);
    await act(async () => {});
    const framed = () => screen.getAllByTestId("frame").find((f) => f.getAttribute("data-live")?.startsWith("https://5173-"));
    expect(framed()?.getAttribute("data-app-id")).toBe(`site:${SITE_ID}`);
    expect(framed()?.getAttribute("data-built-app")).toBe("yes");
    h.preview = { site: SITE, previewState: null, previewUrl: "https://5173-other.e2b.app", previewKind: "instant" };
    view.rerender(<AppWorkspace variant="build" appUrl={null} />);
    await act(async () => {});
    expect(framed()?.getAttribute("data-live")).toBe("https://5173-other.e2b.app");
    expect(framed()?.getAttribute("data-app-id")).toBe(`site:${SITE_ID}`);
  });

  it("an old-builder app keeps its host key", async () => {
    h.preview = { site: null, previewState: null, previewUrl: "https://bikes.onrender.com", previewKind: "final" };
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await act(async () => {});
    const frames = screen.getAllByTestId("frame").filter((f) => f.getAttribute("data-live"));
    expect(frames.every((f) => !f.getAttribute("data-app-id")?.startsWith("site:"))).toBe(true);
  });
});
