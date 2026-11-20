import { act, cleanup, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { CampaignScheduleStatus } from "./CampaignScheduleStatus";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("hydrates expired schedules from the same empty initial markup", async () => {
  const element = <CampaignScheduleStatus endTime={1} />;
  const markup = renderToString(element);
  expect(markup).toBe("");
  const container = document.createElement("div");
  container.innerHTML = markup;
  document.body.append(container);
  const recoverable = vi.fn();
  const root = hydrateRoot(container, element, { onRecoverableError: recoverable });
  try {
    await act(async () => {});
    expect(container.textContent).toBe("Schedule ended");
    expect(recoverable).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("updates when the schedule ends and clears its timer on unmount", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const view = render(<CampaignScheduleStatus endTime={2} />);
  expect(screen.queryByText("Schedule ended")).toBeNull();
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText("Schedule ended")).toBeTruthy();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
