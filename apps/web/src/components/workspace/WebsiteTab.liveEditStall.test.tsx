// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

type Deferred = { promise: Promise<void>; resolve: () => void };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string }>,
  liveState: null as unknown,
  gate: null as null | { promise: Promise<void> },
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
  HomeChatPanel: (p: { headerActions?: React.ReactNode; overlay?: React.ReactNode }) => (
    <aside aria-label="Chat">
      {p.headerActions}
      {p.overlay}
    </aside>
  ),
}));
vi.mock("./website/WebsitePreview", () => ({
  WebsitePreview: (p: { liveUrl: string | null; body?: React.ReactNode }) => (
    <div data-testid="website-preview" data-live-url={p.liveUrl ?? ""}>
      {p.body}
    </div>
  ),
  AppStartingScreen: (p: { state: string; onRetry: () => void }) => (
    <button type="button" data-testid="app-starting" data-state={p.state} onClick={p.onRetry}>
      Loading your app…
    </button>
  ),
  chatEditErrorMessage: () => "",
}));
vi.mock("./website/WebsiteConsole", () => ({ WebsiteConsole: () => null }));
vi.mock("./build/BuildHistoryPanel", () => ({
  BuildHistoryPanel: (p: { onSelect: (v: { id: string; title: string; url: string | null; restorable: boolean }) => void }) => (
    <button
      type="button"
      onClick={() => p.onSelect({ id: "cp-1", title: "Earlier version", url: "https://old.example.com", restorable: true })}
    >
      Pick earlier version
    </button>
  ),
}));
vi.mock("./build/AppCodePane", () => ({ AppCodePane: () => null, ReadOnlyBadge: () => null }));
vi.mock("./build/BuildFilesPane", () => ({ BuildFilesPane: () => null }));
vi.mock("./website/PublishPopover", () => ({ PublishPopover: () => null }));
vi.mock("./home/summaryState", () => ({ loadSummary: () => Promise.resolve(null) }));
vi.mock("@/lib/workspace/useBuildPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildPreview")>()),
  useBuildPreview: () => ({
    building: false,
    loaded: true,
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
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => "t", update: () => {} } }));
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    h.calls.push({ path, method });
    if (/^\/api\/workspace\/autopilot\/live-edit(\?|$)/.test(path) && method === "GET") {
      if (h.gate) await h.gate.promise;
      return { ok: true, status: 200, json: async () => h.liveState };
    }
    const body =
      path === "/api/connectors/product-url" ? { product_url: {} } : path.endsWith("/wake") ? { ok: true } : { resources: [] };
    return { ok: true, status: 200, json: async () => body };
  },
}));

import { AppWorkspace } from "./WebsiteTab";
import { LIVE_EDIT_START_TIMEOUT_MS } from "@/lib/workspace/useLiveEdit";

const OLD_APP = "https://cakes.onrender.com";

function liveState(status: "none" | "starting") {
  return {
    enabled: true,
    refine_active: false,
    preview: { status, url: null },
    draft: { exists: true, ahead_by: 3, behind_by: 0, head_sha: "b".repeat(40), changes: [] },
  };
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const wakes = () => h.calls.filter((c) => c.path === "/api/workspace/autopilot/live-edit/wake" && c.method === "POST").length;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  h.calls.length = 0;
  h.gate = null;
  h.liveState = liveState("starting");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a draft preview stuck at starting does not trap the founder on the loading screen", () => {
  it("falls back to the site with the Show preview chip after the boot timeout, and the chip wakes it again", async () => {
    const r = render(<AppWorkspace variant="build" appUrl={OLD_APP} />);
    await advance(0);
    expect(r.getByTestId("live-edit-loading-latest")).toBeTruthy();
    expect(r.queryByText("Show preview")).toBeNull();

    await advance(LIVE_EDIT_START_TIMEOUT_MS - 1000);
    expect(r.getByTestId("live-edit-loading-latest")).toBeTruthy();

    await advance(1000);
    expect(r.queryByTestId("live-edit-loading-latest")).toBeNull();
    expect(r.getByTestId("live-edit-asleep")).toBeTruthy();
    expect(wakes()).toBe(0);

    await act(async () => {
      fireEvent.click(r.getByText("Show preview"));
    });
    await advance(0);
    expect(wakes()).toBe(1);
    expect(r.getByTestId("live-edit-loading-latest")).toBeTruthy();

    await act(async () => {
      fireEvent.click(r.getByTestId("app-starting"));
    });
    await advance(0);
    expect(wakes()).toBe(2);
  });
});

describe("viewing an earlier version never boots a sandbox for the unpublished draft", () => {
  it("does not auto-wake while a checkpoint is on screen", async () => {
    h.liveState = liveState("none");
    const gate = deferred();
    h.gate = gate;
    const r = render(<AppWorkspace variant="build" appUrl={OLD_APP} />);
    await advance(0);
    await act(async () => {
      fireEvent.click(r.getByRole("button", { name: "History" }));
    });
    await act(async () => {
      fireEvent.click(r.getByText("Pick earlier version"));
    });
    h.gate = null;
    await act(async () => {
      gate.resolve();
    });
    await advance(0);
    await advance(60_000);
    expect(h.calls.filter((c) => c.path.startsWith("/api/workspace/autopilot/live-edit") && c.method === "GET").length).toBeGreaterThan(1);
    expect(wakes()).toBe(0);
    const frames = r.getAllByTestId("website-preview").map((el) => el.getAttribute("data-live-url"));
    expect(frames).toContain("https://old.example.com");
  });

  it("does auto-wake the same draft when the current version is on screen", async () => {
    h.liveState = liveState("none");
    render(<AppWorkspace variant="build" appUrl={OLD_APP} />);
    await advance(0);
    await advance(0);
    expect(wakes()).toBe(1);
  });
});
