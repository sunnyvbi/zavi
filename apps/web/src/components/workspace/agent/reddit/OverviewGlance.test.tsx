// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { apiFetch } from "@/lib/api";
import { OverviewGlance } from "./OverviewGlance";
import type { RedditPayload } from "./shared";
import type { RedditInsights } from "./types";
import { submitToReddit } from "./publish";
import { resetRedditPublishStates } from "./useRedditPublish";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-test" }));
vi.mock("@/app/connectors/connectStrategies", () => ({ startRailConnect: vi.fn() }));
vi.mock("./publish", async (importOriginal) => ({ ...(await importOriginal<typeof import("./publish")>()), submitToReddit: vi.fn() }));
const mockFetch = vi.mocked(apiFetch);
const mockPublish = vi.mocked(submitToReddit);
afterEach(() => {
  cleanup();
  mockFetch.mockReset();
  resetRedditPublishStates();
});

const opp = (id: string, title: string, draft: RedditInsights["opportunities"][number]["draft"] = null) => ({
  thread_id: id,
  url: `https://www.reddit.com/r/saas/comments/${id}/`,
  subreddit: "saas",
  title,
  posted_at: null,
  score: 10,
  comment_count: 3,
  post_relevance: 90,
  comment_relevance: 80,
  relevance_why: null,
  matched_terms: [],
  google: { checked: false, rank: null, query: null },
  draft,
});

function payload(over: Partial<RedditPayload> = {}): RedditPayload {
  const insights = {
    has_data: true,
    threshold: 60,
    opportunities: [
      opp("a1", "First thread", null),
      opp("a2", "Second thread", { text: "Reply text", source: "zavi", state: "drafted", decision_id: null }),
      opp("a3", "Third thread", null),
    ],
    keyword_stats: {
      k1: { mentions_7d: 5, mentions_prev_7d: 2, top_subreddit: "saas", matches_today: 1 },
      k2: { mentions_7d: 12, mentions_prev_7d: 0, top_subreddit: "saas", matches_today: 0 },
    },
    competitors: [
      { id: "c1", name: "Turo", domain: null, is_you: false, mentions_7d: 30, mentions_prev_7d: 20, sentiment: { positive: 2, neutral: 1, negative: 1, sample: 4 }, top_subreddits: [], latest_thread: { title: "Turo fees again", url: "https://www.reddit.com/r/turo/comments/x/", subreddit: "turo", posted_at: null } },
      { id: "c2", name: "Getaround", domain: null, is_you: false, mentions_7d: 3, mentions_prev_7d: 3, sentiment: null, top_subreddits: [], latest_thread: null },
    ],
  } as unknown as RedditInsights;
  return {
    connected: false,
    manual_publish: true,
    research_summary: null,
    suggestions: [],
    workspace: {
      keywords: [
        { id: "k1", term: "rent my car", type: "problem", origin: "custom", status: "tracking" },
        { id: "k2", term: "turo alternative", type: "comparison", origin: "suggested", status: "tracking" },
        { id: "k3", term: "p2p insurance", type: "industry", origin: "suggested", status: "suggested" },
      ],
      competitors: [],
      communities: [],
    },
    insights,
    ...over,
  };
}

describe("Top comment opportunities after a scan with nothing above the bar", () => {
  it("still shows the replies a run drafted instead of 'No threads to answer yet'", () => {
    const base = payload();
    const data = {
      ...base,
      insights: { ...base.insights!, opportunities: [] },
      suggestions: [
        {
          id: "r1",
          type: "reddit_reply",
          subreddit: "saas",
          thread_title: "How did you get your first 10 users?",
          thread_url: "https://www.reddit.com/r/saas/comments/zz1/x/",
          body: "What worked for us was answering here.",
          reply_style: "helpful",
          rule_status: "ready",
        },
      ],
    } as unknown as RedditPayload;

    render(<OverviewGlance data={data} onChanged={() => {}} onOpenStrategy={() => {}} onOpenKeywords={() => {}} />);

    const opps = screen.getByRole("region", { name: "Top comment opportunities" });
    expect(within(opps).getByText(/How did you get your first 10 users/)).toBeTruthy();
    expect(within(opps).queryByText(/No threads to answer yet/)).toBeNull();
  });
});

describe("OverviewGlance", () => {
  it("shows the top two opportunities, top keywords by mentions and top competitors", () => {
    render(<OverviewGlance data={payload()} onChanged={() => {}} onOpenStrategy={() => {}} onOpenKeywords={() => {}} />);
    const opps = screen.getByRole("region", { name: "Top comment opportunities" });
    expect(within(opps).getByText("First thread")).toBeTruthy();
    expect(within(opps).getByText("Second thread")).toBeTruthy();
    expect(within(opps).queryByText("Third thread")).toBeNull();
    expect(within(opps).getAllByRole("button", { name: "Draft reply" })).toHaveLength(1);
    expect(within(opps).getByRole("button", { name: "Copy" }).textContent).toBe("");
    expect(within(opps).getByRole("button", { name: "Connect Reddit to post" })).toBeTruthy();
    expect(within(opps).queryByRole("button", { name: "Done" })).toBeNull();
    expect(within(opps).getByRole("link", { name: /Second thread/ })).toHaveProperty("href", "https://www.reddit.com/r/saas/comments/a2/");

    const kws = screen.getByRole("region", { name: "Top keywords" });
    const terms = within(kws).getAllByRole("listitem").map((li) => li.textContent);
    expect(terms[0]).toContain("turo alternative");
    expect(within(kws).getByRole("button", { name: /1 to review/ })).toBeTruthy();

    const comps = screen.getByRole("region", { name: "Competitor activity" });
    expect(within(comps).getAllByRole("listitem")[0].textContent).toContain("Turo");
    expect(within(comps).getByText("Turo fees again")).toBeTruthy();
  });

  it("links to the Strategy and Keywords tabs", () => {
    const onOpenStrategy = vi.fn();
    const onOpenKeywords = vi.fn();
    render(<OverviewGlance data={payload()} onChanged={() => {}} onOpenStrategy={onOpenStrategy} onOpenKeywords={onOpenKeywords} />);
    fireEvent.click(within(screen.getByRole("region", { name: "Top comment opportunities" })).getByRole("button", { name: /See all/ }));
    fireEvent.click(within(screen.getByRole("region", { name: "Top keywords" })).getByRole("button", { name: /to review/ }));
    expect(onOpenStrategy).toHaveBeenCalledTimes(1);
    expect(onOpenKeywords).toHaveBeenCalledTimes(1);
  });

  it("drafts a reply for an opportunity with no draft", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ draft: { text: "x" } }) } as Response);
    const onChanged = vi.fn();
    render(<OverviewGlance data={payload()} onChanged={onChanged} onOpenStrategy={() => {}} onOpenKeywords={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Draft reply" })[0]);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reddit/threads/a1/draft");
  });

  it("Approve & post publishes the reply, then records it as posted", async () => {
    mockPublish.mockReset().mockResolvedValue({ decisionId: "d-new", status: "published" });
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    const onChanged = vi.fn();
    render(
      <OverviewGlance
        data={payload({ account: { connected: true, handle: "founder" } })}
        onChanged={onChanged}
        onOpenStrategy={() => {}}
        onOpenKeywords={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: 3000 });
    expect(mockPublish.mock.calls[0][0].body.link).toBe("https://www.reddit.com/r/saas/comments/a2/");
    const [path, init] = mockFetch.mock.calls[0];
    expect(path).toBe("/api/reddit/threads/a2");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ draft_state: "posted" });
  });

  it("works before the first scan: saved keywords, saved competitors and empty states", () => {
    render(
      <OverviewGlance
        data={payload({
          insights: null,
          workspace: {
            keywords: [{ id: "k1", term: "rent my car", type: "problem", origin: "custom", status: "tracking" }],
            competitors: [{ id: "c9", name: "Zipcar", domain: null, status: "tracking" }],
            communities: [],
          },
        })}
        onChanged={() => {}}
        onOpenStrategy={() => {}}
        onOpenKeywords={() => {}}
      />,
    );
    expect(screen.getByText(/No threads to answer yet/)).toBeTruthy();
    expect(screen.getByText("rent my car")).toBeTruthy();
    expect(screen.getByText("Zipcar")).toBeTruthy();
    expect(screen.getByText("not scanned yet")).toBeTruthy();
  });
});
