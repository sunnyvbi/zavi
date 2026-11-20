// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MetricCard } from "../metrics/MetricCard";
import { pinterestKpis } from "./pinterestDashboard";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";

afterEach(cleanup);

const NOW = Date.parse("2026-10-23T09:00:00Z");

const metric = (over: Partial<ChannelMetric>): ChannelMetric => ({
  key: "impressions",
  value: 12596,
  unit: "count",
  window_kind: "30d",
  day: "2026-10-23",
  grounded: true,
  prev_value: null,
  prev_day: null,
  ...over,
});

const tiles = (metrics: ChannelMetric[]) => pinterestKpis({ connected: true, metrics }, NOW);

describe("Pinterest metric tiles say what the change is measured against", () => {
  it("names the day of the older snapshot, so a four-day gap never reads as day-over-day", () => {
    const [m] = tiles([metric({ prev_value: 12400, prev_day: "2026-10-19" })]);
    render(<MetricCard metric={m} />);
    expect(screen.getByText("+196 since Oct 19")).toBeTruthy();
    expect(screen.getByTestId("delta-impressions").textContent).toBe("+1.6%");
  });

  it("says a drop and no change plainly, with the comparison day", () => {
    const [down, flat] = tiles([
      metric({ key: "saves", value: 40, prev_value: 52, prev_day: "2026-10-22" }),
      metric({ key: "followers", value: 120, window_kind: null, prev_value: 120, prev_day: "2026-10-22" }),
    ]);
    expect(down.note).toBe("-12 since Oct 22");
    expect(flat.note).toBe("No change since Oct 22");
  });

  it("explains the first reading instead of leaving the tile with no change line", () => {
    const [m] = tiles([metric({})]);
    render(<MetricCard metric={m} />);
    expect(screen.getByText("First reading today. The change shows when you open this on a later day.")).toBeTruthy();
    expect(screen.queryByTestId("delta-impressions")).toBeNull();
  });

  it("dates a first reading that was not taken today", () => {
    const [m] = tiles([metric({ day: "2026-10-21" })]);
    expect(m.note).toBe("First reading on Oct 21. The change shows when you open this on a later day.");
  });

  it("does not claim a comparison when the earlier value has no day", () => {
    const [m] = tiles([metric({ prev_value: 12400, prev_day: null })]);
    expect(m.note).toMatch(/^First reading today/);
  });

  it("returns no tiles when the payload has no metrics", () => {
    expect(pinterestKpis(null, NOW)).toEqual([]);
    expect(pinterestKpis({ connected: true }, NOW)).toEqual([]);
  });
});
