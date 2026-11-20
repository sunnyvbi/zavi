// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { BUILD_PROGRESS_BODY, PICK_LOOK_HEADLINE, WebsiteBuildProgress } from "./WebsiteBuildProgress";
import type { BuildStageRow } from "@/lib/workspace/useBuildPreview";

vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));

const MIN = 60_000;
const T0 = Date.parse("2026-10-07T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const parked: BuildStageRow[] = [
  { stage: "provision", status: "done", started_at: iso(T0 - 6 * MIN), expected_ms: 1 * MIN },
  { stage: "spec", status: "done", started_at: iso(T0 - 5 * MIN), expected_ms: 4 * MIN },
  { stage: "scaffold", status: "pending", expected_ms: 25 * MIN },
  { stage: "build", status: "pending", expected_ms: 10 * MIN },
];

const scaffolding = (start: number): BuildStageRow[] => [
  parked[0]!,
  parked[1]!,
  { stage: "scaffold", status: "running", started_at: iso(start), expected_ms: 25 * MIN },
  parked[3]!,
];

const Picker = () => <div data-testid="look-picker-slot">three looks</div>;
const text = () => document.body.textContent ?? "";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the preview while the build waits for the founder's look", () => {
  it("shows the pick headline, the waiting line and the picker, with no percent, bar or time left", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    render(<WebsiteBuildProgress stages={parked} failure={null} failed={false} runId="run-1" awaitingPick picker={<Picker />} />);
    expect(screen.getByTestId("build-progress-pick-look").textContent).toBe("Pick a website");
    expect(screen.queryByTestId("build-progress-waiting")).toBeNull();
    expect(text()).not.toMatch(/starting in|recommended look/i);
    expect(screen.getByTestId("look-picker-slot")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByTestId("build-lottie")).toBeNull();
    expect(text()).not.toMatch(/%/);
    expect(text()).not.toMatch(/minutes? left/);
    expect(text()).not.toMatch(/Have a coffee|take a break/);
    expect(text()).not.toContain(BUILD_PROGRESS_BODY);
  });

  it("waiting for hours never turns into a percent, a time or the slow note", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    render(<WebsiteBuildProgress stages={scaffolding(T0)} failure={null} failed={false} runId="run-1" awaitingPick picker={<Picker />} />);
    act(() => void vi.advanceTimersByTime(3 * 60 * MIN));
    expect(screen.getByTestId("build-progress-pick-look").textContent).toBe("Pick a website");
    expect(text()).not.toMatch(/starting in|recommended look/i);
    expect(screen.queryByTestId("build-progress-slow")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(text()).not.toMatch(/%|minutes? left|longer than usual/);
  });

  it("after the pick the real progress returns in place: bar, percent and time left, and the picker is gone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const view = render(
      <WebsiteBuildProgress stages={parked} failure={null} failed={false} runId="run-1" awaitingPick picker={<Picker />} />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    view.rerender(<WebsiteBuildProgress stages={scaffolding(T0)} failure={null} failed={false} runId="run-1" awaitingPick={false} picker={<Picker />} />);
    const bar = screen.getByRole("progressbar");
    const pct = Number(bar.getAttribute("aria-valuenow"));
    expect(pct).toBeGreaterThan(0);
    expect(text()).toContain(`${pct}%`);
    expect(text()).toContain(`About 35 minutes left. ${BUILD_PROGRESS_BODY}`);
    expect(text()).toContain("Have a coffee, or");
    expect(screen.queryByTestId("look-picker-slot")).toBeNull();
    expect(screen.queryByText(PICK_LOOK_HEADLINE)).toBeNull();
    expect(screen.queryByTestId("build-progress-waiting")).toBeNull();
  });

  it("without the prop (flag off) the loader is exactly what it was before", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const off = render(<WebsiteBuildProgress stages={parked} failure={null} failed={false} runId="run-1" />);
    const before = off.container.innerHTML;
    cleanup();
    const explicit = render(
      <WebsiteBuildProgress stages={parked} failure={null} failed={false} runId="run-1" awaitingPick={false} picker={<Picker />} />,
    );
    expect(explicit.container.innerHTML).toBe(before);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(text()).toContain(`About 35 minutes left. ${BUILD_PROGRESS_BODY}`);
    expect(text()).not.toContain("Pick a website");
  });

  it("a stopped build says it stopped even if the brief still reads as awaiting a pick", () => {
    render(
      <WebsiteBuildProgress
        stages={parked}
        failure={{ class: "user_cancelled", message: "Cancelled", stage: "scaffold" } as never}
        failed
        runId="run-1"
        awaitingPick
        picker={<Picker />}
      />,
    );
    expect(text()).toContain("The build stopped before your site was ready");
    expect(screen.queryByTestId("look-picker-slot")).toBeNull();
    expect(text()).not.toContain("Pick a website");
  });

  it("a publish in progress is not hidden behind the picker", () => {
    render(<WebsiteBuildProgress stages={parked} failure={null} failed={false} publish="publishing" awaitingPick picker={<Picker />} />);
    expect(screen.getByTestId("build-publishing-spinner")).toBeTruthy();
    expect(screen.queryByTestId("look-picker-slot")).toBeNull();
  });
});
