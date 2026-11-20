// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: { value: {} as Record<string, unknown> },
  build: { value: {} as Record<string, unknown> },
  continueRun: { fn: null as null | ((...a: unknown[]) => Promise<{ code: string; message: string } | null>) },
  reads: { productUrl: 0 },
  chatProps: { last: null as null | { sendBlockedNotice?: string | null } },
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
  WebsitePreview: (p: { headerActions?: React.ReactNode; body?: React.ReactNode }) => (
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
      json: async () => (path === "/api/connectors/product-url" ? { product_url: {} } : { resources: [] }),
    });
  },
}));

import { AppWorkspace } from "./WebsiteTab";
import { PUBLISH_CHANGES_BLOCKED } from "./build/BuildModePane";
import { BUILD_RUN_RESUMED_EVENT } from "@/lib/workspace/buildPublish";

const continueRun = vi.fn(async (): Promise<{ code: string; message: string } | null> => null);

function setBuild(runStatus: string, appReady: boolean, publish: string, retryable = true, settledNonce = 0) {
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
    previewUrl: "https://3000-sbx.e2b.app",
    previewKind: runStatus === "done" ? "final" : "instant",
    failure: null,
    appReady,
    publish: { status: publish, startedAt: "2026-09-29T10:00:00Z", url: "https://bikes.onrender.com", retryable },
    settledNonce,
  };
}

function setSession(status: string, continuing = false) {
  h.session.value = {
    loaded: true,
    run: { id: "s1", status },
    isCurrent: true,
    retired: false,
    refines: [],
    refinesLoaded: true,
    cancelRun: vi.fn(async () => null),
    stopping: false,
    continueRun,
    continuing,
  };
}

const app = () => <AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.reads.productUrl = 0;
  continueRun.mockReset();
  continueRun.mockResolvedValue(null);
  setBuild("active", true, "publishing");
  setSession("active");
});
afterEach(() => cleanup());

describe("Top-bar Publish while the first publish runs", () => {
  it("is disabled with a loader while publishing and cannot open the publish popover", async () => {
    render(app());
    await flush();
    const button = screen.getByRole("button", { name: /Publishing…/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toMatch(/being published to your address/);
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Publish$/ })).toBeNull();
    fireEvent.click(button);
    expect(screen.queryByTestId("publish-popover")).toBeNull();
  });

  it("turns back into a working Publish once the app is live", async () => {
    const view = render(app());
    await flush();
    expect(screen.getByRole("button", { name: /Publishing…/ })).toBeTruthy();
    setBuild("done", false, "live");
    setSession("done");
    view.rerender(app());
    await flush();
    const button = screen.getByRole("button", { name: /^Publish$/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(screen.getByTestId("publish-popover")).toBeTruthy();
  });

  it("closes an open popover when a publish starts under it", async () => {
    setBuild("done", false, "live");
    setSession("done");
    const view = render(app());
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^Publish$/ }));
    expect(screen.getByTestId("publish-popover")).toBeTruthy();
    setBuild("active", true, "publishing");
    setSession("active");
    view.rerender(app());
    await flush();
    expect(screen.queryByTestId("publish-popover")).toBeNull();
    setBuild("done", false, "live");
    setSession("done");
    view.rerender(app());
    await flush();
    expect(screen.queryByTestId("publish-popover")).toBeNull();
  });

  it("routes a failed publish to Retry publish, calls continueRun, and shows its error", async () => {
    setBuild("paused", true, "failed");
    setSession("paused");
    continueRun.mockResolvedValueOnce({ code: "continue_failed", message: "Couldn't continue the build (HTTP 409)." });
    render(app());
    await flush();
    expect(screen.queryByRole("button", { name: /^Publish$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Retry publish/ }));
    await waitFor(() => expect(continueRun).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't continue the build (HTTP 409).");
    expect(screen.queryByTestId("publish-popover")).toBeNull();
  });

  it("keeps Retry publish disabled while the retry is in flight", async () => {
    setBuild("paused", true, "failed");
    setSession("paused", true);
    render(app());
    await flush();
    const button = screen.getByRole("button", { name: /Retry publish/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(continueRun).not.toHaveBeenCalled();
  });

  it("keeps the normal Publish when the failed publish cannot be retried", async () => {
    setBuild("failed", true, "failed", false);
    setSession("failed");
    render(app());
    await flush();
    expect(screen.queryByRole("button", { name: /Retry publish/ })).toBeNull();
    expect((screen.getByRole("button", { name: /^Publish$/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Build preview when the first publish goes live", () => {
  async function productReadsDuring(fn: () => void): Promise<number> {
    await flush();
    const before = h.reads.productUrl;
    fn();
    await flush();
    await flush();
    return h.reads.productUrl - before;
  }

  it("refreshes the preview sources once at ready and exactly once more on publishing to live", async () => {
    setBuild("active", false, "none");
    const view = render(app());
    expect(
      await productReadsDuring(() => {
        setBuild("active", true, "publishing", false, 1);
        view.rerender(app());
      }),
    ).toBe(1);
    expect(
      await productReadsDuring(() => {
        setBuild("active", true, "publishing", false, 1);
        view.rerender(app());
      }),
    ).toBe(0);
    expect(
      await productReadsDuring(() => {
        setBuild("done", false, "live", false, 1);
        setSession("done");
        view.rerender(app());
      }),
    ).toBe(1);
    expect(
      await productReadsDuring(() => {
        setBuild("done", false, "live", false, 1);
        view.rerender(app());
      }),
    ).toBe(0);
  });

  it("refreshes once when a retried publish lands after a failure", async () => {
    setBuild("paused", true, "failed");
    setSession("paused");
    const view = render(app());
    await productReadsDuring(() => {
      setBuild("active", true, "publishing");
      view.rerender(app());
    });
    expect(
      await productReadsDuring(() => {
        setBuild("done", false, "live");
        view.rerender(app());
      }),
    ).toBe(1);
  });

  it("does not refresh on a cold open that is already live", async () => {
    setBuild("active", false, "none");
    setSession("active");
    const building = render(app());
    await flush();
    await flush();
    const baseline = h.reads.productUrl;
    building.unmount();

    h.reads.productUrl = 0;
    setBuild("done", false, "live");
    setSession("done");
    const view = render(app());
    await flush();
    await flush();
    expect(h.reads.productUrl).toBe(baseline);
    expect(
      await productReadsDuring(() => {
        setBuild("done", false, "live");
        view.rerender(app());
      }),
    ).toBe(0);
  });

  it("refreshes once when publish reads live a poll before the run reads done", async () => {
    setBuild("active", true, "publishing");
    const view = render(app());
    const reads = await productReadsDuring(() => {
      setBuild("active", true, "live");
      view.rerender(app());
    });
    const more = await productReadsDuring(() => {
      setBuild("done", false, "live");
      setSession("done");
      view.rerender(app());
    });
    expect(reads + more).toBe(1);
  });
});

describe("Publish-failed body only promises Retry when Retry is on screen", () => {
  function setFailedNoPreview(retryable: boolean) {
    setBuild("paused", true, "failed", retryable, 1);
    h.build.value = { ...h.build.value, previewUrl: null };
    setSession("paused");
  }

  it("build variant with a retryable publish names Retry publish and shows the button", async () => {
    setFailedNoPreview(true);
    render(<AppWorkspace variant="build" appUrl={null} />);
    await flush();
    const body = screen.getByTestId("progress-body");
    expect(body.textContent).toContain("Publishing didn't finish");
    expect(body.textContent).toContain("Use Retry publish");
    expect(screen.getByRole("button", { name: /Retry publish/ })).toBeTruthy();
  });

  it("build variant with a non-retryable publish never mentions Retry publish and points to a new build", async () => {
    setFailedNoPreview(false);
    render(<AppWorkspace variant="build" appUrl={null} />);
    await flush();
    const body = screen.getByTestId("progress-body");
    expect(body.textContent).toContain("Publishing didn't finish");
    expect(body.textContent).not.toMatch(/Retry/);
    expect(body.textContent).toContain("Start a new build");
    expect(screen.queryByRole("button", { name: /Retry publish/ })).toBeNull();
  });

  it("website variant never mentions Retry publish even when the publish is retryable", async () => {
    setFailedNoPreview(true);
    render(<AppWorkspace variant="website" />);
    await flush();
    const body = screen.getByTestId("progress-body");
    expect(body.textContent).toContain("Publishing didn't finish");
    expect(body.textContent).not.toMatch(/Retry/);
    expect(screen.queryByRole("button", { name: /Retry publish/ })).toBeNull();
  });
});

describe("Retry publish error does not outlive the failure it belongs to", () => {
  it("drops the old error once the publish restarts, so the next failure shows a clean Retry", async () => {
    setBuild("paused", true, "failed");
    setSession("paused");
    continueRun.mockResolvedValueOnce({ code: "continue_failed", message: "Couldn't continue the build (HTTP 409)." });
    const view = render(app());
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Retry publish/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't continue the build (HTTP 409).");

    setBuild("active", true, "publishing");
    setSession("active");
    view.rerender(app());
    await flush();
    setBuild("paused", true, "failed");
    setSession("paused");
    view.rerender(app());
    await flush();

    expect(screen.getByRole("button", { name: /Retry publish/ })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(continueRun).toHaveBeenCalledTimes(1);
  });
});

describe("Build chat is locked while the first publish runs", () => {
  it("hands the chat the publishing notice only while publishing, and releases it when the app goes live", async () => {
    const view = render(app());
    await flush();
    expect(h.chatProps.last?.sendBlockedNotice).toBe(PUBLISH_CHANGES_BLOCKED);

    setBuild("done", false, "live");
    setSession("done");
    view.rerender(app());
    await flush();
    expect(h.chatProps.last?.sendBlockedNotice ?? null).toBeNull();

    setBuild("paused", true, "failed");
    setSession("paused");
    view.rerender(app());
    await flush();
    expect(h.chatProps.last?.sendBlockedNotice ?? null).toBeNull();
  });

  it("does not lock the Website tab chat", async () => {
    render(<AppWorkspace variant="website" />);
    await flush();
    expect(h.chatProps.last?.sendBlockedNotice ?? null).toBeNull();
  });
});

describe("Publish popover after a change or undo finishes (QA R6-3)", () => {
  it("re-reads the site's status once when a change lands, so waiting changes show without a reload", async () => {
    setBuild("done", true, "live");
    const change = (status: string) => ({ id: "c1", message: "New headline", status, draft: status === "done", created_at: "2026-10-02T14:35:00Z" });
    setSession("done");
    h.session.value = { ...h.session.value, refines: [change("active")] };
    const resumed: string[] = [];
    const onResumed = (e: Event) => resumed.push(String((e as CustomEvent<{ runId?: string }>).detail?.runId));
    window.addEventListener(BUILD_RUN_RESUMED_EVENT, onResumed);
    try {
      const view = render(app());
      await flush();
      expect(resumed).toEqual([]);
      h.session.value = { ...h.session.value, refines: [change("done")] };
      view.rerender(app());
      await flush();
      expect(resumed).toEqual(["s1"]);
      view.rerender(app());
      await flush();
      expect(resumed).toEqual(["s1"]);
    } finally {
      window.removeEventListener(BUILD_RUN_RESUMED_EVENT, onResumed);
    }
  });
});
