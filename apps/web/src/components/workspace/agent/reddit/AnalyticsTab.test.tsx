// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RedditAnalyticsTab } from "./AnalyticsTab";
import type { RedditPayload } from "./shared";
import type { RedditInsights } from "./types";
import { CHANNEL_TAB } from "@/lib/workspace/channelTabs";
import { TILE_MIN_PX } from "../../metrics/SummaryRow";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

afterEach(cleanup);

const HOUR = 60 * 60 * 1000;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

function insights(over: Partial<RedditInsights> = {}): RedditInsights {
  return {
    has_data: true,
    sweep: {
      enabled: true,
      last: {
        id: "s1",
        status: "complete",
        trigger: "manual",
        started_at: ago(2),
        finished_at: ago(1),
        posts_scanned: 4200,
        comments_scanned: 900,
        communities_scanned: 10,
        error_code: null,
      },
      budget: { used_usd_7d: 0.4, cap_usd_7d: 3, exhausted: false },
      stale: false,
    },
    threshold: 60,
    today: { posts_scanned: 4200, communities_scanned: 10, posts_relevant: 38 },
    kpis: {
      brand_mentions: { value: 24, previous: 20, brand_terms: 3 },
      reply_opportunities: { value: 18, previous: 20, on_google: { ranked: 2, of: 7 } },
      relevant_posts: { value: 38, previous: null, scanned: 4200 },
      relevant_comments: { value: 12, previous: 0, scanned: 900 },
      subreddits: { value: 10, top: { name: "SaaS", relevance: 94 } },
    },
    communities: [
      {
        name: "SaaS",
        relevance: 94,
        relevance_why: "12 of 25 threads this week were relevant",
        subscribers: 412000,
        posts_per_day: 25,
        posts_per_day_capped: true,
        rules_verdict: "allowed",
        selected: true,
        saved: true,
        recommended: true,
        reply_opportunities: 4,
      },
    ],
    opportunities: [],
    keyword_stats: {},
    competitors: [],
    lists: {
      brand_mentions: [
        {
          thread_id: "t9",
          url: "https://www.reddit.com/r/saas/comments/zz9/",
          subreddit: "saas",
          title: "Anyone tried Acme for churn?",
          author: "devon",
          term: "Acme",
          sentiment: "negative",
          score: 18,
          comment_count: 9,
          observed_at: ago(4),
        },
      ],
      relevant_posts: [],
      relevant_comments: [],
    },
    ...over,
  } as RedditInsights;
}

function payload(over: Partial<RedditPayload> = {}): RedditPayload {
  return {
    connected: false,
    account: { connected: false, handle: null },
    manual_publish: true,
    research_summary: null,
    suggestions: [],
    supporting_steps: [],
    last_run: null,
    workspace: {
      keywords: [
        { id: "k1", term: "Acme", type: "brand", origin: "custom", status: "tracking" },
      ],
      competitors: [],
      communities: [],
    },
    insights: insights(),
    ...over,
  } as RedditPayload;
}

const render360 = (over: Partial<RedditPayload> = {}) =>
  render(<RedditAnalyticsTab data={payload(over)} onChanged={() => {}} />);

describe("the Reddit tab on Analytics", () => {
  it("is registered against the backend's own channel slug", () => {
    expect(CHANNEL_TAB.reddit).toBe("reddit_organic");
  });

  it("shows the scan line and all five numbers", () => {
    render360();
    const scanLine = screen.getByLabelText("Today's scan");
    for (const part of ["Posts read today", "4,200", "Subreddits covered", "10"]) {
      expect(scanLine.textContent).toContain(part);
    }
    const kpis = screen.getByRole("tablist", { name: "Headline numbers" });
    expect(within(kpis).getAllByRole("tab")).toHaveLength(5);
    for (const label of [
      "Brand mentions",
      "Reply opportunities",
      "Relevant posts",
      "Relevant comments",
      "Subreddits saved",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("sizes those numbers by their pane and not by the window", () => {
    render360();
    const kpis = screen.getByRole("tablist", { name: "Headline numbers" });
    expect(kpis.className).not.toMatch(/\b(sm|md|lg|xl|2xl):grid-cols-/);
    expect(kpis.style.gridTemplateColumns).toContain(`max(${TILE_MIN_PX}px`);
    expect(screen.getByLabelText("Today's scan").style.gridTemplateColumns).toContain(
      `max(${TILE_MIN_PX}px`,
    );
  });

  it("opens on the subreddits table and swaps table when another number is picked", () => {
    render360();
    expect(screen.getByRole("tab", { name: /Subreddits saved/ })).toHaveProperty(
      "ariaSelected",
      "true",
    );
    expect(screen.getAllByText("r/SaaS").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("Brand mentions").closest("button")!);
    expect(screen.getByText("Anyone tried Acme for churn?")).toBeTruthy();
  });

  it("carries none of the channel page's action surface", () => {
    render360();
    expect(screen.queryByText("Top comment opportunities")).toBeNull();
    expect(screen.queryByText("Top keywords")).toBeNull();
    expect(screen.queryByText("Competitor activity")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Comment & post strategy" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Keywords & competitors" })).toBeNull();
  });

  it("drops the per-row strategy button, which has nowhere to go from here", () => {
    render360();
    expect(screen.queryByRole("button", { name: /See strategy for/ })).toBeNull();
  });

  it("says so plainly when nothing has been scanned yet", () => {
    render360({ insights: null });
    expect(screen.getByText(/No Reddit scan yet/)).toBeTruthy();
    expect(screen.queryByRole("tablist", { name: "Headline numbers" })).toBeNull();
  });
});
