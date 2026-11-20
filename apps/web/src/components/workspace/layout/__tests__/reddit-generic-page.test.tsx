// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import type { RedditPayload } from "../../agent/reddit/shared";
import { ChannelDrawer, type ChannelDetail } from "../ChannelDrawer";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div data-testid="schedule-view" /> }));
vi.mock("../../agent/XAgentDashboard", () => ({ XAgentDashboard: () => <div /> }));
vi.mock("../../agent/RedditOrganicDashboard", () => ({
  RedditOrganicDashboard: () => <div>LEGACY REDDIT DASHBOARD</div>,
}));

const reddit = (CHANNELS as readonly Channel[]).find((c) => c.slug === "reddit_organic")!;

function payload(): RedditPayload {
  const metric = { value: 3, previous: 1 };
  return {
    connected: true,
    manual_publish: true,
    research_summary: null,
    suggestions: [],
    workspace: {
      keywords: [{ id: "k1", term: "upcar", type: "brand", origin: "custom", status: "tracking" }],
      competitors: [],
      communities: [],
    },
    insights: {
      has_data: true,
      sweep: {
        enabled: true,
        last: {
          id: "s1",
          status: "complete",
          trigger: "manual",
          started_at: "2026-09-19T00:00:00.000Z",
          finished_at: "2026-09-19T00:05:00.000Z",
          posts_scanned: 40,
          comments_scanned: 90,
          communities_scanned: 4,
          error_code: null,
        },
        budget: { used_usd_7d: 1, cap_usd_7d: 10, exhausted: false },
        stale: false,
      },
      threshold: 60,
      today: { posts_scanned: 40, communities_scanned: 4, posts_relevant: 3 },
      kpis: {
        brand_mentions: { ...metric, brand_terms: 1 },
        reply_opportunities: { ...metric, on_google: null },
        relevant_posts: { ...metric, scanned: 40 },
        relevant_comments: { ...metric, scanned: 90 },
        subreddits: { value: 2, top: { name: "r/cars", relevance: 80 } },
      },
      communities: [
        {
          name: "r/cars",
          relevance: 80,
          relevance_why: "buyers ask about rentals here",
          subscribers: 1200,
          posts_per_day: 5,
          posts_per_day_capped: false,
          rules_verdict: "allowed",
          selected: true,
          saved: true,
          recommended: true,
          reply_opportunities: 2,
        },
      ],
      opportunities: [
        {
          thread_id: "t1",
          url: "https://www.reddit.com/r/cars/comments/t1/x",
          subreddit: "r/cars",
          title: "Which car should I rent for a week",
          posted_at: "2026-09-19T00:00:00.000Z",
          score: 12,
          comment_count: 4,
          post_relevance: 80,
          comment_relevance: null,
          relevance_why: null,
          matched_terms: ["rent"],
          google: { checked: false, rank: null, query: null },
          draft: null,
        },
      ],
      keyword_stats: {},
      competitors: [],
      lists: {
        brand_mentions: [
          {
            thread_id: "m1",
            url: "https://www.reddit.com/r/cars/comments/m1/x",
            subreddit: "r/cars",
            title: "Anyone used Upcar",
            author: "someone",
            term: "upcar",
            sentiment: "positive",
            score: 9,
            comment_count: 2,
            observed_at: "2026-09-19T00:00:00.000Z",
          },
        ],
        relevant_posts: [
          {
            thread_id: "p1",
            url: "https://www.reddit.com/r/cars/comments/p1/x",
            subreddit: "r/cars",
            title: "Best way to rent a car in LA",
            posted_at: "2026-09-19T00:00:00.000Z",
            relevance: 75,
            matched_terms: ["rent"],
            score: 5,
            comment_count: 1,
          },
        ],
        relevant_comments: [
          {
            comment_id: "c1",
            thread_id: "p1",
            url: "https://www.reddit.com/r/cars/comments/p1/x/c1",
            subreddit: "r/cars",
            thread_title: "Best way to rent a car in LA",
            author: "someone",
            excerpt: "I rented through a neighbour and it was cheaper",
            relevance: 70,
            matched_terms: ["rent"],
            score: 3,
          },
        ],
      },
      share_of_voice: { window_days: 7, total_mentions: 3, items: [] },
    },
  };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const NO_HISTORY = { runs: [], closed: [], pre_switch: [] };

function route(d: RedditPayload | null = payload()) {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/channels/reddit_organic/actions")) {
      return ok({ actions: [], more: 0, store: "channel_actions" });
    }
    if (u.includes("/api/channels/reddit_organic/metrics")) return ok({ metrics: [] });
    if (u.includes("/api/channels/reddit_organic/history")) return ok(NO_HISTORY);
    if (u.includes("/api/agents/reddit_organic/dashboard")) {
      return d ? ok(d) : { ok: false, status: 500, json: async () => ({}) };
    }
    return ok({ snapshots: [], artifacts: [], briefs: [] });
  });
}

const detail = (over: Partial<ChannelDetail> = {}): ChannelDetail => ({
  channel: reddit,
  mode: "produce",
  connected: true,
  connectors: [],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
  ...over,
});

async function open(d: Partial<ChannelDetail> = {}) {
  const r = render(
    <ChannelDrawer
      detail={detail(d)}
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

beforeEach(() => apiFetch.mockReset());
afterEach(cleanup);

async function analytics() {
  fireEvent.click(screen.getByRole("tab", { name: "Analytics" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("reddit_organic renders through the generic channel page", () => {
  it("does not mount the dashboard it replaced", async () => {
    route();
    await open();
    expect(screen.queryByText("LEGACY REDDIT DASHBOARD")).toBeNull();
  });

  it("the drawer no longer imports the dashboard at all", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/workspace/layout/ChannelDrawer.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+"\.\.\/agent\/RedditOrganicDashboard"/);
    expect(src).not.toMatch(/"reddit_organic"/);
  });

  it("titles the page with the channel's name", async () => {
    route();
    await open();
    const title = screen.getByRole("dialog").querySelector("h2")!;
    expect(title.textContent).toBe(reddit.name);
    expect(title.textContent).not.toBe("Reddit Agent");
  });

  it("offers Reddit's five tables as five headline numbers, not as a stack", async () => {
    route();
    await open();
    await analytics();
    const tabs = within(screen.getByTestId("summary-row")).getAllByRole("tab");
    expect(tabs.length).toBe(5);
    expect(tabs.map((t) => t.textContent ?? "")).toEqual([
      expect.stringContaining("Brand mentions"),
      expect.stringContaining("Reply opportunities"),
      expect.stringContaining("Relevant posts"),
      expect.stringContaining("Relevant comments"),
      expect.stringContaining("Subreddits saved"),
    ]);
    expect(screen.queryByTestId("metrics-empty")).toBeNull();

    const tables = screen.getAllByTestId("extra-table");
    expect(tables.length).toBe(1);
    expect(tables[0].textContent).toContain("Brand mentions");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");

    const panel = screen.getByRole("tabpanel", { name: /Details for the selected number/i });
    expect(tabs[0].getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.textContent).toContain("Brand mentions");
  });

  it("swaps the table when another number is picked, still one at a time", async () => {
    route();
    await open();
    await analytics();
    fireEvent.click(screen.getByRole("tab", { name: /Relevant subreddits|Subreddits saved/i }));

    await waitFor(() => {
      const tables = screen.getAllByTestId("extra-table");
      expect(tables.length).toBe(1);
      expect(tables[0].textContent).toContain("Relevant subreddits");
    });
    expect(screen.queryByText(/Brand mentions · last 7 days/)).toBeNull();
  });

  it("reads the numbers from the dashboard payload, not from the metrics endpoint", async () => {
    route();
    await open();
    const card = document.querySelector('[data-metric="brand_mentions"]');
    expect(card?.textContent).toContain("3");
    expect(document.querySelector('[data-testid="delta-brand_mentions"]')?.textContent).toContain("200%");
    expect(document.querySelector('[data-testid="delta-subreddits"]')).toBeNull();
  });
});
