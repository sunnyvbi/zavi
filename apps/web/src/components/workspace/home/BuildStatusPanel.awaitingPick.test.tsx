// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ status: null as unknown, design: null as unknown, designStatus: 200, paths: [] as string[] }));
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string) => {
    h.paths.push(path);
    if (path.startsWith("/api/workspace/autopilot/site-design?")) {
      return { ok: h.designStatus === 200, status: h.designStatus, json: async () => ({ design: h.design }) };
    }
    return { ok: true, status: 200, json: async () => h.status };
  },
}));

import { BuildStatusPanel } from "./BuildStatusPanel";
import { resetSharedSiteDesigns, SITE_DESIGN_POLL_MS } from "@/lib/workspace/useSiteDesign";

const MIN = 60_000;
const T0 = Date.parse("2026-10-07T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function statusBody(scaffold: "pending" | "running") {
  return {
    run: {
      id: "run-1",
      status: "active",
      objective: "Build product: cakes",
      spend_usd: 0,
      max_usd: null,
      created_at: iso(T0 - 6 * MIN),
      updated_at: iso(T0),
      stages: [
        { stage: "provision", status: "done", started_at: iso(T0 - 6 * MIN), expected_ms: 2 * MIN, error: null },
        { stage: "spec", status: "done", started_at: iso(T0 - 4 * MIN), expected_ms: 4 * MIN, error: null },
        scaffold === "running"
          ? { stage: "scaffold", status: "running", started_at: iso(T0), expected_ms: 25 * MIN, error: null }
          : { stage: "scaffold", status: "pending", expected_ms: 25 * MIN, error: null },
        { stage: "build", status: "pending", expected_ms: 10 * MIN, error: null },
      ],
    },
    target: { repo_url: null, live_url: null },
  };
}

const look = (id: string) => ({
  id,
  label: id,
  mood: `${id} mood`,
  recommended: id === "brand",
  fonts: { display: "Fraunces", body: "Inter" },
  swatches: { background: "#ffffff", foreground: "#111111", primary: "#2255aa", accent: "#ddeeff", muted: "#f3f3f3" },
  radius: "0.5rem",
});
const designRow = (awaiting: boolean, picked: boolean) => ({
  run_id: "run-1",
  awaiting_pick: awaiting,
  picked,
  source: "model",
  looks: [look("brand"), look("luxe"), look("studio")],
  chosen: "brand",
  applied: null,
  locked: null,
  plan: { audience: null, positioning: null, tone: null, main_action: null, sections: [], pages: [], facts: [] },
  checklist: null,
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
const text = () => document.body.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  window.sessionStorage.clear();
  resetSharedSiteDesigns();
  h.paths.length = 0;
  h.designStatus = 200;
  h.status = statusBody("pending");
  h.design = designRow(true, false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the Home build panel while the build waits for a look", () => {
  it("shows the waiting line with no bar, percent, time-left estimate or slow note", async () => {
    render(<BuildStatusPanel active />);
    await flush();
    await flush();
    expect(h.paths).toContain("/api/workspace/autopilot/site-design?run_id=run-1");
    expect(screen.getByText(/Waiting for you to pick a website/)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(text()).not.toMatch(/minutes? left|\d+%/);
    await act(async () => void vi.advanceTimersByTime(3 * 60 * MIN));
    await flush();
    expect(screen.getByText(/Waiting for you to pick a website/)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByTestId("build-status-slow")).toBeNull();
    expect(text()).not.toMatch(/minutes? left|\d+%|longer than usual/i);
    expect(screen.getByRole("heading", { name: "Pick a website" })).toBeTruthy();
  });

  it("a stage reported running during the wait still never reads slow or gives a time", async () => {
    h.status = statusBody("running");
    render(<BuildStatusPanel active />);
    await flush();
    await flush();
    await act(async () => void vi.advanceTimersByTime(3 * 60 * MIN));
    await flush();
    expect(screen.queryByTestId("build-status-slow")).toBeNull();
    expect(screen.getByText(/Waiting for you to pick a website/)).toBeTruthy();
    expect(text()).not.toMatch(/minutes? left|longer than usual/);
  });

  it("once the pick lands the bar and the real time left come back on the next design read", async () => {
    render(<BuildStatusPanel active />);
    await flush();
    await flush();
    expect(screen.queryByRole("progressbar")).toBeNull();
    h.design = designRow(false, true);
    h.status = statusBody("running");
    await act(async () => void vi.advanceTimersByTime(SITE_DESIGN_POLL_MS));
    await flush();
    await flush();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(text()).toMatch(/About 35 minutes left/);
    expect(text()).not.toContain("Waiting for you to pick a website");
  });

  it("flag off: the bar and the time left are unchanged", async () => {
    h.design = designRow(false, false);
    h.status = statusBody("running");
    render(<BuildStatusPanel active />);
    await flush();
    await flush();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(text()).toMatch(/About 35 minutes left/);
    expect(text()).not.toContain("Waiting for you to pick a website");
  });

  it("a workspace build with no brief (404) is unchanged", async () => {
    h.designStatus = 404;
    h.status = statusBody("running");
    render(<BuildStatusPanel active />);
    await flush();
    await flush();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(text()).toMatch(/About 35 minutes left/);
  });
});
