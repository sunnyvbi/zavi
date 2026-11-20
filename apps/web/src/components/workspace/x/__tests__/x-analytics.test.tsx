// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { XMetric, XPayload, XPostRow } from "../../agent/XAgentDashboard";

const dash = vi.hoisted(() => ({ state: { data: null as unknown, loading: false, refreshing: false, error: null as string | null, refresh: vi.fn() } }));
vi.mock("../../agent/dashboard-ui", () => ({ useAgentDashboard: () => dash.state }));
vi.mock("../../actions/ChannelDashboardControls", () => ({ ChannelDashboardControls: () => null }));

import { XAnalytics } from "../XAnalytics";

afterEach(cleanup);

const metric = (key: XMetric["key"], value: number | null, delta: number | null, unit: "count" | "pct" = "count"): XMetric => ({
  key, label: key, value, unit, delta, delta_unit: unit === "pct" ? "pp" : "pct", basis: "period",
});

const post = (id: string, text: string, kind: string, views: number, eng_rate: number | null, thumb_url: string | null = null): XPostRow => ({
  id, external_post_id: id, url: `https://x.com/i/web/status/${id}`, text, format: kind, kind, posted_at: "2026-11-01T10:00:00Z", source: "account", status: "published",
  thumb_url, media_type: null, views, likes: 0, replies: 0, reposts: 0, bookmarks: 0, link_clicks: 0, profile_clicks: 0, engagements: 0, eng_rate, private_metrics_available: true,
});

const payload: XPayload = {
  connected: true,
  handle: "company",
  window_days: 30,
  metrics: [
    metric("impressions", 19800, 10),
    metric("engagement_rate", 4.6, 0.86, "pct"),
    metric("link_clicks", 509, 2),
    metric("new_follows", 138, 15),
    metric("profile_visits", 412, 23),
    metric("replies", 96, -6),
    metric("likes", 684, 7),
    metric("reposts", 57, 20),
  ],
  checklist: {
    passed: 2,
    total: 5,
    signals: [
      { key: "avatar", label: "Profile picture", status: "pass", note: "Custom image set", link: null },
      { key: "cadence", label: "Posting cadence ≥ 3 / week", status: "unknown", note: "Shows once Zavi has a full week of your posts to count.", link: null },
      { key: "pinned", label: "Pinned post", status: "fix", note: "New visitors see no reason to follow.", link: "https://x.com/company" },
      { key: "bio", label: "Bio says what you do", status: "fix", note: "Your bio does not name the company.", link: null },
      { key: "link", label: "Link in bio", status: "pass", note: "upcar.ai", link: null },
    ],
  },
  formats: [
    { format: "link", views: 3427, engagements: 158 },
    { format: "poll", views: 1210, engagements: 47 },
    { format: "video", views: 4838, engagements: 155 },
    { format: "image", views: 9005, engagements: 189 },
  ],
  top_posts: [
    post("1", "Why gig drivers rent, not buy", "image", 6720, 1.8, "https://pbs.twimg.com/a.jpg"),
    post("2", "What to check before renting", "video", 4838, 3.2, "https://pbs.twimg.com/b.jpg"),
    post("3", "First day driving with a rental", "link", 3427, 4.6),
    post("4", "Thanks!", "reply", 9000, 9.9),
    post("5", "Your spare car could pay for itself", "poll", 1210, 3.9),
  ],
} as XPayload;

describe("XAnalytics", () => {
  it("draws the eight tiles with their change against the period before, and top posts", () => {
    dash.state = { ...dash.state, data: payload };
    render(<XAnalytics active foot={<p>History</p>} />);
    const tile = (name: string) => screen.getByTestId(`kpi-tile-${name}`).textContent;
    expect(tile("impressions")).toBe("Impressions19.8K+10%vs the period before");
    expect(tile("profile-visits")).toBe("Profile visits412+23%vs the period before");
    expect(tile("link-clicks")).toBe("Link clicks509+2%vs the period before");
    expect(tile("new-follows")).toBe("New follows138+15%vs the period before");
    expect(tile("replies")).toBe("Replies96−6%vs the period before");
    expect(tile("likes")).toBe("Likes684+7%vs the period before");
    expect(tile("reposts")).toBe("Reposts57+20%vs the period before");
    expect(tile("engagement-rate")).toBe("Engagement rate4.6%+23%vs the period before");
    const rows = screen.getAllByTestId("x-top-post");
    expect(rows.map((r) => r.querySelector("th")?.textContent)).toEqual([
      "First day driving with a rentalBest",
      "Your spare car could pay for itself",
      "What to check before renting",
      "Why gig drivers rent, not buy",
    ]);
    expect(within(rows[0]).getByText("Best")).toBeTruthy();
    expect(rows[0].textContent).toBe("First day driving with a rentalBestLink3,4274.6%");
    expect(rows[0].querySelector("img")).toBeNull();
    expect(rows[2].querySelector("img")?.getAttribute("src")).toBe("https://pbs.twimg.com/b.jpg");
    expect(screen.getByText("History")).toBeTruthy();
  });

  it("says when the last X read failed, and keeps the numbers from the read that worked", () => {
    dash.state = { ...dash.state, data: { ...payload, read: { read: false, error_code: "x_rate_limited" } } };
    render(<XAnalytics active />);
    expect(screen.getByRole("status").textContent).toBe("Zavi could not read your X account just now, so these numbers are from the last read that worked.");
    expect(screen.getByTestId("kpi-tile-impressions").textContent).toContain("19.8K");
  });

  it("shows stale-data context for a revoked token, and says nothing on a skipped read", () => {
    dash.state = { ...dash.state, data: { ...payload, read: { read: false, error_code: "x_token_revoked" } } };
    render(<XAnalytics active />);
    expect(screen.getByRole("status").textContent).toBe("Zavi could not read your X account just now, so these numbers are from the last read that worked.");
    cleanup();
    dash.state = { ...dash.state, data: { ...payload, read: { read: false, reason: "daily_cap" } } };
    render(<XAnalytics active />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("lists the profile checks: to-dos first with their fix, passing ones behind a toggle", () => {
    dash.state = { ...dash.state, data: payload };
    render(<XAnalytics active />);
    const list = within(screen.getByTestId("x-profile-checklist"));
    expect(list.getByText("2 to do · 2 passing")).toBeTruthy();
    expect(list.getByText("2 of 5 checks pass")).toBeTruthy();
    expect(list.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2");
    const rows = () => list.getAllByTestId("x-check").map((r) => [r.dataset.state, r.querySelector("span span")?.textContent]);
    expect(rows()).toEqual([["fail", "Pinned post"], ["fail", "Bio says what you do"], ["unknown", "Posting cadence ≥ 3 / week"]]);
    expect(list.getByRole("link", { name: "Open X to fix: Pinned post" }).getAttribute("href")).toBe("https://x.com/company");
    expect(list.queryByRole("button", { name: /Ask Zavi/ })).toBeNull();
    fireEvent.click(list.getByRole("button", { name: "Show 2 passing checks" }));
    expect(rows().slice(3)).toEqual([["pass", "Profile picture"], ["pass", "Link in bio"]]);
    fireEvent.click(list.getByRole("button", { name: "Hide passing checks" }));
    expect(rows()).toHaveLength(3);
  });

  it("says so when no post in the window has numbers, instead of dropping Top posts", () => {
    dash.state = { ...dash.state, data: { ...payload, top_posts: [post("6", "New post", "text", 0, null)] } };
    render(<XAnalytics active />);
    expect(screen.getByTestId("x-top-posts-empty").textContent).toBe("No post numbers in the last 30 days yet. Posts you publish show up here with their results.");
    expect(screen.queryByTestId("x-top-post")).toBeNull();
  });

  it("draws no checklist when the payload carries none", () => {
    dash.state = { ...dash.state, data: { ...payload, checklist: undefined } };
    render(<XAnalytics active />);
    expect(screen.queryByTestId("x-profile-checklist")).toBeNull();
  });

  it("shows dashes and no change before X has numbers, and says to connect", () => {
    dash.state = { ...dash.state, data: { connected: false, handle: null, window_days: 30, metrics: [metric("impressions", null, null)], top_posts: [] } as unknown as XPayload };
    render(<XAnalytics active />);
    expect(screen.getByTestId("kpi-tile-impressions").textContent).toBe("Impressions–");
    expect(screen.getByRole("status").textContent).toContain("Connect X in Settings");
    expect(screen.queryByTestId("x-top-post")).toBeNull();
    expect(screen.queryByTestId("x-top-posts-empty")).toBeNull();
  });
});
