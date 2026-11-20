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
  preview: { last: null as null | { notLiveAddress?: unknown; body?: unknown; guardWhileBuilding?: boolean; liveUrl?: string | null; buildingNote?: string | null; readOnly?: boolean; onSendEdits?: unknown } },
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
        late?: boolean;
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
import { BUILD_CHECKS_FAILED } from "@zavi/shared";

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

describe("DEL-1323 B25: Publish waits until there is something to publish", () => {
  it("while nothing is built Publish is off, says why on hover and focus, and never opens the popover", async () => {
    setBuild("active", null);
    render(<AppWorkspace variant="build" />);
    await flush();
    const button = publishButton();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(reason.getAttribute("role")).toBe("tooltip");
    expect(reason.textContent).toBe(PUBLISH_WAITS_TITLE);
    expect(reason.className).toMatch(/group-hover:block/);
    expect(reason.className).toMatch(/group-focus-within:block/);
    fireEvent.click(button);
    expect(screen.queryByTestId("publish-popover")).toBeNull();
  });

  it("mid-build, with only the temporary build preview showing, Publish is still off", async () => {
    setBuild("active", "https://3000-sbx.e2b.app");
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(publishButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(publishButton());
    expect(screen.queryByTestId("publish-popover")).toBeNull();
  });

  it("B21: mid-build, with the pane fallen back to the not-yet-live hosting URL, Publish is still off", async () => {
    setBuild("active", null);
    render(<AppWorkspace variant="build" appUrl="https://cake-co.onrender.com" appUrlLive={false} />);
    await flush();
    expect(publishButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(publishButton());
    expect(screen.queryByTestId("publish-popover")).toBeNull();
  });

  it("B21: mid-build, with the build's preview equal to the hosting URL, Publish is still off", async () => {
    setBuild("active", "https://cake-co.onrender.com");
    render(<AppWorkspace variant="build" appUrl="https://cake-co.onrender.com" appUrlLive={false} />);
    await flush();
    expect(publishButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(publishButton());
    expect(screen.queryByTestId("publish-popover")).toBeNull();
  });

  it("once the app is built Publish works again", async () => {
    setBuild("active", null);
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    expect(publishButton().getAttribute("aria-disabled")).toBe("true");
    setBuild("done", "https://bikes.onrender.com");
    view.rerender(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await flush();
    expect(publishButton().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(publishButton());
    expect(screen.getByTestId("publish-popover")).toBeTruthy();
  });

  it("the address bar gets the site's planned address, or Not live yet, instead of the grey placeholder", async () => {
    h.site = { hostname: "paws.zaviagent.com", live_url: null, status: "building" };
    setBuild("active", null);
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    expect(h.preview.last?.body).toBeTruthy();
    expect(h.preview.last?.notLiveAddress).toEqual({ host: "paws.zaviagent.com" });
    h.site = null;
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(h.preview.last?.notLiveAddress).toEqual({ host: null });
  });

  it("B21: with the setting off, a mid-build popover on the unshipped hosting URL is told it is the build's own app", async () => {
    h.ui = {};
    setBuild("active", null);
    render(<AppWorkspace variant="build" appUrl="https://cake-co.onrender.com" appUrlLive={false} />);
    await flush();
    fireEvent.click(publishButton());
    expect(screen.getByTestId("publish-popover")).toBeTruthy();
    expect(h.popover.last).toMatchObject({ appUrl: "https://cake-co.onrender.com", publishable: false, ownBuildApp: true });
  });

  it("with the setting off Publish stays clickable and the bar keeps its placeholder", async () => {
    h.ui = {};
    setBuild("active", null);
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(publishButton().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(publishButton());
    expect(screen.getByTestId("publish-popover")).toBeTruthy();
    expect(h.preview.last?.notLiveAddress ?? null).toBeNull();
  });
});

describe("DEL-1323 B22: the Build preview is guarded only while the build runs", () => {
  it("mid-build, with an early sandbox address, the pane keeps the progress bar and never frames the half-built site", async () => {
    setBuild("active", "https://3000-sbx.e2b.app");
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(h.preview.last?.liveUrl ?? null).toBeNull();
    expect(screen.getByRole("progressbar", { name: "Website build progress" })).toBeTruthy();
  });

  it("mid-build, with the build's pages already in the preview, the pane still shows progress until the site is built", async () => {
    setBuild("active", "https://5173-sbx.e2b.app");
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    expect(h.preview.last?.liveUrl ?? null).toBeNull();
    expect(screen.getByRole("progressbar", { name: "Website build progress" })).toBeTruthy();

    setBuild("active", "https://5173-sbx.e2b.app", true);
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(h.preview.last?.liveUrl).toBe("https://5173-sbx.e2b.app");
    expect(h.preview.last?.buildingNote ?? null).toBeNull();
    expect(h.preview.last?.readOnly ?? false).toBe(false);
  });

  it("once the app is built, or the build is done, the guard is off", async () => {
    setBuild("active", "https://bikes.onrender.com", true);
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    expect(h.preview.last?.guardWhileBuilding ?? false).toBe(false);
    setBuild("done", "https://bikes.onrender.com");
    view.rerender(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await flush();
    expect(h.preview.last?.guardWhileBuilding ?? false).toBe(false);
  });

  it("the Website tab never guards its preview", async () => {
    setBuild("active", "https://3000-sbx.e2b.app");
    render(<AppWorkspace variant="website" appUrl="https://bikes.onrender.com" />);
    await flush();
    expect(h.preview.last?.guardWhileBuilding ?? false).toBe(false);
  });

  it("a publish-on-request build frames nothing while it runs, and is never guarded once it is done and waiting for Publish, publishing, or failed to publish", async () => {
    h.ui = { publishWaitsForApp: true, publishOnRequest: true };
    const site = { id: "site-1", status: "building", liveUrl: null, repoUrl: null };
    const twoSteps = (build: string) => [
      { stage: "provision", status: "done" },
      { stage: "build", status: build },
    ];
    h.site = { hostname: "paws.zaviagent.com", live_url: null, status: "building" };
    setBuild("active", "https://3000-sbx.e2b.app");
    h.build.value = { ...h.build.value, previewKind: "instant", stages: twoSteps("running"), site };
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    expect(h.preview.last?.liveUrl ?? null).toBeNull();
    expect(screen.getByRole("progressbar", { name: "Website build progress" })).toBeTruthy();

    const publishStates = [
      { status: "none", startedAt: null, url: null, retryable: false },
      { status: "publishing", startedAt: "2026-10-02T09:00:00Z", url: null, retryable: false },
      { status: "failed", startedAt: "2026-10-02T09:00:00Z", url: null, retryable: false, reason: "The site's smoke check failed" },
    ];
    for (const publish of publishStates) {
      for (const appReady of [true, false]) {
        setBuild("done", "https://3000-sbx.e2b.app", appReady);
        h.build.value = { ...h.build.value, previewKind: "instant", stages: twoSteps("done"), site, publish };
        view.rerender(<AppWorkspace variant="build" />);
        await flush();
        expect(h.preview.last?.liveUrl, `${publish.status} appReady=${appReady}`).toBe("https://3000-sbx.e2b.app");
        expect(h.preview.last?.guardWhileBuilding ?? false, `${publish.status} appReady=${appReady}`).toBe(false);
      }
    }
  });
});

describe("publish on request: the top-bar Publish is the only thing that publishes a built site", () => {
  const RESUMED = "zavi:build-run-resumed";
  const NONE = { status: "none", startedAt: null, url: null, retryable: false };
  const resumed: Array<string | undefined> = [];
  const onResumed = (event: Event) => {
    resumed.push((event as CustomEvent<{ runId?: string }>).detail?.runId);
  };

  function setSite(runStatus: string, publish: Record<string, unknown> = NONE, site: Record<string, unknown> = {}) {
    setBuild(runStatus, "https://3000-sbx.e2b.app", runStatus === "done" && publish.status !== "live");
    h.build.value = {
      ...h.build.value,
      previewKind: "instant",
      publish,
      site: { id: "site-1", status: "building", liveUrl: null, repoUrl: null, ...site },
    };
    h.site = { hostname: "paws.zaviagent.com", live_url: null, status: "building" };
  }

  beforeEach(() => {
    resumed.length = 0;
    h.popover.last = null;
    window.addEventListener(RESUMED, onResumed);
  });
  afterEach(() => {
    window.removeEventListener(RESUMED, onResumed);
    vi.useRealTimers();
  });

  it("a done build of a never-published site has an enabled Publish that opens this site's publish popover", async () => {
    h.ui = { publishWaitsForApp: true, publishOnRequest: true };
    setSite("done");
    render(<AppWorkspace variant="build" />);
    await flush();
    const button = publishButton();
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(screen.getByTestId("publish-popover")).toBeTruthy();
    expect(h.popover.last?.sitePublish).toMatchObject({
      siteId: "site-1",
      hostname: "paws.zaviagent.com",
      built: true,
      status: "none",
    });
    expect(resumed).toEqual([]);
  });

  it("with the setting off the same site stays waiting and never gets the publish popover", async () => {
    h.ui = { publishWaitsForApp: true };
    setSite("done");
    h.build.value = { ...h.build.value, appReady: false };
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(publishButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(publishButton());
    expect(screen.queryByTestId("publish-popover")).toBeNull();
    expect(h.popover.last).toBeNull();
  });

  it("while the site is still building Publish waits, and the address bar says Not published instead of Not live yet", async () => {
    h.ui = { publishWaitsForApp: true, publishOnRequest: true };
    setSite("active");
    h.build.value = { ...h.build.value, previewUrl: null, previewKind: "none" };
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(publishButton().getAttribute("aria-disabled")).toBe("true");
    expect(h.preview.last?.notLiveAddress).toEqual({ host: "paws.zaviagent.com", label: "Not published" });
  });

  it("a started publish reads Publishing… at once, keeps the popover open on its progress, and re-reads the status until it shows up", async () => {
    vi.useFakeTimers();
    h.ui = { publishWaitsForApp: true, publishOnRequest: true };
    setSite("done");
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    fireEvent.click(publishButton());
    await act(async () => {
      h.popover.last?.sitePublish?.onStarted?.();
    });
    expect(resumed).toEqual(["s1"]);
    const publishing = screen.getByRole("button", { name: /Publishing…/ }) as HTMLButtonElement;
    expect(publishing.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: /^Publish$/ })).toBeNull();
    expect(screen.getByTestId("publish-popover")).toBeTruthy();
    expect(h.popover.last?.sitePublish?.status).toBe("publishing");

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(resumed).toEqual(["s1", "s1"]);

    setSite("done", { status: "publishing", startedAt: "2026-10-02T09:00:00Z", url: null, retryable: false }, { status: "publishing" });
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(screen.getByRole("button", { name: /Publishing…/ })).toBeTruthy();
    expect(screen.getByTestId("publish-popover")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(resumed).toEqual(["s1", "s1"]);

    setSite(
      "done",
      { status: "failed", startedAt: "2026-10-02T09:00:00Z", url: null, retryable: true, reason: "The site's smoke check failed: login" },
      { status: "failed" },
    );
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(publishButton().getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry publish" })).toBeNull();
    expect(h.popover.last?.sitePublish).toMatchObject({ status: "failed", reason: "The site's smoke check failed: login", built: true });
    expect((h.session.value.continueRun as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("a publish the server never picks up falls back to Publish instead of spinning forever", async () => {
    vi.useFakeTimers();
    h.ui = { publishWaitsForApp: true, publishOnRequest: true };
    setSite("done");
    render(<AppWorkspace variant="build" />);
    await flush();
    fireEvent.click(publishButton());
    await act(async () => {
      h.popover.last?.sitePublish?.onStarted?.();
    });
    expect(screen.getByRole("button", { name: /Publishing…/ })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(3000 * 25);
    });
    expect(publishButton().getAttribute("aria-disabled")).toBeNull();
    expect(resumed.length).toBe(21);
    expect(h.popover.last?.sitePublish?.status).toBe("none");
    expect(h.popover.last?.sitePublish?.late).toBe(true);
    await act(async () => {
      h.popover.last?.sitePublish?.onStarted?.();
    });
    expect(h.popover.last?.sitePublish?.late).toBe(false);
  });

  it("once the site is live the popover is the ordinary one again", async () => {
    h.ui = { publishWaitsForApp: true, publishOnRequest: true };
    setSite(
      "done",
      { status: "live", startedAt: null, url: "https://paws.zaviagent.com", retryable: false },
      { status: "live", liveUrl: "https://paws.zaviagent.com" },
    );
    render(<AppWorkspace variant="build" />);
    await flush();
    fireEvent.click(publishButton());
    expect(screen.getByTestId("publish-popover")).toBeTruthy();
    expect(h.popover.last?.sitePublish ?? null).toBeNull();
    expect(h.popover.last?.site).toEqual({ liveUrl: "https://paws.zaviagent.com", status: "live" });
  });
});

describe("publish on request: a retry is told apart from the failure already on screen", () => {
  const RESUMED = "zavi:build-run-resumed";
  const OLD = "2026-10-02T09:00:00Z";
  const NEW = "2026-10-02T09:05:00Z";
  const failed = (startedAt: string, reason: string) => ({ status: "failed", startedAt, url: null, retryable: false, reason });
  let resumed = 0;
  const onResumed = () => {
    resumed += 1;
  };

  function setFailedSite(publish: Record<string, unknown>) {
    setBuild("done", "https://3000-sbx.e2b.app", true);
    h.build.value = {
      ...h.build.value,
      previewKind: "instant",
      publish,
      site: { id: "site-1", status: "building", liveUrl: null, repoUrl: null },
    };
    h.site = { hostname: "paws.zaviagent.com", live_url: null, status: "building" };
  }

  beforeEach(() => {
    resumed = 0;
    h.popover.last = null;
    h.chatProps.last = null;
    h.ui = { publishWaitsForApp: true, publishOnRequest: true };
    window.addEventListener(RESUMED, onResumed);
  });
  afterEach(() => {
    window.removeEventListener(RESUMED, onResumed);
    vi.useRealTimers();
  });

  it("after Try again the old failure stays hidden behind Publishing…, and a new failure shows the moment it arrives", async () => {
    vi.useFakeTimers();
    setFailedSite(failed(OLD, "The first try failed"));
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    fireEvent.click(publishButton());
    expect(h.popover.last?.sitePublish).toMatchObject({ status: "failed", reason: "The first try failed" });
    expect(h.chatProps.last?.sendBlockedNotice ?? null).toBeNull();

    await act(async () => {
      h.popover.last?.sitePublish?.onStarted?.();
    });
    expect(screen.getByRole("button", { name: /Publishing…/ })).toBeTruthy();
    expect(h.popover.last?.sitePublish?.status).toBe("publishing");
    expect(h.chatProps.last?.sendBlockedNotice).toBe("You can ask for changes once your app is published.");

    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(screen.getByRole("button", { name: /Publishing…/ })).toBeTruthy();

    setFailedSite(failed(NEW, "The second try failed"));
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    expect(publishButton().getAttribute("aria-disabled")).toBeNull();
    expect(h.popover.last?.sitePublish).toMatchObject({ status: "failed", reason: "The second try failed" });
    expect(h.chatProps.last?.sendBlockedNotice ?? null).toBeNull();
    const before = resumed;
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(resumed).toBe(before);
  });

  it("a refresh asked for by the popover re-reads the status without claiming a publish started", async () => {
    setFailedSite({ status: "none", startedAt: null, url: null, retryable: false });
    render(<AppWorkspace variant="build" />);
    await flush();
    fireEvent.click(publishButton());
    await act(async () => {
      h.popover.last?.sitePublish?.onRefresh?.();
    });
    expect(resumed).toBe(1);
    expect(screen.queryByRole("button", { name: /Publishing…/ })).toBeNull();
    expect(h.popover.last?.sitePublish?.status).toBe("none");
  });
});

describe("publish on request is decided per build, so a build that ended at the preview always has a Publish", () => {
  const NONE = { status: "none", startedAt: null, url: null, retryable: false };
  const NO_PUBLISH_STAGE = [
    { stage: "provision", status: "done" },
    { stage: "build", status: "done" },
  ];
  const WITH_PUBLISH_STAGE = [...NO_PUBLISH_STAGE, { stage: "deploy", status: "pending" }];

  function setSiteRun(runStatus: string, stages: unknown[], appReady: boolean, publish: Record<string, unknown> = NONE) {
    setBuild(runStatus, "https://3000-sbx.e2b.app", appReady);
    h.build.value = {
      ...h.build.value,
      previewKind: "instant",
      stages,
      publish,
      site: { id: "site-1", status: "building", liveUrl: null, repoUrl: null },
    };
    h.site = { hostname: "paws.zaviagent.com", live_url: null, status: "building" };
  }

  beforeEach(() => {
    h.popover.last = null;
  });

  it.each([
    ["turned off", { publishWaitsForApp: true, publishOnRequest: false }],
    ["missing from an older sessions response", { publishWaitsForApp: true }],
  ])("setting %s: a done run with no publish stage and a never-published site gets an enabled Publish and the Not published popover", async (_name, ui) => {
    h.ui = ui as Record<string, boolean>;
    setSiteRun("done", NO_PUBLISH_STAGE, true);
    render(<AppWorkspace variant="build" />);
    await flush();
    const button = publishButton();
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(screen.getByTestId("publish-popover")).toBeTruthy();
    expect(h.popover.last?.sitePublish).toMatchObject({
      siteId: "site-1",
      hostname: "paws.zaviagent.com",
      built: true,
      status: "none",
    });
  });

  it("setting off with a publish stage present is exactly today: Publish waits and there is no on-request popover", async () => {
    h.ui = { publishWaitsForApp: true };
    setSiteRun("active", WITH_PUBLISH_STAGE, false);
    h.build.value = { ...h.build.value, building: true };
    render(<AppWorkspace variant="build" />);
    await flush();
    expect(publishButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(publishButton());
    expect(screen.queryByTestId("publish-popover")).toBeNull();
    expect(h.popover.last).toBeNull();
  });

  it("setting on with a publish stage present (a build started before it was turned on) keeps the disabled Publishing… and Retry publish", async () => {
    h.ui = { publishWaitsForApp: true, publishOnRequest: true };
    setSiteRun("active", WITH_PUBLISH_STAGE, true, { status: "publishing", startedAt: "2026-10-02T09:00:00Z", url: null, retryable: false });
    const view = render(<AppWorkspace variant="build" />);
    await flush();
    const publishing = screen.getByRole("button", { name: /Publishing…/ }) as HTMLButtonElement;
    expect(publishing.disabled).toBe(true);
    fireEvent.click(publishing);
    expect(screen.queryByTestId("publish-popover")).toBeNull();

    setSiteRun("paused", WITH_PUBLISH_STAGE, true, { status: "failed", startedAt: "2026-10-02T09:00:00Z", url: null, retryable: true });
    view.rerender(<AppWorkspace variant="build" />);
    await flush();
    const retry = screen.getByRole("button", { name: "Retry publish" });
    fireEvent.click(retry);
    await flush();
    expect(h.session.value.continueRun as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("publish-popover")).toBeNull();
    expect(h.popover.last).toBeNull();
  });
});

describe("publish on request: a first publish that activated its deploy and then failed its check", () => {
  const NOT_SERVING = BUILD_CHECKS_FAILED;
  const TWO_STEPS = [
    { stage: "provision", status: "done" },
    { stage: "build", status: "done" },
  ];
  const FAILED = { status: "failed", started_at: "2026-10-02T05:00:00.000Z", url: null, retryable: false, reason: NOT_SERVING };

  beforeEach(() => {
    h.popover.last = null;
    h.ui = { publishWaitsForApp: true, publishOnRequest: true };
  });

  it("the popover gets the failure and its reason, Publish stays usable to try again, and nothing reads Live", async () => {
    const { readBuildPublish } = await import("@/lib/workspace/buildPublish");
    setBuild("done", "https://3000-sbx.e2b.app", true);
    h.build.value = {
      ...h.build.value,
      previewKind: "instant",
      stages: TWO_STEPS,
      publish: readBuildPublish(FAILED),
      site: { id: "site-1", status: "building", liveUrl: null, repoUrl: null },
    };
    h.site = { hostname: "paws.zaviagent.com", live_url: null, status: "building" };
    render(<AppWorkspace variant="build" />);
    await flush();
    const button = publishButton();
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Retry publish" })).toBeNull();
    fireEvent.click(button);
    expect(screen.getByTestId("publish-popover")).toBeTruthy();
    expect(h.popover.last?.site).toEqual({ liveUrl: null, status: "building" });
    expect(h.popover.last?.sitePublish).toMatchObject({ siteId: "site-1", built: true, status: "failed", reason: NOT_SERVING });
    expect(document.body.textContent).not.toMatch(/Live at|is live/);
    expect((h.session.value.continueRun as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
