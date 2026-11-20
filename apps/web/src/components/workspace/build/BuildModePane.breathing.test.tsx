// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

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

import { BuildModePane } from "./BuildModePane";
import { resetSharedSiteDesigns } from "@/lib/workspace/useSiteDesign";

const MIN = 60_000;
const T0 = Date.parse("2026-10-07T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const stages = [
  { stage: "provision", status: "done", started_at: iso(T0 - 6 * MIN), expected_ms: 2 * MIN },
  { stage: "spec", status: "done", started_at: iso(T0 - 4 * MIN), expected_ms: 4 * MIN },
  { stage: "scaffold", status: "running", started_at: iso(T0 - MIN), expected_ms: 25 * MIN },
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

const breathingLabels = () => Array.from(document.querySelectorAll('[data-breathing="label"]'));
const halos = () => document.querySelectorAll('[data-breathing="halo"]');

describe("the step a build is on breathes only while the build is really running", () => {
  it("breathes the current step, and only that one, while the build runs", async () => {
    h.design = designRow(false, true, "luxe");
    await mount();
    const labels = breathingLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toBe("Creating the app structure");
    expect(labels[0].className).toContain("zavi-breathe");
    expect(halos()).toHaveLength(1);
    expect(document.querySelectorAll(".zavi-breathe")).toHaveLength(1);
  });

  it("keeps breathing as minutes pass on the same step", async () => {
    h.design = designRow(false, true, "luxe");
    await mount();
    for (let i = 0; i < 3; i++) {
      await act(async () => void vi.advanceTimersByTime(60_000));
      await flush();
    }
    expect(breathingLabels()).toHaveLength(1);
    expect(halos()).toHaveLength(1);
  });

  it("does not breathe while the build waits for the founder to pick a look", async () => {
    await mount();
    expect(breathingLabels()).toHaveLength(0);
    expect(halos()).toHaveLength(0);
    expect(document.querySelectorAll(".zavi-breathe, .zavi-breathe-halo")).toHaveLength(0);
  });

  it("does not breathe on a paused build", async () => {
    h.design = designRow(false, true, "luxe");
    h.session = session("paused");
    await mount();
    expect(breathingLabels()).toHaveLength(0);
    expect(document.querySelectorAll(".zavi-breathe, .zavi-breathe-halo")).toHaveLength(0);
  });

  it("does not breathe once the build is done", async () => {
    h.design = designRow(false, true, "luxe");
    h.session = session("done");
    await mount();
    expect(document.querySelectorAll(".zavi-breathe, .zavi-breathe-halo")).toHaveLength(0);
  });
});

describe("the build card uses the channel card look", () => {
  const badge = () => screen.getByTestId("build-card-badge").textContent;
  const bar = () => screen.queryByTestId("build-card-progress");
  const fill = () => (bar()?.firstElementChild as HTMLElement | null)?.style.width ?? null;

  it("a running build shows a Building pill and a bar that sits between its done and next steps", async () => {
    h.design = designRow(false, true, "luxe");
    await mount();
    expect(badge()).toBe("Building");
    const steps = Array.from(document.querySelectorAll("[data-step]")).map((el) => el.getAttribute("data-step"));
    const done = steps.filter((s) => s === "done").length;
    expect(done).toBeGreaterThan(0);
    const width = Number.parseFloat(fill() ?? "");
    expect(width).toBe(Math.round(4 + (92 * (done + 0.5)) / steps.length));
    expect(width).toBeGreaterThan(Math.round(4 + (92 * done) / steps.length));
    expect(width).toBeLessThan(Math.round(4 + (92 * (done + 1)) / steps.length));
  });

  it("a build waiting on the look says it waits for the founder and does not inch the bar forward", async () => {
    await mount();
    expect(badge()).toBe("Waiting for you");
    const steps = Array.from(document.querySelectorAll("[data-step]"));
    const done = steps.filter((el) => el.getAttribute("data-step") === "done").length;
    expect(Number.parseFloat(fill() ?? "")).toBe(Math.round(4 + (92 * done) / steps.length));
    expect(document.querySelector('[data-step="active"]')).toBeNull();
  });

  it("a paused build drops the bar and the pulse and says Paused", async () => {
    h.design = designRow(false, true, "luxe");
    h.session = session("paused");
    await mount();
    expect(badge()).toBe("Paused");
    expect(bar()).toBeNull();
    expect(screen.getByTestId("build-card-badge").querySelector(".motion-safe\\:animate-pulse")).toBeNull();
  });

  it("a finished build says Ready with no bar", async () => {
    h.design = designRow(false, true, "luxe");
    h.session = session("done");
    await mount();
    expect(badge()).toBe("Ready");
    expect(bar()).toBeNull();
    expect(screen.getByTestId("build-card-title").textContent).toBe("Your app is ready");
  });
});
