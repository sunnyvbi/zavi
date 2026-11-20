// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PinterestPayload, PinterestWindow } from "../PinterestAnalytics";

const dash = vi.hoisted(() => ({ state: { data: null as unknown, loading: false, refreshing: false, error: null as string | null, refresh: vi.fn() } }));
vi.mock("../../agent/dashboard-ui", () => ({ useAgentDashboard: () => dash.state }));
vi.mock("../../actions/ChannelDashboardControls", () => ({ ChannelDashboardControls: () => null }));
vi.mock("../../actions/PinterestReadinessLine", () => ({ PinterestReadinessLine: () => null }));

import { PinterestAnalytics, engagementRate } from "../PinterestAnalytics";

afterEach(cleanup);

const pin = (id: string, title: string, format: "image" | "video", impressions: number, engagements: number) => ({
  id, title, format, image: `https://i.pinimg.com/150x150/${id}.jpg`, url: `https://www.pinterest.com/pin/${id}/`, impressions, engagements, clicks: 0, saves: 0,
});

const month: PinterestWindow = {
  days: 30,
  views: 7400,
  engagements: 266,
  clicks: 191,
  new_followers: 52,
  prev: { views: 7700, engagements: 254, clicks: 157, new_followers: 51 },
  formats: [
    { format: "video", impressions: 1311, engagements: 55 },
    { format: "image", impressions: 5619, engagements: 197 },
  ],
  top: [pin("a", "The weekly math of renting", "video", 857, 47), pin("b", "Why gig drivers rent, not buy", "image", 2520, 121)],
};

describe("PinterestAnalytics", () => {
  it("draws the headline, the four tiles with their change, formats and top posts", () => {
    dash.state = { ...dash.state, data: { connected: true, analytics: { as_of: "2026-11-10", windows: { "30": month } } } satisfies PinterestPayload };
    render(<PinterestAnalytics active connected foot={<p>History</p>} />);
    expect(screen.getByTestId("pinterest-analytics-headline").textContent).toBe("Video performs best, with 4.2% engagement in the last 30 days.");
    expect(screen.getByTestId("kpi-tile-views").textContent).toBe("Views7.4K4% downon last month");
    expect(screen.getByTestId("kpi-tile-engagement").textContent).toContain("3.6%");
    expect(screen.getByTestId("kpi-tile-link-clicks").textContent).toBe("Link clicks19122% upon last month");
    expect(screen.getByTestId("kpi-tile-new-followers").textContent).toBe("New followers522% upon last month");
    expect(screen.getByTestId("pinterest-format-video").textContent).toBe("Video4.2%");
    const rows = screen.getAllByTestId("pinterest-top-post");
    expect(within(rows[0]).getByText("Top")).toBeTruthy();
    expect(rows[0].textContent).toBe("The weekly math of rentingTopVideo8575.5%");
    expect(screen.getByText("History")).toBeTruthy();
  });

  it("leads with the top pin when there is one format, and offers a retry when the top pins failed", () => {
    const refresh = vi.fn();
    dash.state = { ...dash.state, refresh, data: { connected: true, analytics: { as_of: "2026-11-10", windows: { "30": { ...month, formats: [month.formats[0]], top: [pin("a", "The weekly math of renting", "video", 857, 47)], pins_failed: true } } } } satisfies PinterestPayload };
    render(<PinterestAnalytics active connected />);
    expect(screen.getByTestId("pinterest-analytics-headline").textContent).toBe("The weekly math of renting leads your most-viewed pins in the last 30 days, with 5.5% engagement.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("does not read anything until the tab is opened", () => {
    const { container } = render(<PinterestAnalytics active={false} connected />);
    expect(container.textContent).toBe("");
  });

  it("says so when the account is not connected", () => {
    dash.state = { ...dash.state, data: { connected: false, analytics: { as_of: null, windows: { "30": null } } } };
    render(<PinterestAnalytics active connected={false} />);
    expect(screen.getByRole("status").textContent).toMatch(/Connect Pinterest in Settings/);
    expect(screen.getByTestId("kpi-tile-views").textContent).toBe("Views–");
  });

  it("has no engagement rate without engagement numbers", () => {
    expect(engagementRate({ views: 100, engagements: null })).toBeNull();
    expect(engagementRate({ views: 0, engagements: 3 })).toBeNull();
  });
});
