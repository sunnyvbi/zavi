// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";

const h = vi.hoisted(() => ({ data: null as unknown, loading: false, error: null as string | null }));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })) }));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("../agent/dashboard-ui", async (orig) => ({
  ...(await orig<typeof import("../agent/dashboard-ui")>()),
  useAgentDashboard: () => ({ data: h.data, cachedAt: null, loading: h.loading, refreshing: false, error: h.error, refresh: () => {}, refreshSilent: () => {} }),
}));
import { ChannelMetricsRow } from "./ChannelMetricsRow";
import { platformFor } from "./platforms";

const metric = (key: string, value: number): ChannelMetric => ({ key, value, unit: key === "engagement_rate" ? "pct" : null, window_kind: null, day: "2026-11-18", grounded: true, prev_value: null, prev_day: null });
const sets = [
  { slug: "instagram_organic", keys: ["followers", "total_posts", "views", "reach", "engagement_rate", "likes", "comments", "saves"] },
  { slug: "tiktok_organic", keys: ["followers", "total_posts", "views", "engagement_rate", "likes", "comments", "shares"] },
];
beforeEach(() => { h.data = null; h.loading = false; h.error = null; });
afterEach(cleanup);

for (const { slug, keys } of sets) describe(slug + " account dashboard", () => {
  const row = (metrics: ChannelMetric[] = []) => <ChannelMetricsRow slug={slug} metrics={metrics} platform={platformFor(slug)} loading={false} connected hasConnectors />;
  const drawnKeys = (container: HTMLElement) => Array.from(container.querySelectorAll("[data-metric]"), (el) => el.getAttribute("data-metric"));
  const payload = (metrics: ChannelMetric[], extra = {}) => ({ connected: true, metrics, top_posts: [], ...extra });

  it("keeps every declared tile when the account read only supplies followers", () => {
    h.data = payload([metric("followers", 120)]);
    const { container } = render(row());
    expect(drawnKeys(container)).toEqual(keys);
    expect(screen.getByTestId("value-followers").textContent).toBe("120");
    for (const key of keys.slice(1)) {
      expect(screen.getByTestId(`value-${key}`).textContent).toBe("–");
      expect(screen.getByTestId(`kpi-${key}`).textContent).toContain("Not available from the latest account read.");
    }
  });

  it("uses the account read instead of a partial or stale agent-saved metric list", () => {
    h.data = payload(keys.map((key, i) => metric(key, i + 10)));
    const { container } = render(row([metric("followers", 9999), metric("revenue", 500)]));
    expect(drawnKeys(container)).toEqual(keys);
    expect(screen.getByTestId("value-followers").textContent).toBe("10");
    expect(screen.getByTestId("value-views").textContent).toBe("12");
    expect(container.textContent).not.toContain("9,999");
  });

  it("does not fill absent account readings with an old agent value", () => {
    h.data = payload([]);
    const { container } = render(row([metric("followers", 9999)]));
    expect(drawnKeys(container)).toEqual(keys);
    expect(screen.getByTestId("value-followers").textContent).toBe("–");
  });

  it("preserves real zeroes, rate units and follower comparisons", () => {
    h.data = payload(keys.map(key => key === "followers" ? { ...metric(key, 110), prev_value: 100, prev_day: "2026-11-17" } : metric(key, key === "engagement_rate" ? 2.5 : 0)));
    const { container } = render(row());
    expect(drawnKeys(container)).toEqual(keys);
    expect(screen.getByTestId("value-likes").textContent).toBe("0");
    expect(screen.getByTestId("value-engagement_rate").textContent).toContain("2.5");
    expect(screen.getByTestId("value-engagement_rate").textContent).toContain("%");
    expect(screen.getByTestId("delta-followers").textContent).toContain("10%");
  });

  it("keeps the read-problem banner and missing slots on a partial read failure", () => {
    h.data = payload([metric("followers", 12)], { problem: "Could not read the latest post counts." });
    const { container } = render(row());
    expect(drawnKeys(container)).toEqual(keys);
    expect(screen.getByText("Could not read the latest post counts.")).toBeTruthy();
  });

  it("keeps the same tile order as missing readings arrive", () => {
    h.data = payload([metric("followers", 12)]);
    const view = render(row());
    expect(drawnKeys(view.container)).toEqual(keys);
    h.data = payload([...keys].reverse().map(key => metric(key, 5)));
    view.rerender(row());
    expect(drawnKeys(view.container)).toEqual(keys);
    expect(screen.getByTestId("value-views").textContent).toBe("5");
  });

  it("keeps all slots for an unconnected account, without claiming measured zeroes", () => {
    h.data = payload([], { connected: false });
    const { container } = render(row());
    expect(drawnKeys(container)).toEqual(keys);
    for (const key of keys) expect(screen.getByTestId(`value-${key}`).textContent).toBe("–");
    expect(container.textContent).not.toContain("latest account read");
  });

  it("does not expose previous-window values while the next window loads", () => {
    h.data = payload([metric("followers", 120)]);
    const view = render(row());
    h.loading = true;
    view.rerender(row());
    expect(screen.queryByTestId("value-followers")).toBeNull();
    expect(view.container.textContent).not.toContain("120");
  });

  it("does not use an agent value when the dashboard request fails", () => {
    h.error = "Request failed";
    const { container } = render(row([metric("followers", 9999)]));
    expect(drawnKeys(container)).toEqual(keys);
    expect(screen.getByTestId("value-followers").textContent).toBe("–");
    expect(screen.getByTestId("kpi-followers").textContent).toContain("Account data is unavailable. Try Refresh.");
  });
});
