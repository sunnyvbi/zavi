// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

type BeforeSend = (message: string) => Promise<{ handled: boolean; system?: string }>;

const h = vi.hoisted(() => ({
  onBeforeSend: null as null | ((message: string) => Promise<{ handled: boolean; system?: string }>),
  resolveEnabled: null as null | (() => Promise<boolean>),
  calls: [] as Array<{ path: string; body: unknown }>,
  loadingLatest: false,
  previewStatus: "none" as "none" | "starting" | "live",
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
  HomeChatPanel: (p: { onBeforeSend?: BeforeSend }) => {
    h.onBeforeSend = p.onBeforeSend ?? null;
    return <aside aria-label="Chat" />;
  },
}));
vi.mock("./website/WebsitePreview", () => ({
  WebsitePreview: (p: { liveUrl: string | null; body?: React.ReactNode }) => (
    <div data-testid="website-preview" data-live-url={p.liveUrl ?? ""}>
      {p.body}
    </div>
  ),
  AppStartingScreen: (p: { state: string }) => <div data-testid="app-starting" data-state={p.state}>Loading your app…</div>,
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
vi.mock("@/lib/workspace/useLiveEdit", () => ({
  useLiveEdit: () => ({
    state: {
      enabled: true,
      refine_active: false,
      preview: { status: h.previewStatus, url: null },
      draft: { exists: true, ahead_by: 3, behind_by: 0, head_sha: "b".repeat(40), changes: [] },
    },
    known: "on",
    frameUrl: null,
    loadingLatest: h.loadingLatest,
    resolveEnabled: async () => true,
    refresh: vi.fn(),
    publish: vi.fn(),
    discard: vi.fn(),
    wake: vi.fn(),
  }),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => "t", update: () => {} } }));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => {
    h.calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body =
      path === "/api/workspace/website/chat"
        ? { route: "app_edit_inline" }
        : path === "/api/connectors/product-url"
          ? { product_url: {} }
          : { resources: [] };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  },
}));

import { AppWorkspace } from "./WebsiteTab";

const OLD_APP = "https://cakes.onrender.com";

beforeEach(() => {
  h.calls.length = 0;
  h.loadingLatest = false;
  h.previewStatus = "none";
});
afterEach(() => cleanup());

async function mount() {
  const r = render(<AppWorkspace variant="build" appUrl={OLD_APP} />);
  await act(async () => {});
  return r;
}

describe("while the newest draft preview boots, the Build pane shows the app loading screen and never the old app", () => {
  it("replaces the whole pane with the initial loading screen, with no frame on the previous version", async () => {
    h.loadingLatest = true;
    const { getAllByTestId, getByTestId, queryByText, queryByTestId } = await mount();
    expect(getByTestId("live-edit-loading-latest")).toBeTruthy();
    expect(getByTestId("app-starting").getAttribute("data-state")).toBe("loading");
    const frames = getAllByTestId("website-preview").map((el) => el.getAttribute("data-live-url"));
    expect(frames).not.toContain(OLD_APP);
    expect(frames.every((u) => u === "")).toBe(true);
    expect(queryByText("Show preview")).toBeNull();
    expect(queryByTestId("live-edit-asleep")).toBeNull();
  });

  it("keeps the loading screen while the backend reports the draft preview starting", async () => {
    h.previewStatus = "starting";
    h.loadingLatest = true;
    const { getByTestId } = await mount();
    expect(getByTestId("live-edit-loading-latest")).toBeTruthy();
  });

  it("falls back to the manual Show preview chip once an automatic wake gave up", async () => {
    const { getByText, queryByTestId } = await mount();
    expect(queryByTestId("live-edit-loading-latest")).toBeNull();
    expect(getByText("Show preview")).toBeTruthy();
  });
});
