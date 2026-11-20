// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { BUILD_PROGRESS_BODY, BUILD_SLOW_BODY, buildProgressBody, WebsiteBuildProgress } from "./WebsiteBuildProgress";
import type { BuildStageRow } from "@/lib/workspace/useBuildPreview";

vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));

const MIN = 60_000;
const T0 = Date.parse("2026-10-01T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function scaffoldHanging(scaffoldStart: number, extra: Partial<BuildStageRow> = {}): BuildStageRow[] {
  return [
    { stage: "provision", status: "done", started_at: iso(T0 - 7 * MIN), expected_ms: 2 * MIN },
    { stage: "spec", status: "done", started_at: iso(T0 - 5 * MIN), expected_ms: 4 * MIN },
    { stage: "scaffold", status: "running", started_at: iso(scaffoldStart), expected_ms: 25 * MIN, ...extra },
    { stage: "build", status: "pending", expected_ms: 20 * MIN },
  ];
}

const slowNote = () => {
  const el = screen.queryByTestId("build-progress-slow");
  return el && !el.classList.contains("invisible") ? el : null;
};
const body = () => screen.getByText(/once your site is fully built|build is taking longer than usual/);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("QA lane2.3: a step far past its expected time stops promising a time", () => {
  it("a scaffold hung for 48 minutes says it is taking longer than usual and withdraws the time left", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    render(<WebsiteBuildProgress stages={scaffoldHanging(T0)} failure={null} failed={false} runId="run-1" />);
    expect(slowNote()).toBeNull();
    expect(body().textContent).toBe(`About 45 minutes left. ${BUILD_PROGRESS_BODY}`);

    act(() => void vi.advanceTimersByTime(20 * MIN));
    expect(slowNote()).toBeNull();
    expect(body().textContent).toBe(`About 25 minutes left. ${BUILD_PROGRESS_BODY}`);

    act(() => void vi.advanceTimersByTime(28 * MIN));
    expect(slowNote()?.textContent).toBe("This step is taking longer than usual. We're still on it.");
    expect(body().textContent).toBe(BUILD_SLOW_BODY);
    expect(body().textContent).not.toMatch(/minutes? left|few minutes/);
  });

  it("a reload 40 minutes into the step shows the slow state at once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 40 * MIN);
    render(<WebsiteBuildProgress stages={scaffoldHanging(T0)} failure={null} failed={false} runId="run-1" />);
    expect(slowNote()).not.toBeNull();
  });

  it("a retry starts its own clock, so attempt 2 is not called slow the moment it begins", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 48 * MIN);
    render(
      <WebsiteBuildProgress stages={scaffoldHanging(Date.now(), { attempt: 2 })} failure={null} failed={false} runId="run-1" />,
    );
    expect(slowNote()).toBeNull();
    expect(screen.getByTestId("build-progress-retry")).toBeTruthy();
  });

  it("without expected lengths (key off) nothing changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 60 * MIN);
    const stages = scaffoldHanging(T0).map(({ expected_ms: _e, ...s }) => s);
    render(<WebsiteBuildProgress stages={stages} failure={null} failed={false} runId="run-1" />);
    expect(slowNote()).toBeNull();
    expect(body().textContent).toBe(BUILD_PROGRESS_BODY);
  });
});

describe("publish on request: the build screen does not promise a publish it will not do", () => {
  it("the normal and the slow copy drop the going-live promise and point at Publish", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 5 * MIN);
    const twoSteps: BuildStageRow[] = [
      { stage: "provision", status: "done", started_at: iso(T0 - MIN), expected_ms: MIN },
      { stage: "build", status: "running", started_at: iso(T0), expected_ms: 10 * MIN },
    ];
    const view = render(
      <WebsiteBuildProgress stages={twoSteps} failure={null} failed={false} runId="run-1" publishOnRequest />,
    );
    expect(body().textContent).toBe(
      "About 5 minutes left. Your preview shows up here once your site is fully built. When your site is built, press Publish to put it on its address.",
    );
    expect(document.body.textContent).not.toMatch(/moment it's live|Publishing it to your live address|few minutes/);
    view.unmount();

    const noBudgets = render(
      <WebsiteBuildProgress stages={twoSteps.map(({ expected_ms: _e, ...s }) => s)} failure={null} failed={false} runId="run-3" publishOnRequest />,
    );
    expect(body().textContent).toBe(
      "Your preview shows up here once your site is fully built. When your site is built, press Publish to put it on its address.",
    );
    noBudgets.unmount();

    vi.setSystemTime(T0 + 13 * MIN);
    render(
      <WebsiteBuildProgress stages={twoSteps} failure={null} failed={false} runId="run-2" publishOnRequest />,
    );
    expect(slowNote()).not.toBeNull();
    expect(body().textContent).toBe("This build is taking longer than usual. You can leave this page and come back.");
    expect(document.body.textContent).not.toMatch(/moment it's live|minutes left|few minutes/);
  });

  it("with the setting off the copy is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 5 * MIN);
    render(<WebsiteBuildProgress stages={scaffoldHanging(T0)} failure={null} failed={false} runId="run-1" />);
    expect(body().textContent).toBe(buildProgressBody("About 40 minutes left"));
    expect(body().textContent).toBe(`About 40 minutes left. ${BUILD_PROGRESS_BODY}`);
    expect(body().textContent).toContain("the moment it's live");
  });
});
