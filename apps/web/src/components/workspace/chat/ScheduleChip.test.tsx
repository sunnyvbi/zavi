// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, within, waitFor, fireEvent } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("../agent/ScheduleView", () => ({
  ScheduleView: ({ slug }: { slug: string }) => <div data-testid="schedule-view">{slug}</div>,
}));

import { ScheduleChip, scheduleLine, relativeUntil } from "./ScheduleChip";

const NOW = new Date("2026-09-10T03:00:00Z");

beforeEach(() => apiFetch.mockReset());

describe("scheduleLine", () => {
  it("describes a daily schedule in its zone with the next run", () => {
    const line = scheduleLine(
      { cron_expression: "0 13 * * *", enabled: true, last_fired_at: null, timezone: "Asia/Calcutta" },
      NOW,
    );
    expect(line).toMatch(/^Every day at 1:00 PM in /);
    expect(line).toMatch(/next run in 5h/);
    expect(line).toMatch(/1:00 PM\)$/);
  });

  it("says paused and no-schedule honestly", () => {
    expect(
      scheduleLine({ cron_expression: "0 13 * * *", enabled: false, last_fired_at: null, timezone: null }, NOW),
    ).toMatch(/paused$/);
    expect(scheduleLine(null)).toBe("No schedule yet");
  });

  it("relativeUntil is coarse", () => {
    expect(relativeUntil(new Date(NOW.getTime() + 25 * 60_000), NOW)).toBe("in 25m");
    expect(relativeUntil(new Date(NOW.getTime() + 5 * 3_600_000), NOW)).toBe("in 5h");
    expect(relativeUntil(new Date(NOW.getTime() + 3 * 86_400_000), NOW)).toBe("in 3d");
    expect(relativeUntil(NOW, NOW)).toBe("now");
  });
});

describe("ScheduleChip", () => {
  it("shows the schedule line and opens ScheduleView with the one-per-channel copy", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        schedule: { cron_expression: "0 13 * * *", enabled: true, last_fired_at: null, timezone: "Asia/Calcutta" },
      }),
    });
    const { container } = render(<ScheduleChip slug="x_organic" label="X" />);
    const btn = await within(container).findByRole("button", { name: /Every day at 1:00 PM/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.textContent).toMatch(/Change$/);
    fireEvent.click(btn);
    await waitFor(() => expect(within(container).getByTestId("schedule-view").textContent).toBe("x_organic"));
    expect(within(container).getByText(/One schedule per channel\. Saving replaces/)).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith("/api/agents/x_organic/schedule");
  });

  it("with no row it offers to set one", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ schedule: null }) });
    const { container } = render(<ScheduleChip slug="x_organic" />);
    const btn = await within(container).findByRole("button", { name: /No schedule yet/ });
    expect(btn.textContent).toMatch(/Set one$/);
  });
});
