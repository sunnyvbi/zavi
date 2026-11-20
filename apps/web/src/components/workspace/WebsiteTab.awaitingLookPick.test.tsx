// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  preview: {} as Record<string, unknown>,
  designStatus: 200,
  design: null as unknown,
  calls: [] as Array<{ path: string; method?: string; body?: unknown }>,
  direction: [] as Array<(r: { ok: boolean; status: number; body: unknown }) => void>,
}));

vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));
vi.mock("./WorkspaceShell", () => {
  const ctx = () => ({
    userEmail: "founder@example.com",
    tenantName: "Pune Yoga",
    openTab: vi.fn(),
    openBuildTab: vi.fn(),
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
    building: true,
    loaded: true,
    classified: true,
    previewUrl: null,
    runStatus: "running",
    runId: "s1",
    stages: [],
    failure: null,
    settledNonce: 0,
    appReady: false,
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
    run: null,
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
  apiFetch: (path: string, opts: { method?: string; body?: string } = {}) => {
    h.calls.push({ path, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (path === "/api/workspace/autopilot/site-design/direction") {
      return new Promise((resolve) => {
        h.direction.push((r) => resolve({ ok: r.ok, status: r.status, json: async () => r.body }));
      });
    }
    if (path.startsWith("/api/workspace/autopilot/site-design?")) {
      const status = h.designStatus;
      return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => ({ design: h.design }) });
    }
    const body = path === "/api/connectors/product-url" ? { product_url: {} } : { resources: [] };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  },
}));

import { AppWorkspace } from "./WebsiteTab";
import { resetSharedSiteDesigns } from "@/lib/workspace/useSiteDesign";
import { _resetBuildStartKeyForTests } from "@/lib/workspace/buildStartKey";

const MIN = 60_000;
const SITE = { id: "aaaaaaaa-0000-4000-8000-000000000001", hostname: "pune-yoga.zavi.site", liveUrl: null, status: "building", repoUrl: null };

const look = (id: string, label: string, recommended = false) => ({
  id,
  label,
  mood: `${label} mood`,
  recommended,
  fonts: { display: "Fraunces", body: "Inter" },
  swatches: { background: "#ffffff", foreground: "#111111", primary: "#2255aa", accent: "#ddeeff", muted: "#f3f3f3" },
  radius: "0.5rem",
  theme_css: null,
  preview: null,
});

const designRow = (awaiting: boolean, chosen = "brand", picked = false) => ({
  run_id: "s1",
  awaiting_pick: awaiting,
  picked,
  source: "model",
  looks: [look("brand", "Brand", true), look("luxe", "Luxe"), look("studio", "Studio")],
  chosen,
  applied: awaiting ? null : chosen,
  locked: null,
  plan: { audience: null, positioning: null, tone: null, main_action: null, sections: [], pages: [], facts: [] },
  checklist: null,
});

function stagesAt(now: number, scaffold: "pending" | "running") {
  return [
    { stage: "provision", status: "done", started_at: new Date(now - 6 * MIN).toISOString(), expected_ms: 1 * MIN },
    { stage: "spec", status: "done", started_at: new Date(now - 5 * MIN).toISOString(), expected_ms: 4 * MIN },
    scaffold === "running"
      ? { stage: "scaffold", status: "running", started_at: new Date(now).toISOString(), expected_ms: 25 * MIN }
      : { stage: "scaffold", status: "pending", expected_ms: 25 * MIN },
    { stage: "build", status: "pending", expected_ms: 10 * MIN },
  ];
}

const directionCalls = () => h.calls.filter((c) => c.path === "/api/workspace/autopilot/site-design/direction");
const designReads = () => h.calls.filter((c) => c.path.startsWith("/api/workspace/autopilot/site-design?"));
const previewText = () => screen.getAllByTestId("frame").map((f) => f.textContent ?? "").join(" ");

async function mount() {
  const view = render(<AppWorkspace variant="build" appUrl={null} />);
  await act(async () => {});
  await act(async () => {});
  return view;
}

beforeEach(() => {
  resetSharedSiteDesigns();
  _resetBuildStartKeyForTests();
  h.calls.length = 0;
  h.direction.length = 0;
  h.designStatus = 200;
  h.design = designRow(true);
  h.preview = { site: SITE, previewState: null, stages: stagesAt(Date.now(), "pending") };
});
afterEach(() => {
  cleanup();
});

describe("the Build preview while the build waits for the founder's look (flag on)", () => {
  it("shows the look picker in place of the progress card: no percent, no bar, no time left", async () => {
    await mount();
    expect(designReads()[0]!.path).toBe("/api/workspace/autopilot/site-design?run_id=s1");
    expect(screen.getByTestId("build-progress-pick-look").textContent).toBe("Pick a website");
    expect(previewText()).not.toMatch(/starting in|recommended look|sample of your home page/i);
    expect(screen.getByTestId("look-picker")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(previewText()).not.toMatch(/\d+%/);
    expect(previewText()).not.toMatch(/minutes? left/);
    expect(previewText()).not.toMatch(/Have a coffee/);
  });

  it("the preview lays the three looks out side by side", async () => {
    await mount();
    const group = screen.getByRole("radiogroup", { name: "Looks" });
    expect(group.className.split(/\s+/)).toContain("grid-cols-3");
  });

  it("a design that is already picked is never shown as waiting, even if awaiting_pick lags", async () => {
    h.design = designRow(true, "luxe", true);
    await mount();
    expect(screen.queryByTestId("look-picker")).toBeNull();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("clicking a tile sends nothing; Build with this look sends one pick, then the real progress returns", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("look-tile-luxe"));
    expect(directionCalls()).toEqual([]);
    const build = screen.getByTestId("look-build");
    await act(async () => {
      fireEvent.click(build);
      fireEvent.click(build);
    });
    expect(directionCalls()).toHaveLength(1);
    expect(directionCalls()[0]!.method).toBe("POST");
    expect(directionCalls()[0]!.body).toEqual({ run_id: "s1", direction: "luxe" });
    expect(screen.getByTestId("look-picker").getAttribute("data-state")).toBe("starting");
    expect(screen.queryByRole("progressbar")).toBeNull();

    h.design = designRow(false, "luxe");
    h.preview = { ...h.preview, stages: stagesAt(Date.now(), "running") };
    await act(async () => {
      h.direction.shift()!({ ok: true, status: 200, body: { design: designRow(false, "luxe"), started: true } });
    });
    await act(async () => {});

    expect(screen.queryByTestId("look-picker")).toBeNull();
    expect(screen.queryByTestId("build-progress-pick-look")).toBeNull();
    expect(screen.queryByText("Pick a website")).toBeNull();
    const bar = screen.getByRole("progressbar");
    expect(previewText()).toContain(`${bar.getAttribute("aria-valuenow")}%`);
    expect(previewText()).toMatch(/About 35 minutes left/);
    expect(directionCalls()).toHaveLength(1);
  });

  it("a successful pick whose answer still reads awaiting does not trap the founder on the picker", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("look-tile-studio"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("look-build"));
    });
    await act(async () => {
      h.direction.shift()!({ ok: true, status: 200, body: { design: designRow(true, "studio"), started: true } });
    });
    expect(screen.queryByTestId("build-progress-pick-look")).toBeNull();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("a refused start keeps the picker up with the reason and still shows no time", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("look-tile-brand"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("look-build"));
    });
    await act(async () => {
      h.direction.shift()!({ ok: false, status: 500, body: { error: { message: "Could not save" } } });
    });
    expect(screen.getByTestId("look-picker").getAttribute("data-state")).toBe("picking");
    expect(screen.getByRole("alert").textContent).toBe("Could not save");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(previewText()).not.toMatch(/\d+%|minutes? left/);
  });
});

describe("flag off or no brief: the Build preview is the progress card it always was", () => {
  it("awaiting_pick false (flag off) shows the progress card with its percent and time, and no picker", async () => {
    h.design = designRow(false);
    h.preview = { ...h.preview, stages: stagesAt(Date.now(), "running") };
    await mount();
    expect(screen.queryByTestId("look-picker")).toBeNull();
    expect(screen.queryByTestId("build-progress-pick-look")).toBeNull();
    const bar = screen.getByRole("progressbar");
    expect(previewText()).toContain(`${bar.getAttribute("aria-valuenow")}%`);
    expect(previewText()).toMatch(/About 35 minutes left/);
    expect(previewText()).toContain("Have a coffee, or");
  });

  it("a build with no brief (404) shows the progress card", async () => {
    h.designStatus = 404;
    await mount();
    expect(screen.queryByTestId("look-picker")).toBeNull();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("a failed build never shows the picker even if the brief still reads awaiting", async () => {
    h.preview = { ...h.preview, building: false, runStatus: "failed", failure: { class: "internal", message: "x" }, settledNonce: 1 };
    await mount();
    expect(screen.queryByTestId("look-picker")).toBeNull();
    expect(previewText()).toContain("The build stopped before your site was ready");
  });
});
