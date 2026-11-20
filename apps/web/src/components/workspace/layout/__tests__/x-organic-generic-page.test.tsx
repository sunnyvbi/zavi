// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import type { XPayload } from "../../agent/XAgentDashboard";
import { makeAction } from "../../actions/__tests__/fixtures";
import { ChannelDrawer, type ChannelDetail } from "../ChannelDrawer";
import { __resetAgentDashCache } from "../../agent/dashboard-ui";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div data-testid="schedule-view" /> }));
vi.mock("../../agent/RedditOrganicDashboard", () => ({ RedditOrganicDashboard: () => <div /> }));
vi.mock("../../agent/XAgentDashboard", async () => {
  const actual = await vi.importActual<typeof import("../../agent/XAgentDashboard")>(
    "../../agent/XAgentDashboard",
  );
  return { ...actual, XAgentDashboard: () => <div>LEGACY X PANEL</div> };
});

const x = (CHANNELS as readonly Channel[]).find((c) => c.slug === "x_organic")!;
const SLUG = "x_organic";

function payload(over: Partial<XPayload> = {}): XPayload {
  return {
    generic: false,
    connected: true,
    handle: "@example",
    account_name: "Example",
    account_handle: "example",
    account_read_at: "2026-09-20T10:00:00Z",
    window_days: 7,
    period: { from: "2026-09-13", to: "2026-09-20" },
    ranges: [{ id: "7d", label: "Last 7 days", days: 7 }],
    read_budget: { used: 1, cap: 2, remaining: 1 },
    read: { read: true },
    metrics: [
      { key: "impressions", label: "Impressions", value: 4200, unit: "count", delta: 12, delta_unit: "pct", basis: "period" },
      { key: "engagement_rate", label: "Engagement rate", value: 2.4, unit: "pct", delta: null, delta_unit: "pp", basis: "period" },
    ],
    attention: [
      { key: "bio", title: "Your bio does not say what you do", detail: "One line, in your own words.", mode: "manual", status: "open", effort: "2 min", decision_id: null, link: "https://x.com/settings/profile", blocking: false },
      { key: "step:abc", title: "Approve the Tuesday post", detail: "Waiting on you.", mode: "approval", status: "open", effort: "1 min", decision_id: "abc", link: null, blocking: false },
    ],
    drafts: [],
    top_posts: [
      { id: "p1", external_post_id: "1", url: "https://x.com/example/status/1", text: "The post that worked", format: "single", posted_at: "2026-09-18T00:00:00Z", source: "zavi", status: "posted", thumb_url: null, media_type: null, views: 9100, likes: 84, replies: 12, reposts: 7, bookmarks: 3, link_clicks: 40, profile_clicks: 11, engagements: 120, eng_rate: 1.3, private_metrics_available: true },
    ],
    checklist: {
      passed: 1,
      total: 2,
      signals: [
        { key: "avatar", label: "Profile photo", status: "pass", note: "Set.", link: null },
        { key: "pinned", label: "Pinned post", status: "fix", note: "Nothing pinned.", link: "https://x.com/example" },
      ],
    },
    snapshot_days: 30,
    ...over,
  } as XPayload;
}

const RANKED: ChannelActionView[] = [
  makeAction("text_post", { channel_slug: SLUG, title: "RANKED — the draft the ranker put first" }),
];

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const NO_HISTORY = { runs: [], closed: [], pre_switch: [] };

function route(d: XPayload | null = payload()) {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes(`/api/channels/${SLUG}/actions`)) return ok({ actions: RANKED, more: 0, store: "channel_actions" });
    if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
    if (u.includes(`/api/channels/${SLUG}/history`)) return ok(NO_HISTORY);
    if (u.includes(`/api/agents/${SLUG}/dashboard`)) {
      return d ? ok(d) : { ok: false, status: 500, json: async () => ({}) };
    }
    return ok({ snapshots: [], artifacts: [], briefs: [] });
  });
}

const detail = (over: Partial<ChannelDetail> = {}): ChannelDetail => ({
  channel: x,
  mode: "produce",
  connected: true,
  connectors: ["x"],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
  ...over,
});

async function open(over: Partial<ChannelDetail> = {}) {
  const r = render(
    <ChannelDrawer
      detail={detail(over)}
      actionCount={0}
      error={null}
      onClose={() => {}}
      onOpenConnectors={() => {}}
    />,
  );
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((r2) => setTimeout(r2, 0));
    }
  });
  return r;
}

beforeEach(() => {
  apiFetch.mockReset();
  __resetAgentDashCache();
});
afterEach(cleanup);

async function analytics() {
  fireEvent.click(screen.getByRole("tab", { name: "Analytics" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("x_organic renders through the generic channel page", () => {
  it("does not mount the panel it replaced", async () => {
    route();
    await open();
    expect(screen.queryByText("LEGACY X PANEL")).toBeNull();
  });

  it("the drawer no longer imports it, or reads the slug at all", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/workspace/layout/ChannelDrawer.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/import\s+\{\s*XAgentDashboard/);
    expect(src).not.toMatch(/channel\.slug\s*===\s*"x_organic"/);
  });

  it("paints the ranked draft, not the payload's own draft list", async () => {
    route();
    await open();
    const section = screen.getByTestId("action-section");
    const headings = within(section).getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(headings).toContain("RANKED — the draft the ranker put first");
  });

  it("draws no table on Overview: the profile checklist lives on Analytics", async () => {
    route();
    const view = await open();
    expect(screen.queryAllByTestId("extra-table")).toEqual([]);
    expect(view.container.textContent).toContain("Your bio does not say what you do");
  });

  it("never draws an approval row as a table row", async () => {
    route();
    const view = await open();
    expect(view.container.textContent).not.toContain("Approve the Tuesday post");
  });

  it("draws one date picker and one Refresh on the Analytics tab", async () => {
    route();
    await open();
    await analytics();
    expect(await screen.findByTestId("x-analytics")).toBeTruthy();
    expect(screen.getAllByTestId("channel-refresh")).toHaveLength(1);
  });

  it("shows the verified publishing account and its read allowance", async () => {
    route();
    const view = await open();
    await analytics();
    expect(screen.getByTestId("publishing-account").textContent).toContain("@example");
    expect(view.container.textContent).toContain("Last account read");
    expect(view.container.textContent).toContain("1 of 2 reads left today");
    expect(view.container.textContent).not.toMatch(/could not read your X account/i);
  });

  it("draws the eight numbers from the payload, with no metrics rows in the table", async () => {
    route();
    await open();
    await analytics();
    expect(screen.queryByTestId("metrics-empty")).toBeNull();
    expect(document.querySelector('[data-metric="impressions"]')?.textContent).toContain("4,200");
  });

  it("hands the card a real Post, from the row's own publish", async () => {
    route();
    await open();
    const section = screen.getByTestId("action-section");
    const post = within(section).getByRole("button", { name: "Post on X" });
    expect(post).toBeTruthy();
    expect(post.getAttribute("title")).toBeNull();
  });

  it("gives an UNCONNECTED account the composer handoff, not a Post that cannot post", async () => {
    route(payload({ connected: false }));
    await open({ connected: false });
    const section = screen.getByTestId("action-section");
    const post = within(section).getByRole("link", { name: /^Open draft/ });
    expect(post.getAttribute("href") ?? "").toMatch(/^https:\/\/x\.com\/intent\/tweet\?text=/);
    expect(within(section).queryByRole("button", { name: /^Post$/ })).toBeNull();
  });

  it("falls back to the empty-metrics sentence when the dashboard read fails", async () => {
    route(null);
    await open();
    expect(screen.getByTestId("channel-value-empty")).toBeTruthy();
    expect(screen.queryAllByTestId("extra-table")).toHaveLength(0);
    expect(screen.getByTestId("action-section")).toBeTruthy();
  });
});

it("does not call a disconnected cached profile the publishing account", async () => {
  route(payload({ connected: false }));
  await open({ connected: false, connectors: ["x_social"] });
  expect(screen.queryByTestId("publishing-account")).toBeNull();
  expect(screen.getByTestId("connect-primary")).toBeTruthy();
});
