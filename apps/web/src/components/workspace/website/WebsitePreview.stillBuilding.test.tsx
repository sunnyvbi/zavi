// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));

import { WebsitePreview } from "./WebsitePreview";
import { AppPreviewFrame } from "../home/AppPreviewFrame";
import { BuildStatusPanel } from "../home/BuildStatusPanel";
import { STILL_BUILDING_TITLE } from "@/lib/workspace/stillBuilding";

const READINESS_PATH = "/api/workspace/app-preview/readiness";
const POLL_MS = 5000;

let seq = 0;
function freshApp() {
  seq += 1;
  return `https://build-${seq}-${Math.random().toString(36).slice(2, 8)}.onrender.com`;
}

let buildStatus: unknown = {};

function serve() {
  apiFetch.mockImplementation(async (path: string) => {
    if (String(path).startsWith(READINESS_PATH)) {
      return { ok: true, status: 200, json: async () => ({ state: "ready" }) };
    }
    if (String(path).startsWith("/api/workspace/autopilot/build-status")) {
      return { ok: true, status: 200, json: async () => buildStatus };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

function homeBuild(runStatus: string, kind: "early" | "final", url: string) {
  return {
    run: {
      id: "run-1",
      status: runStatus,
      spend_usd: 0,
      max_usd: null,
      created_at: "2026-10-02T08:00:00Z",
      updated_at: "2026-10-02T08:05:00Z",
      stages: [{ stage: "build", status: runStatus === "active" ? "running" : "done", error: null }],
    },
    target: { repo_url: null, live_url: null },
    preview: { url, kind },
  };
}

const frame = () => document.querySelector("iframe");
const stillBuilding = () => screen.queryByTestId("preview-still-building");

async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount(url: string, guard: boolean) {
  return render(<WebsitePreview liveUrl={url} cacheKey={null} appId={new URL(url).host} builtApp guardWhileBuilding={guard} />);
}

beforeEach(() => {
  vi.useFakeTimers();
  buildStatus = {};
  serve();
});

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  vi.useRealTimers();
});

describe("the Build preview never frames the site while a build is running", () => {
  it("a sandbox serving the 200 starter page mid-build shows 'Still building your site', never the iframe", async () => {
    mount(freshApp(), true);
    await tick();
    await tick();
    expect(stillBuilding()).not.toBeNull();
    expect(screen.getByText(STILL_BUILDING_TITLE)).toBeTruthy();
    expect(frame()).toBeNull();
    await tick(POLL_MS * 6);
    expect(stillBuilding()).not.toBeNull();
    expect(frame()).toBeNull();
  });

  it("holds the loading screen even before the address answers, so no starting or error card flashes", async () => {
    apiFetch.mockImplementation(async () => new Promise(() => {}));
    mount(freshApp(), true);
    await tick();
    await tick(POLL_MS * 3);
    expect(stillBuilding()).not.toBeNull();
    expect(screen.queryByTestId("preview-readiness-gate")).toBeNull();
    expect(frame()).toBeNull();
  });

  it("frames the site as soon as the build is ready", async () => {
    const url = freshApp();
    const view = mount(url, true);
    await tick();
    await tick();
    expect(frame()).toBeNull();
    view.rerender(<WebsitePreview liveUrl={url} cacheKey={null} appId={new URL(url).host} builtApp guardWhileBuilding={false} />);
    await tick();
    expect(stillBuilding()).toBeNull();
    expect(screen.queryByText(STILL_BUILDING_TITLE)).toBeNull();
    expect(frame()).not.toBeNull();
  });

  it("mid-build there is no way to open the half-built site: no 'Show preview anyway' anywhere", async () => {
    mount(freshApp(), true);
    await tick();
    await tick();
    expect(screen.queryByRole("button", { name: /preview anyway/i })).toBeNull();
    await tick(POLL_MS * 2);
    expect(stillBuilding()).not.toBeNull();
    expect(frame()).toBeNull();
    cleanup();
    render(<AppPreviewFrame liveUrl="https://5173-sbxfirst.e2b.app" guardWhileBuilding tall />);
    await tick();
    expect(screen.queryByRole("button", { name: /preview anyway/i })).toBeNull();
    expect(frame()).toBeNull();
  });

  it("outside a running build it frames the site as before", async () => {
    mount(freshApp(), false);
    await tick();
    await tick();
    expect(stillBuilding()).toBeNull();
    expect(frame()).not.toBeNull();
  });

  it("the Home build panel holds its early preview while the build runs, even though the page answers", async () => {
    buildStatus = homeBuild("active", "early", freshApp());
    render(<BuildStatusPanel active={false} />);
    await tick();
    await tick();
    await tick();
    expect(stillBuilding()).not.toBeNull();
    expect(frame()).toBeNull();
  });

  it.each([
    ["the finished build's final preview", "done", "final"],
    ["a build that stopped with its early preview still up", "paused", "early"],
    ["a running build's final preview", "active", "final"],
  ] as const)("the Home build panel never hides %s", async (_label, runStatus, kind) => {
    buildStatus = homeBuild(runStatus, kind, freshApp());
    render(<BuildStatusPanel active={false} />);
    await tick();
    await tick();
    await tick();
    expect(stillBuilding()).toBeNull();
    expect(frame()).not.toBeNull();
  });
});
