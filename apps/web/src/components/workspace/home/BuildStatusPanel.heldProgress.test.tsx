// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({ body: null as unknown }));
vi.mock("@/lib/api", () => ({
  apiFetch: async () => ({ ok: true, status: 200, json: async () => api.body }),
}));
vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));

import { BUILD_SLOW_NOTE, BuildStatusPanel } from "./BuildStatusPanel";
import { WebsiteBuildProgress } from "../website/WebsiteBuildProgress";
import type { BuildStageRow } from "@/lib/workspace/useBuildPreview";

const MIN = 60_000;
const T0 = Date.parse("2026-10-01T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function attemptOne(): BuildStageRow[] {
  return [
    { stage: "provision", status: "done", started_at: iso(T0 - 30 * MIN), expected_ms: 2 * MIN },
    { stage: "spec", status: "done", started_at: iso(T0 - 25 * MIN), expected_ms: 4 * MIN },
    { stage: "scaffold", status: "done", started_at: iso(T0 - 20 * MIN), expected_ms: 10 * MIN },
    { stage: "build", status: "running", started_at: iso(T0 - 6 * MIN), expected_ms: 10 * MIN },
    { stage: "qa", status: "pending", expected_ms: 5 * MIN },
  ];
}

function attemptTwo(now: number): BuildStageRow[] {
  return [
    { stage: "provision", status: "done", started_at: iso(T0 - 30 * MIN), expected_ms: 2 * MIN },
    { stage: "spec", status: "done", started_at: iso(T0 - 25 * MIN), expected_ms: 4 * MIN },
    { stage: "scaffold", status: "running", started_at: iso(now), expected_ms: 10 * MIN, attempt: 2 },
    { stage: "build", status: "pending", expected_ms: 10 * MIN },
    { stage: "qa", status: "pending", expected_ms: 5 * MIN },
  ];
}

function statusBody(runId: string, stages: BuildStageRow[]) {
  return {
    run: {
      id: runId,
      status: "active",
      objective: "Build product: cakes",
      spend_usd: 0,
      max_usd: null,
      created_at: iso(T0 - 30 * MIN),
      updated_at: iso(T0),
      stages: stages.map((s) => ({ error: null, ...s })),
    },
    target: { repo_url: null, live_url: null },
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

const shownPct = () => Number(screen.getByText(/^\d+%$/).textContent!.replace("%", ""));
const barPct = () => Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DEL-1323 B19: the build bar never goes backwards across a reload", () => {
  it("Website build view: attempt 2 of the same run, mounted fresh, keeps the 71% it already showed", () => {
    const first = render(<WebsiteBuildProgress stages={attemptOne()} failure={null} failed={false} runId="run-1" />);
    expect(shownPct()).toBe(71);
    first.unmount();

    vi.setSystemTime(T0 + 2 * MIN);
    render(<WebsiteBuildProgress stages={attemptTwo(Date.now())} failure={null} failed={false} runId="run-1" />);
    expect(shownPct()).toBeGreaterThanOrEqual(71);
    expect(window.sessionStorage.getItem("zavi.buildPct.run-1")).toBe("71");
  });

  it("Website build view: a different run starts from its own progress", () => {
    const first = render(<WebsiteBuildProgress stages={attemptOne()} failure={null} failed={false} runId="run-1" />);
    expect(shownPct()).toBe(71);
    first.unmount();
    render(<WebsiteBuildProgress stages={attemptTwo(Date.now())} failure={null} failed={false} runId="run-2" />);
    expect(shownPct()).toBe(40);
  });

  it("Home panel: a remount on attempt 2 of the same run holds the bar at 71", async () => {
    api.body = statusBody("run-1", attemptOne());
    const first = render(<BuildStatusPanel active={false} />);
    await flush();
    expect(barPct()).toBe(71);
    first.unmount();

    vi.setSystemTime(T0 + 2 * MIN);
    api.body = statusBody("run-1", attemptTwo(Date.now()));
    render(<BuildStatusPanel active={false} />);
    await flush();
    expect(barPct()).toBeGreaterThanOrEqual(71);
  });

  it("storage that throws does not break the bar", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<WebsiteBuildProgress stages={attemptOne()} failure={null} failed={false} runId="run-1" />);
    expect(shownPct()).toBe(71);
  });
});

describe("DEL-1323 B19: the Home panel says when a step runs long", () => {
  it("a step well past its expected time shows the slow note and drops the time left", async () => {
    const stages: BuildStageRow[] = [
      { stage: "provision", status: "done", started_at: iso(T0 - 50 * MIN), expected_ms: 2 * MIN },
      { stage: "spec", status: "done", started_at: iso(T0 - 45 * MIN), expected_ms: 4 * MIN },
      { stage: "scaffold", status: "running", started_at: iso(T0 - 40 * MIN), expected_ms: 25 * MIN },
      { stage: "build", status: "pending", expected_ms: 20 * MIN },
      { stage: "qa", status: "pending", expected_ms: 5 * MIN },
    ];
    api.body = statusBody("run-slow", stages);
    render(<BuildStatusPanel active={false} />);
    await flush();
    expect(screen.getByTestId("build-status-slow").textContent).toBe(BUILD_SLOW_NOTE);
    expect(screen.queryByText(/minutes? left|few minutes/)).toBeNull();
  });

  it("a step inside its expected time shows no slow note", async () => {
    api.body = statusBody("run-ok", attemptOne());
    render(<BuildStatusPanel active={false} />);
    await flush();
    expect(screen.queryByTestId("build-status-slow")).toBeNull();
    expect(screen.getByText(/About 9 minutes left/)).toBeTruthy();
    expect(screen.queryByText(/few minutes/)).toBeNull();
  });
});

describe("DEL-1323 B19: a failed stage never becomes the held floor", () => {
  function failedAtScaffold(): BuildStageRow[] {
    return [
      { stage: "provision", status: "done", started_at: iso(T0 - 30 * MIN), expected_ms: 2 * MIN },
      { stage: "spec", status: "done", started_at: iso(T0 - 25 * MIN), expected_ms: 4 * MIN },
      { stage: "scaffold", status: "failed", started_at: iso(T0 - 20 * MIN), expected_ms: 10 * MIN },
      { stage: "build", status: "pending", expected_ms: 10 * MIN },
      { stage: "qa", status: "pending", expected_ms: 5 * MIN },
    ];
  }

  it("Website build view: after Continue on the same run the bar follows real progress, not the 60% the failure showed", () => {
    const failed = render(<WebsiteBuildProgress stages={failedAtScaffold()} failure={null} failed={true} runId="run-f" />);
    expect(window.sessionStorage.getItem("zavi.buildPct.run-f")).toBeNull();
    failed.rerender(<WebsiteBuildProgress stages={attemptTwo(Date.now())} failure={null} failed={false} runId="run-f" />);
    expect(shownPct()).toBe(40);
    failed.unmount();
    render(<WebsiteBuildProgress stages={attemptTwo(Date.now())} failure={null} failed={false} runId="run-f" />);
    expect(shownPct()).toBe(40);
  });

  it("Home panel: a reload after Continue on a run that failed at stage 3 does not freeze at 60%", async () => {
    api.body = statusBody("run-g", failedAtScaffold());
    const first = render(<BuildStatusPanel active={false} />);
    await flush();
    expect(window.sessionStorage.getItem("zavi.buildPct.run-g")).toBeNull();
    first.unmount();
    api.body = statusBody("run-g", attemptTwo(Date.now()));
    render(<BuildStatusPanel active={false} />);
    await flush();
    expect(barPct()).toBe(40);
  });

  it("progress shown before the failure is still kept as the floor", () => {
    const view = render(<WebsiteBuildProgress stages={attemptOne()} failure={null} failed={false} runId="run-h" />);
    expect(shownPct()).toBe(71);
    view.rerender(<WebsiteBuildProgress stages={failedAtScaffold()} failure={null} failed={true} runId="run-h" />);
    view.rerender(<WebsiteBuildProgress stages={attemptTwo(Date.now())} failure={null} failed={false} runId="run-h" />);
    expect(shownPct()).toBeGreaterThanOrEqual(71);
  });
});
