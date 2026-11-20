// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: { value: {} as Record<string, unknown> },
  build: { value: {} as Record<string, unknown> },
  continueRun: { fn: null as null | ((...a: unknown[]) => Promise<{ code: string; message: string } | null>) },
  reads: { productUrl: 0 },
  chatProps: { last: null as null | { sendBlockedNotice?: string | null } },
  ui: { publishWaitsForApp: true } as Record<string, boolean>,
  site: null as null | Record<string, unknown>,
  preview: { last: null as null | { notLiveAddress?: unknown; body?: unknown; guardWhileBuilding?: boolean; liveUrl?: string | null } },
  popover: {
    last: null as null | {
      ownBuildApp?: boolean;
      publishable?: boolean;
      appUrl?: string | null;
      site?: unknown;
      sitePublish?: null | {
        siteId: string;
        hostname: string | null;
        built: boolean;
        status: string;
        reason?: string | null;
        onStarted?: () => void;
        onRefresh?: () => void;
      };
    },
  },
}));

vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({
    loaded: true,
    currentSessionId: "s1",
    sessions: h.site ? [{ id: "s1", title: "Bikes", request: "", state: "building", run_status: "active", created_at: "2026-10-01T09:00:00Z", last_activity_at: "2026-10-01T09:00:00Z", refine_count: 0, is_current: true, site: h.site }] : [],
    flags: { siteNames: false, siteRepoChip: false, siteListDetails: false },
    uiFlags: h.ui,
  }),
  notifyBuildSessionsChanged: () => {},
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
  HomeChatPanel: (p: { sendBlockedNotice?: string | null }) => {
    h.chatProps.last = p;
    return <aside aria-label="Chat" />;
  },
}));
vi.mock("./website/WebsitePreview", () => ({
  WebsitePreview: (p: { headerActions?: React.ReactNode; body?: React.ReactNode; notLiveAddress?: unknown }) => (
    h.preview.last = p,
    <div>
      {p.headerActions}
      {p.body ? <div data-testid="progress-body">{p.body}</div> : null}
    </div>
  ),
  chatEditErrorMessage: () => "",
}));
vi.mock("./website/WebsiteConsole", () => ({ WebsiteConsole: () => null }));
vi.mock("./build/BuildHistoryPanel", () => ({ BuildHistoryPanel: () => null }));
vi.mock("./build/AppCodePane", () => ({ AppCodePane: () => null, ReadOnlyBadge: () => null }));
vi.mock("./build/BuildFilesPane", () => ({ BuildFilesPane: () => null }));
vi.mock("./website/PublishPopover", () => ({
  PublishPopover: (p: NonNullable<typeof h.popover.last>) => {
    h.popover.last = p;
    return <div data-testid="publish-popover" />;
  },
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
      json: async () => (path === "/api/connectors/product-url" ? { product_url: {} } : { resources: [] }),
    });
  },
}));

import { AppWorkspace } from "./WebsiteTab";
import { PUBLISH_WAITS_TITLE } from "./website/PublishTrigger";

function setBuild(runStatus: string, previewUrl: string | null, appReady = false) {
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
    previewKind: previewUrl ? (runStatus === "done" ? "final" : "instant") : "none",
    failure: null,
    appReady,
    publish: { status: "none", startedAt: null, url: null, retryable: false },
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
    await Promise.resolve();
    await Promise.resolve();
  });
}

const publishButton = () => screen.getByRole("button", { name: /^Publish$/ }) as HTMLButtonElement;

beforeEach(() => {
  h.ui = { publishWaitsForApp: true };
  h.site = null;
  h.preview.last = null;
});
afterEach(() => cleanup());

type PreviewProps = {
  liveUrl?: string | null;
  armEditOnLoad?: boolean;
  onEditUnavailable?: () => boolean;
};
const preview = () => h.preview.last as unknown as PreviewProps;

const LIVE = "https://bike-rental-d667db97-05cd71-dev.zaviagent.com";
const SANDBOX = "https://5173-iu810ilugbohjotn9gcsf.e2b.app";

function setLiveSite(over: Record<string, unknown> = {}) {
  setBuild("done", SANDBOX, false);
  h.build.value = {
    ...h.build.value,
    previewKind: "instant",
    publish: { status: "live", startedAt: null, url: LIVE, retryable: false },
    site: { id: "site-1", status: "live", liveUrl: LIVE, repoUrl: null },
    ...over,
  };
  h.site = { hostname: "bike-rental-d667db97-05cd71-dev.zaviagent.com", live_url: LIVE, status: "live" };
}

describe("edit on a live site whose published page has no editor", () => {
  it("switches the pane to the site's sandbox preview, arms edit there once, and offers the live site back", async () => {
    setLiveSite();
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    expect(preview().liveUrl).toBe(LIVE);
    expect(preview().armEditOnLoad).toBe(false);
    expect(screen.queryByTestId("sandbox-edit-note")).toBeNull();

    let handled: boolean | undefined;
    await act(async () => {
      handled = preview().onEditUnavailable?.();
    });
    expect(handled).toBe(true);
    await flush();
    expect(preview().liveUrl).toBe(SANDBOX);
    expect(preview().armEditOnLoad).toBe(false);
    expect(screen.getByTestId("sandbox-edit-note").textContent).toContain("Editing your site’s preview");

    let again: boolean | undefined;
    await act(async () => {
      again = preview().onEditUnavailable?.();
    });
    expect(again).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Show live site" }));
    await flush();
    expect(preview().liveUrl).toBe(LIVE);
    expect(screen.queryByTestId("sandbox-edit-note")).toBeNull();
    view.unmount();
  });

  it("the sandbox frame is mounted already armed, so one click carries through the swap", async () => {
    setLiveSite();
    const seen: Array<{ url: string | null | undefined; armed: boolean | undefined }> = [];
    const orig = h.preview;
    render(<AppWorkspace variant="build" />);
    await flush();
    const spy = new Proxy(orig, {
      set(target, prop, value) {
        if (prop === "last") seen.push({ url: (value as PreviewProps).liveUrl, armed: (value as PreviewProps).armEditOnLoad });
        (target as Record<string | symbol, unknown>)[prop] = value;
        return true;
      },
    });
    h.preview = spy as typeof h.preview;
    await act(async () => {
      preview().onEditUnavailable?.();
    });
    await flush();
    h.preview = orig;
    const firstSandbox = seen.find((s) => s.url === SANDBOX);
    expect(firstSandbox).toEqual({ url: SANDBOX, armed: true });
    expect(seen.filter((s) => s.armed === true).every((s) => s.url === SANDBOX)).toBe(true);
  });

  it("with no sandbox preview to switch to, the click falls back to the hint", async () => {
    setLiveSite({ previewUrl: null, previewKind: "none" });
    render(<AppWorkspace variant="build" />);
    await flush();
    let handled: boolean | undefined;
    await act(async () => {
      handled = preview().onEditUnavailable?.();
    });
    expect(handled).toBe(false);
    expect(preview().liveUrl).toBe(LIVE);
  });

  it("a site that is not live yet already frames the sandbox, so there is nothing to switch", async () => {
    setLiveSite({
      publish: { status: "none", startedAt: null, url: null, retryable: false },
      site: { id: "site-1", status: "ready", liveUrl: null, repoUrl: null },
    });
    h.site = { hostname: "bike-rental-d667db97-05cd71-dev.zaviagent.com", live_url: null, status: "ready" };
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(preview().liveUrl).toBe(SANDBOX);
    let handled: boolean | undefined;
    await act(async () => {
      handled = preview().onEditUnavailable?.();
    });
    expect(handled).toBe(false);
  });

  it("the Website tab (not a site session) never switches", async () => {
    setLiveSite({ site: null });
    h.site = null;
    render(<AppWorkspace variant="build" />);
    await flush();
    let handled: boolean | undefined;
    await act(async () => {
      handled = preview().onEditUnavailable?.();
    });
    expect(handled).toBe(false);
  });
});
