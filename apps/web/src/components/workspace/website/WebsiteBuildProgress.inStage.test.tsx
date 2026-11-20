// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { WebsiteBuildProgress } from "./WebsiteBuildProgress";
import { progressPct } from "../home/BuildStatusPanel";
import type { BuildStageRow } from "@/lib/workspace/useBuildPreview";

vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));

const MIN = 60_000;
const T0 = Date.parse("2026-10-01T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function oldFlow(scaffoldStart: number, extra: Partial<BuildStageRow> = {}): BuildStageRow[] {
  return [
    { stage: "provision", status: "done", started_at: iso(T0 - 7 * MIN), expected_ms: 2 * MIN },
    { stage: "spec", status: "done", started_at: iso(T0 - 5 * MIN), expected_ms: 4 * MIN },
    { stage: "scaffold", status: "running", started_at: iso(scaffoldStart), expected_ms: 25 * MIN, ...extra },
    { stage: "build", status: "pending", expected_ms: 20 * MIN },
  ];
}

const bar = () => Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("progressPct inside a running stage", () => {
  it("a 25-minute scaffold moves the bar every minute, stays below the next step's share, and never goes back", () => {
    const seen: number[] = [];
    for (let m = 0; m <= 60; m++) seen.push(progressPct(oldFlow(T0), T0 + m * MIN));
    expect(seen[0]).toBe(50);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[25]).toBeGreaterThanOrEqual(65);
    expect(seen[10]).toBeGreaterThan(seen[1]);
    expect(seen[25]).toBeGreaterThan(seen[10]);
    expect(Math.max(...seen)).toBeLessThan(75);
    expect(new Set(seen.slice(0, 26)).size).toBeGreaterThan(10);
  });

  it("never reports done while the last step is still running, however long it takes", () => {
    const stages: BuildStageRow[] = [
      { stage: "provision", status: "done" },
      { stage: "build", status: "done" },
      { stage: "deploy", status: "running", started_at: iso(T0), expected_ms: 3 * MIN },
    ];
    expect(progressPct(stages, T0 + 24 * 60 * MIN)).toBeLessThan(100);
    expect(progressPct(stages.map((s) => ({ ...s, status: "done" })), T0)).toBe(100);
  });

  it("without an expected length the running step keeps its half share, as before", () => {
    const stages = oldFlow(T0).map(({ expected_ms: _e, ...s }) => s);
    expect(progressPct(stages, T0 + 25 * MIN)).toBe(63);
  });
});

describe("WebsiteBuildProgress over a long step (fake clock)", () => {
  it("moves with the clock, a retry does not jump it back, and the next step starts above the boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { rerender } = render(<WebsiteBuildProgress stages={oldFlow(T0)} failure={null} failed={false} />);
    const seen = [bar()];
    for (let m = 1; m <= 25; m++) {
      act(() => void vi.advanceTimersByTime(MIN));
      seen.push(bar());
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[25]).toBeGreaterThan(seen[0] + 10);
    expect(seen[25]).toBeLessThan(75);

    const beforeRetry = bar();
    rerender(<WebsiteBuildProgress stages={oldFlow(Date.now(), { attempt: 2 })} failure={null} failed={false} />);
    expect(bar()).toBe(beforeRetry);
    expect(screen.getByTestId("build-progress-retry").textContent).toBe("Retrying app structure, attempt 2");
    for (let m = 1; m <= 40; m++) {
      act(() => void vi.advanceTimersByTime(MIN));
      expect(bar()).toBeGreaterThanOrEqual(beforeRetry);
      expect(bar()).toBeLessThan(75);
    }

    const next = oldFlow(T0).map((s) =>
      s.stage === "scaffold" ? { ...s, status: "done" } : s.stage === "build" ? { ...s, status: "running", started_at: iso(Date.now()) } : s,
    );
    rerender(<WebsiteBuildProgress stages={next} failure={null} failed={false} />);
    expect(bar()).toBeGreaterThanOrEqual(75);
    expect(bar()).toBeLessThan(100);
  });

  it("a new build in the same pane starts from its own progress, not the last build's", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const done = oldFlow(T0).map((s) => ({ ...s, status: "done" }));
    const { rerender } = render(<WebsiteBuildProgress stages={done} failure={null} failed={false} />);
    expect(bar()).toBe(100);
    const fresh: BuildStageRow[] = [
      { stage: "provision", status: "running", started_at: iso(T0), expected_ms: 2 * MIN },
      { stage: "spec", status: "pending" },
      { stage: "scaffold", status: "pending" },
      { stage: "build", status: "pending" },
    ];
    rerender(<WebsiteBuildProgress stages={fresh} failure={null} failed={false} />);
    expect(bar()).toBeLessThan(25);
  });
});

describe("WebsiteBuildProgress across two runs", () => {
  function earlyRun(provisionStart: number): BuildStageRow[] {
    return [
      { stage: "provision", status: "running", started_at: iso(provisionStart), expected_ms: 10 * MIN },
      { stage: "spec", status: "pending", expected_ms: 4 * MIN },
      { stage: "scaffold", status: "pending", expected_ms: 25 * MIN },
      { stage: "build", status: "pending", expected_ms: 20 * MIN },
    ];
  }

  it("a new run does not inherit the previous run's held percentage while both sit on their first step", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const first = earlyRun(T0 - 9 * MIN);
    const second = earlyRun(T0);
    const firstPct = progressPct(first, T0);
    const secondPct = progressPct(second, T0);
    expect(firstPct).toBeGreaterThan(secondPct);

    const { rerender } = render(
      <WebsiteBuildProgress stages={first} failure={null} failed={false} runId="run-a" />,
    );
    expect(bar()).toBe(firstPct);
    rerender(<WebsiteBuildProgress stages={second} failure={null} failed={false} runId="run-b" />);
    expect(bar()).toBe(secondPct);
  });

  it("within one run the held percentage still never goes back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const first = earlyRun(T0 - 9 * MIN);
    const { rerender } = render(
      <WebsiteBuildProgress stages={first} failure={null} failed={false} runId="run-a" />,
    );
    const held = bar();
    rerender(<WebsiteBuildProgress stages={earlyRun(T0)} failure={null} failed={false} runId="run-a" />);
    expect(bar()).toBe(held);
  });
});
