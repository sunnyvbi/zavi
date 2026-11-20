// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: { value: {} as Record<string, unknown> },
  liveEdit: {
    value: {
      state: {
        enabled: true,
        refine_active: false,
        preview: { status: "live", url: "https://sandbox.e2b.test" },
        draft: { ahead_by: 0, behind_by: 0, changes: [] as unknown[] },
      },
      frameUrl: null as string | null,
    },
  },
  refresh: vi.fn(),
  productUrlReads: { count: 0 },
  watch: {
    resolve: null as null | ((v: string) => void),
    onLive: null as null | (() => void),
    copy: null as null | { failed: string; failedDetail: string },
  },
  tabs: [] as Array<{ id: string; payload: Record<string, unknown> }>,
}));

vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({
    userEmail: "founder@example.com",
    openTab: vi.fn(),
    tabs: h.tabs,
    setTabThreadId: vi.fn(),
  }),
}));
vi.mock("./home/calm/HomeChatPanel", () => ({ HomeChatPanel: () => <aside aria-label="Chat" /> }));
vi.mock("./website/WebsitePreview", () => ({
  WebsitePreview: (p: { liveUrl: string | null; headerActions?: React.ReactNode; openPath?: { path: string; nonce: string } | null }) => (
    <div>
      {p.headerActions}
      <div data-testid="frame">{p.liveUrl}</div>
      <div data-testid="open-path">{p.openPath ? `${p.openPath.nonce}:${p.openPath.path}` : ""}</div>
    </div>
  ),
  chatEditErrorMessage: () => "",
}));
vi.mock("./website/WebsiteConsole", () => ({ WebsiteConsole: () => null }));
vi.mock("./build/BuildHistoryPanel", () => ({ BuildHistoryPanel: () => null }));
vi.mock("./build/AppCodePane", () => ({ AppCodePane: () => null, ReadOnlyBadge: () => null }));
vi.mock("./build/BuildFilesPane", () => ({ BuildFilesPane: () => null }));
vi.mock("./website/PublishPopover", () => ({
  PublishPopover: (p: { draft?: { onPublished: (sha: string, count: number) => void } }) => (
    <button type="button" onClick={() => p.draft?.onPublished("c".repeat(40), 1)}>
      Confirm publish
    </button>
  ),
}));
vi.mock("./home/summaryState", () => ({ loadSummary: () => Promise.resolve(null) }));
vi.mock("@/lib/workspace/useBuildPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildPreview")>()),
  useBuildPreview: () => ({
    building: false,
    loaded: true,
    classified: true,
    previewUrl: null,
    runStatus: "done",
    stages: [],
    failure: null,
    settledNonce: 0,
  }),
  isTerminalBuildRun: (status: string) => status !== "running",
}));
vi.mock("@/lib/workspace/optimisticBuildStart", () => ({ useOptimisticBuildStart: () => false }));
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  useBuildSession: () => h.session.value,
}));
vi.mock("@/lib/workspace/useLiveEdit", () => ({
  useLiveEdit: () => ({
    ...h.liveEdit.value,
    refresh: h.refresh,
    publish: vi.fn(),
    discard: vi.fn(),
    wake: vi.fn(),
  }),
}));
vi.mock("@/lib/workspace/restoreDeploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/restoreDeploy")>()),
  watchRestoreDeploy: (args: { onLive: () => void; copy?: { failed: string; failedDetail: string } }) => {
    h.watch.onLive = args.onLive;
    h.watch.copy = args.copy ?? null;
    return new Promise<string>((resolve) => {
      h.watch.resolve = resolve;
    });
  },
}));
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => "t", update: () => {} } }));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
    if (path === "/api/connectors/product-url") h.productUrlReads.count += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (path === "/api/connectors/product-url" ? { product_url: {} } : { resources: [] }),
    });
  },
}));

import { AppWorkspace } from "./WebsiteTab";
import { BUILD_REFINE_FINISHED_EVENT } from "@/lib/workspace/useBuildSession";

type Row = {
  id: string;
  status: string;
  created_at: string;
  preview_path?: string | null;
  draft?: boolean;
  kind?: "change" | "restore" | "undo";
};

function change(id: string, over: Partial<Row> = {}): Row {
  return { id, status: "done", created_at: "2026-09-29T10:00:00Z", ...over };
}

function setSession(refines: Row[], refinesLoaded: boolean) {
  h.session.value = {
    loaded: true,
    run: { id: "s1", status: "done" },
    isCurrent: true,
    retired: false,
    refines,
    refinesLoaded,
    cancelRun: vi.fn(async () => null),
    stopping: false,
  };
}

function setTab(sessionId: string) {
  h.tabs.length = 0;
  h.tabs.push({ id: "tab-build", payload: { kind: "build", sessionId } });
}

const app = () => <AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function reloadsDuring(fn: () => void | Promise<void>): Promise<number> {
  await flush();
  const before = h.productUrlReads.count;
  await fn();
  await flush();
  return h.productUrlReads.count - before;
}

beforeEach(() => {
  setTab("s1");
  setSession([], false);
  h.liveEdit.value.frameUrl = null;
  h.refresh.mockReset();
  h.productUrlReads.count = 0;
  h.watch.resolve = null;
  h.watch.onLive = null;
  h.watch.copy = null;
});
afterEach(() => cleanup());

describe("Build preview on the ship transition", () => {
  it("does not reload or navigate when the refine feed first loads on a cold open", async () => {
    const view = render(app());
    const reloads = await reloadsDuring(() => {
      setSession([change("old", { preview_path: "/laptops" })], true);
      view.rerender(app());
    });
    expect(reloads).toBe(0);
    expect(screen.getByTestId("open-path").textContent).toBe("");
  });

  it("reloads exactly once and opens the change's route when a new change ships", async () => {
    setSession([change("old")], true);
    const view = render(app());
    const reloads = await reloadsDuring(() => {
      setSession([change("old"), change("cart", { preview_path: "/laptops" })], true);
      view.rerender(app());
      window.dispatchEvent(
        new CustomEvent(BUILD_REFINE_FINISHED_EVENT, { detail: { sessionId: "s1", refineId: "cart", status: "done" } }),
      );
    });
    expect(reloads).toBe(1);
    expect(screen.getByTestId("open-path").textContent).toBe("cart:/laptops");
  });

  it("forgets the route a change opened once the founder switches to another session", async () => {
    setSession([change("old")], true);
    const view = render(app());
    await reloadsDuring(() => {
      setSession([change("old"), change("cart", { preview_path: "/laptops" })], true);
      view.rerender(app());
    });
    expect(screen.getByTestId("open-path").textContent).toBe("cart:/laptops");
    setTab("s2");
    setSession([change("fresh")], true);
    view.rerender(app());
    await flush();
    expect(screen.getByTestId("open-path").textContent).toBe("");
  });

  it("does not reload when a draft finishes or when switching to another session", async () => {
    setSession([change("old")], true);
    const view = render(app());
    const reloads = await reloadsDuring(async () => {
      setSession([change("old"), change("d1", { draft: true, status: "done" })], true);
      view.rerender(app());
      await flush();
      setTab("s2");
      view.rerender(app());
      await flush();
      setSession([change("other-old"), change("s2-latest", { preview_path: "/cart" })], false);
      view.rerender(app());
      await flush();
      setSession([change("other-old"), change("s2-latest", { preview_path: "/cart" })], true);
      view.rerender(app());
    });
    expect(reloads).toBe(0);
    expect(screen.getByTestId("open-path").textContent).not.toContain("/cart");
  });

  it("reloads the preview exactly once when an undo from another surface finishes", async () => {
    setSession([change("old")], true);
    const view = render(app());
    const reloads = await reloadsDuring(async () => {
      setSession([change("old"), change("u1", { kind: "undo", status: "active" })], true);
      view.rerender(app());
      await flush();
      setSession([change("old"), change("u1", { kind: "undo" })], true);
      view.rerender(app());
      await flush();
      view.rerender(app());
    });
    expect(reloads).toBe(1);
    expect(screen.getByTestId("open-path").textContent).toBe("");
  });

  it("does not reload for an undo already on file at open, nor for a finished restore", async () => {
    const view = render(app());
    const reloads = await reloadsDuring(async () => {
      setSession([change("old"), change("u0", { kind: "undo" })], true);
      view.rerender(app());
      await flush();
      setSession([change("old"), change("u0", { kind: "undo" }), change("r1", { kind: "restore" })], true);
      view.rerender(app());
    });
    expect(reloads).toBe(0);
  });

  it("wakes the live-edit poll when a change starts from any surface", async () => {
    setSession([change("old")], true);
    const view = render(app());
    await flush();
    h.refresh.mockReset();
    setSession([change("old"), change("new", { status: "active" })], true);
    view.rerender(app());
    await flush();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    view.rerender(app());
    await flush();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("Publish from live edit", () => {
  it("keeps framing the sandbox until the published commit is live", async () => {
    setSession([change("old")], true);
    h.liveEdit.value.frameUrl = "https://sandbox.e2b.test";
    const view = render(app());
    await flush();
    expect(screen.getByTestId("frame").textContent).toBe("https://sandbox.e2b.test");

    fireEvent.click(screen.getAllByRole("button", { name: "Publish" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm publish" }));
    h.liveEdit.value.frameUrl = null;
    view.rerender(app());
    await flush();
    expect(screen.getByTestId("frame").textContent).toBe("https://sandbox.e2b.test");

    await act(async () => {
      h.watch.onLive?.();
      h.watch.resolve?.("live");
      await Promise.resolve();
    });
    await flush();
    expect(screen.getByTestId("frame").textContent).toBe("https://bikes.onrender.com");
  });

  it("releases the sandbox when the deploy fails or times out", async () => {
    setSession([change("old")], true);
    h.liveEdit.value.frameUrl = "https://sandbox.e2b.test";
    const view = render(app());
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Publish" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm publish" }));
    h.liveEdit.value.frameUrl = null;
    view.rerender(app());
    await flush();
    await act(async () => {
      h.watch.resolve?.("failed");
      await Promise.resolve();
    });
    await flush();
    expect(screen.getByTestId("frame").textContent).toBe("https://bikes.onrender.com");
    expect(h.watch.copy?.failedDetail).not.toMatch(/preview/i);
    expect(h.watch.copy?.failedDetail).toMatch(/go live with the next successful deploy/);
  });
});
