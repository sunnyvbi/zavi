// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("lottie-web", () => ({
  default: { loadAnimation: () => ({ destroy: () => {} }) },
}));

let sessionState: Record<string, unknown> = {};
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: vi.fn(),
  useBuildSession: () => sessionState,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({ currentSessionId: null }),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ tenantName: "Acme" }),
}));
vi.mock("@/components/voice/MicButton", () => ({
  MicButton: () => null,
}));

import { BuildModePane } from "./BuildModePane";
import { AppPreviewFrame } from "../home/AppPreviewFrame";
import { READINESS_POLL_MS, READINESS_SLOW_AFTER_MS } from "@/lib/workspace/useAppReadiness";

const READINESS_PATH = "/api/workspace/app-preview/readiness";

let seq = 0;
function freshApp() {
  seq += 1;
  return `https://surface-${seq}-${Math.random().toString(36).slice(2, 8)}.onrender.com`;
}

type Answer = { status: number; body?: unknown };
function script(answers: Answer[]) {
  const queue = [...answers];
  apiFetch.mockImplementation(async (path: string) => {
    if (!String(path).startsWith(READINESS_PATH)) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  });
}

const waking = { status: 200, body: { state: "waking" } };
const ready = { status: 200, body: { state: "ready" } };
const suspended = { status: 200, body: { state: "suspended" } };
const probes = () => apiFetch.mock.calls.filter(([p]) => String(p).startsWith(READINESS_PATH));

async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function pane(url: string) {
  sessionState = {
    loaded: true,
    notFound: false,
    authExpired: false,
    loadError: null,
    run: {
      id: "run-1",
      objective: "Build product: A landing page",
      status: "done",
      createdAt: null,
      updatedAt: null,
      stages: [{ stage: "deploy", status: "done" }],
      failure: null,
    },
    isCurrent: true,
    previewUrl: url,
    previewKind: "final",
    liveUrl: url,
    repoUrl: null,
    refines: [],
    refinesLoaded: true,
    sendRefine: vi.fn(),
    refineSubmitting: false,
    cancelRun: vi.fn(),
    stopping: false,
    retry: vi.fn(),
  };
  return render(
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
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
});

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AppPreviewFrame readiness gate", () => {
  it("holds the iframe until ready and never flags a waking app as blocked", async () => {
    const url = freshApp();
    script([waking]);
    const view = render(<AppPreviewFrame liveUrl={url} />);
    await tick();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(screen.getByText("Starting up your app…")).toBeTruthy();
    await tick(10_000);
    expect(screen.queryByText(/blocks embedding/)).toBeNull();
    script([ready]);
    await tick(READINESS_POLL_MS);
    expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe(url);
  });

  it("shows the paused notice for a suspended app", async () => {
    script([suspended]);
    const view = render(<AppPreviewFrame liveUrl={freshApp()} />);
    await tick();
    expect(screen.getByText("This app is paused")).toBeTruthy();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.textContent).not.toMatch(/render/i);
  });
});

describe("Build chat preview thumbnail", () => {
  it("shows a skeleton until the app is ready, then the thumbnail iframe", async () => {
    const url = freshApp();
    script([waking, ready]);
    pane(url);
    await tick();
    expect(document.querySelector('iframe[title$="thumbnail"]')).toBeNull();
    await tick(READINESS_POLL_MS);
    expect(document.querySelector('iframe[title$="thumbnail"]')?.getAttribute("src")).toBe(url);
  });
});
