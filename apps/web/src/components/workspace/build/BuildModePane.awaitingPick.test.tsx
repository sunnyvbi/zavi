// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  design: null as unknown,
  designStatus: 200,
  calls: [] as Array<{ path: string; method?: string; body?: unknown }>,
  direction: [] as Array<(r: { ok: boolean; status: number; body: unknown }) => void>,
}));

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
      return Promise.resolve({ ok: status === 200, status, json: async () => ({ design: h.design }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  },
}));
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: vi.fn(),
  useBuildSession: () => h.session,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({ currentSessionId: null, sessions: [], loaded: true }),
  readBuildSessions: () => ({ currentSessionId: null, sessions: [], loaded: true }),
  refreshBuildSessions: vi.fn(async () => {}),
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn() }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ tenantName: "Acme", role: "owner" }),
  useWorkspaceOptional: () => ({ tenantName: "Acme", role: "owner" }),
}));
vi.mock("@/components/voice/MicButton", () => ({ MicButton: () => null }));
vi.mock("@/lib/workspace/buildFraming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/buildFraming")>()),
  useSiteListFirst: () => false,
}));

import { BuildModePane, buildActivityNote } from "./BuildModePane";
import { WAITING_FOR_PICK } from "@/lib/workspace/buildEstimate";
import { resetSharedSiteDesigns } from "@/lib/workspace/useSiteDesign";

const MIN = 60_000;
const T0 = Date.parse("2026-10-07T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const stages = [
  { stage: "provision", status: "done", started_at: iso(T0 - 6 * MIN), expected_ms: 2 * MIN },
  { stage: "spec", status: "done", started_at: iso(T0 - 4 * MIN), expected_ms: 4 * MIN },
  { stage: "scaffold", status: "pending", expected_ms: 25 * MIN },
  { stage: "build", status: "pending", expected_ms: 20 * MIN },
];

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

const designRow = (awaiting: boolean, picked: boolean, chosen = "brand") => ({
  run_id: "run-1",
  awaiting_pick: awaiting,
  look_deadline_at: awaiting ? iso(T0 - 60_000) : null,
  picked,
  source: "model",
  looks: [look("brand", "Brand", true), look("luxe", "Luxe"), look("studio", "Studio")],
  chosen,
  applied: picked ? chosen : null,
  locked: null,
  plan: { audience: null, positioning: null, tone: null, main_action: null, sections: [], pages: [], facts: [] },
  checklist: null,
});

function session(status = "active", superseded = false) {
  return {
    loaded: true,
    notFound: false,
    loadError: null,
    authExpired: false,
    run: {
      id: "run-1",
      objective: "Build product: A bakery site",
      status,
      createdAt: iso(T0 - 6 * MIN),
      updatedAt: iso(T0),
      stages,
      failure: null,
    },
    isCurrent: !superseded,
    previewUrl: null,
    previewKind: "none",
    liveUrl: null,
    repoUrl: null,
    refines: [],
    refinesLoaded: true,
    sendRefine: vi.fn(),
    refineSubmitting: false,
    cancelRun: vi.fn(async () => null),
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
    retry: vi.fn(),
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

async function mount() {
  render(
    <BuildModePane
      sessionId="run-1"
      previewOpen={false}
      focusNonce={0}
      resetNonce={0}
      onOpenPreview={vi.fn()}
      onPreviewUnavailable={vi.fn()}
      onPreviewProgress={vi.fn()}
      onOpenSession={vi.fn()}
      onNewBuild={vi.fn()}
    />,
  );
  await flush();
}

const text = () => document.body.textContent ?? "";
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(T0);
  resetSharedSiteDesigns();
  h.calls.length = 0;
  h.direction.length = 0;
  h.designStatus = 200;
  h.design = designRow(true, false);
  h.session = session();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

describe("the chat's Building your app card while the build waits for a look", () => {
  it("waits for the founder with no countdown, and nothing starts the build however long it waits", async () => {
    await mount();
    expect(screen.getByTestId("build-card-title").textContent).toBe("Building your app");
    expect(text()).toContain(WAITING_FOR_PICK);
    expect(text()).not.toMatch(/minutes? left|\d+%/i);
    for (let i = 0; i < 10; i++) {
      await act(async () => void vi.advanceTimersByTime(60_000));
      await flush();
    }
    expect(text()).toContain(WAITING_FOR_PICK);
    expect(text()).not.toMatch(/Starting in \d+s|starts in|Starting with|timer/i);
    expect(screen.queryByRole("timer")).toBeNull();
    expect(h.calls.filter((c) => c.path === "/api/workspace/autopilot/site-design/direction")).toHaveLength(0);
  });

  it("the chat holds no picker while the build waits: the preview pane has the only one", async () => {
    await mount();
    expect(screen.queryByTestId("look-tile-studio")).toBeNull();
    expect(screen.queryByTestId("look-build")).toBeNull();
    expect(screen.queryByTestId("site-design")).toBeNull();
  });

  it("once a look is picked in the preview pane the real time left comes back without a reload", async () => {
    await mount();
    h.design = designRow(false, true, "luxe");
    await act(async () => void vi.advanceTimersByTime(60_000));
    await flush();
    expect(text()).not.toMatch(/Starting in \d+s with/);
    expect(screen.getByTestId("build-card-title").textContent).toBe("Building your app");
    expect(screen.getByText(buildActivityNote("About 45 minutes left"))).toBeTruthy();
  });

  it("a design already picked but still flagged awaiting is not treated as waiting", async () => {
    h.design = designRow(true, true);
    await mount();
    expect(screen.getByText(buildActivityNote("About 45 minutes left"))).toBeTruthy();
    expect(text()).not.toContain(WAITING_FOR_PICK);
  });

  it("flag off: the card keeps its time left", async () => {
    h.design = designRow(false, false);
    await mount();
    expect(screen.getByText(buildActivityNote("About 45 minutes left"))).toBeTruthy();
    expect(text()).not.toContain(WAITING_FOR_PICK);
  });

  it("no brief (404): the card keeps its time left", async () => {
    h.designStatus = 404;
    await mount();
    expect(screen.getByText(buildActivityNote("About 45 minutes left"))).toBeTruthy();
    expect(text()).not.toContain(WAITING_FOR_PICK);
  });
});
