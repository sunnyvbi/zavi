// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  preview: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  calls: [] as Array<{ path: string; method?: string; body?: unknown; key?: string }>,
  start: [] as Array<(r: { ok: boolean; status: number; body: unknown }) => void>,
  openBuildTab: vi.fn(),
}));

vi.mock("./WorkspaceShell", () => {
  const ctx = () => ({
    userEmail: "founder@example.com",
    tenantName: "Pune Yoga",
    openTab: vi.fn(),
    openBuildTab: h.openBuildTab,
    tabs: [{ id: "tab-build", payload: { kind: "build", sessionId: "s1" } }],
    setTabThreadId: vi.fn(),
  });
  return { useWorkspace: ctx, useWorkspaceOptional: ctx };
});
vi.mock("./home/calm/HomeChatPanel", () => ({ HomeChatPanel: () => <aside aria-label="Chat" /> }));
vi.mock("./website/WebsitePreview", () => ({
  WebsitePreview: ({ body, liveUrl }: { body?: React.ReactNode; liveUrl?: string | null }) => (
    <div data-testid="frame" data-live={liveUrl ?? ""}>
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
  isTerminalBuildRun: (status: string) => status !== "running" && status !== "active",
}));
vi.mock("@/lib/workspace/optimisticBuildStart", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/optimisticBuildStart")>()),
  useOptimisticBuildStart: () => false,
}));
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  useBuildSession: () => ({
    loaded: true,
    isCurrent: true,
    retired: false,
    appReady: false,
    liveUrl: null,
    refines: [],
    refinesLoaded: true,
    cancelRun: vi.fn(async () => null),
    stopping: false,
    ...h.session,
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
  apiUrl: (path: string) => path,
  apiFetch: (path: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    h.calls.push({ path, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined, key: opts.headers?.["Idempotency-Key"] });
    if (path === "/api/workspace/autopilot/build-product") {
      return new Promise((resolve) => {
        h.start.push((r) => resolve({ ok: r.ok, status: r.status, json: async () => r.body }));
      });
    }
    const body = path === "/api/connectors/product-url" ? { product_url: {} } : { resources: [] };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  },
}));

import { AppWorkspace } from "./WebsiteTab";
import { _resetBuildStartKeyForTests } from "@/lib/workspace/buildStartKey";
import { _resetStartAgainGuardForTests } from "./build/startAgainGuard";

const DEAD_SANDBOX = "https://5173-i3x9deadsandbox.e2b.app";
const SITE = { id: "aaaaaaaa-0000-4000-8000-000000000001", hostname: "pune-yoga.zavi.site", liveUrl: null, status: "failed", repoUrl: null };
const BRIEF = "Build a mobile-first website for my yoga classes in Pune with a class timetable and WhatsApp booking.";
const stoppedRun = (objective: string = `Build product: Pune Yoga — ${BRIEF}`, failureClass = "user_cancelled") => ({
  id: "s1",
  objective,
  status: "failed",
  createdAt: "2026-10-05T05:45:00Z",
  updatedAt: "2026-10-05T05:48:18Z",
  stages: [],
  failure: { class: failureClass, message: "Cancelled from the workspace." },
});
const starts = () => h.calls.filter((c) => c.path === "/api/workspace/autopilot/build-product");

async function mount() {
  const view = render(<AppWorkspace variant="build" appUrl={null} />);
  await act(async () => {});
  return view;
}

beforeEach(() => {
  _resetStartAgainGuardForTests();
  h.calls.length = 0;
  h.start.length = 0;
  h.openBuildTab.mockReset();
  _resetBuildStartKeyForTests();
  h.preview = {
    site: SITE,
    previewState: null,
    previewUrl: DEAD_SANDBOX,
    previewKind: "instant",
    runStatus: "failed",
    failure: { class: "user_cancelled", message: "Cancelled from the workspace." },
    settledNonce: 0,
  };
  h.session = { run: stoppedRun() };
});
afterEach(() => {
  cleanup();
});

describe("the preview side of a build the founder stopped (l1.5)", () => {
  it("cold open after Stop: a Build stopped pane, never the dead sandbox frame", async () => {
    await mount();
    expect(screen.getByTestId("build-stopped-pane").textContent).toContain("Build stopped");
    expect(screen.getByTestId("build-stopped-pane").textContent).toContain(
      "You stopped this build before it finished, so there's nothing to preview.",
    );
    expect(screen.getAllByTestId("frame").every((f) => f.getAttribute("data-live") !== DEAD_SANDBOX)).toBe(true);
  });

  it("Start again sends the original brief once, even on a double click, and opens the new build", async () => {
    await mount();
    const button = screen.getByRole("button", { name: "Start again" });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.method).toBe("POST");
    expect(starts()[0]!.body).toEqual({ idea: BRIEF, company_name: "Pune Yoga", await_look_pick: true });
    expect((screen.getByRole("button", { name: /Starting again/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.openBuildTab).not.toHaveBeenCalled();
    await act(async () => {
      h.start.shift()!({ ok: true, status: 200, body: { conductor_run_id: "s2" } });
    });
    expect(h.openBuildTab).toHaveBeenCalledTimes(1);
    expect(h.openBuildTab).toHaveBeenCalledWith("s2");
    expect(starts()).toHaveLength(1);
  });

  it("a refused start says why, opens nothing, and lets the founder press again", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    });
    await act(async () => {
      h.start.shift()!({ ok: false, status: 409, body: { error: { code: "build_already_in_progress", message: "busy" } } });
    });
    expect(screen.getByRole("alert").textContent).toBe("A build is already running. Stop it before starting another.");
    expect(h.openBuildTab).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Start again" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a brief cut at the stored limit is never re-sent as if whole: it opens a new build instead", async () => {
    h.session = { run: stoppedRun(`Build product: Pune Yoga — ${"x".repeat(480)}`) };
    await mount();
    expect(screen.queryByRole("button", { name: "Start again" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start a new build" }));
    });
    expect(starts()).toEqual([]);
    expect(h.openBuildTab).toHaveBeenCalledWith(null);
  });

  it("a build stopped on a site that is already live keeps framing the live site", async () => {
    h.session = { run: stoppedRun(), liveUrl: "https://pune-yoga.zavi.site" };
    await mount();
    expect(screen.queryByTestId("build-stopped-pane")).toBeNull();
  });

  it("a build the system reaped is not the founder's stop and gets no stopped pane", async () => {
    h.session = { run: stoppedRun(undefined, "stale_reaped") };
    await mount();
    expect(screen.queryByTestId("build-stopped-pane")).toBeNull();
  });
});
