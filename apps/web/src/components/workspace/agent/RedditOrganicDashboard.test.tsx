// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { apiFetch } from "@/lib/api";
import { RedditOrganicBody, type RedditPayload } from "./RedditOrganicDashboard";
import type { RedditInsights } from "./reddit/types";
import { submitToReddit } from "./reddit/publish";
import { resetRedditPublishStates } from "./reddit/useRedditPublish";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-test" }));
vi.mock("@/app/connectors/connectStrategies", () => ({ startRailConnect: vi.fn() }));
vi.mock("./reddit/publish", async (importOriginal) => ({ ...(await importOriginal<typeof import("./reddit/publish")>()), submitToReddit: vi.fn() }));
const mockSubmit = vi.mocked(submitToReddit);
vi.mock("./dashboard-ui", () => ({
  ago: () => "2h ago",
  Pill: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  DashboardShell: () => null,
  EmptyState: () => null,
  useAgentDashboard: () => ({}),
}));

const mockFetch = vi.mocked(apiFetch);

function payload(over: Partial<RedditPayload> = {}): RedditPayload {
  return {
    connected: false,
    account: { connected: false, handle: null },
    manual_publish: true,
    research_summary: null,
    suggestions: [
      {
        id: "r1",
        type: "reddit_reply",
        subreddit: "smallbusiness",
        thread_title: "Best way to rent out my car?",
        thread_url: "https://www.reddit.com/r/smallbusiness/comments/abc/x/",
        body: "Track cleaning and fuel per trip from day one.",
        reply_style: "Existing Q&A answer",
        rule_status: "verify_manually",
      },
    ],
    supporting_steps: [],
    last_run: null,
    workspace: {
      keywords: [{ id: "k1", term: "rent out my car", type: "problem", origin: "custom", status: "tracking" }],
      competitors: [],
      communities: [],
    },
    overview: {
      kpis: {
        reply_opportunities: 1,
        post_opportunities: 0,
        communities: 1,
        tracked_keywords: 1,
        tracked_competitors: 0,
      },
      top_communities: [
        { name: "smallbusiness", reply_opportunities: 1, post_opportunities: 0, saved: false, selected: false, rules_verdict: null },
      ],
      unavailable: [
        { metric: "mentions", reason: "Not collected yet." },
        { metric: "share_of_voice", reason: "Needs a counted sample." },
        { metric: "google_rank", reason: "No rank source." },
        { metric: "impressions", reason: "Reddit reports views only to the poster." },
      ],
    },
    ...over,
  };
}

const HOUR = 60 * 60 * 1000;

function opportunity(over: Partial<RedditInsights["opportunities"][number]>): RedditInsights["opportunities"][number] {
  return {
    thread_id: "t1",
    url: "https://www.reddit.com/r/SaaS/comments/t1/x/",
    subreddit: "SaaS",
    title: "What tool do you use for churn?",
    posted_at: new Date(Date.now() - 6 * HOUR).toISOString(),
    score: 412,
    comment_count: 186,
    post_relevance: 96,
    comment_relevance: 91,
    relevance_why: null,
    matched_terms: ["churn tool"],
    google: { checked: true, rank: 4, query: "churn tool" },
    draft: { text: "We track churn weekly and it changed how we price.", source: "run", state: "proposed", decision_id: "d1" },
    ...over,
  };
}

function insights(over: Partial<RedditInsights> = {}): RedditInsights {
  return {
    has_data: true,
    sweep: {
      enabled: true,
      last: {
        id: "s1",
        status: "complete",
        trigger: "manual",
        started_at: new Date(Date.now() - 2 * HOUR).toISOString(),
        finished_at: new Date(Date.now() - HOUR).toISOString(),
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
      {
        name: "smallbusiness",
        relevance: 55,
        relevance_why: null,
        subscribers: null,
        posts_per_day: null,
        posts_per_day_capped: false,
        rules_verdict: null,
        selected: false,
        saved: false,
        recommended: false,
        reply_opportunities: 1,
      },
    ],
    opportunities: [
      opportunity({}),
      opportunity({
        thread_id: "t2",
        url: "https://www.reddit.com/r/smallbusiness/comments/t2/y/",
        subreddit: "smallbusiness",
        title: "Anyone rent out their car on weekends?",
        comment_relevance: null,
        google: { checked: false, rank: null, query: null },
        draft: null,
      }),
    ],
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
          observed_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
        },
      ],
      relevant_posts: [
        {
          thread_id: "t1",
          url: "https://www.reddit.com/r/saas/comments/aa1/",
          subreddit: "saas",
          title: "How do you track churn?",
          posted_at: null,
          relevance: 92,
          matched_terms: ["churn tool"],
          score: 40,
          comment_count: 12,
        },
      ],
      relevant_comments: [
        {
          comment_id: "c1",
          thread_id: "t1",
          url: "https://www.reddit.com/r/saas/comments/aa1/",
          subreddit: "saas",
          thread_title: "How do you track churn?",
          author: "ann",
          excerpt: "We need a better churn tool for a two-person team",
          relevance: 88,
          matched_terms: ["churn tool"],
          score: 5,
        },
      ],
    },
    share_of_voice: { window_days: 7, total_mentions: 0, items: [] },
    ...over,
  };
}

beforeEach(() => {
  resetRedditPublishStates();
  mockSubmit.mockReset();
  mockFetch.mockReset();
});
afterEach(() => cleanup());

describe("RedditOrganicBody", () => {
  const tabName = (t: HTMLElement) => t.textContent?.replace(/\d+$/, "");

  it("renders the three tabs, opens on Overview and has no header of its own", () => {
    render(<RedditOrganicBody data={payload()} onChanged={() => {}} />);
    expect(screen.getAllByRole("tab").map(tabName)).toEqual([
      "Overview",
      "Comment & post strategy",
      "Keywords & competitors",
    ]);
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("heading", { name: /Reddit agent/i })).toBeNull();
    expect(screen.queryByText(/No account connected/)).toBeNull();
  });

  it("badges the strategy tab with the opportunity count, capped at five", () => {
    const many = Array.from({ length: 7 }, (_, i) => opportunity({ thread_id: `t${i}` }));
    render(<RedditOrganicBody data={payload({ insights: insights({ opportunities: many }) })} onChanged={() => {}} />);
    expect(screen.getByRole("tab", { name: "Comment & post strategy" }).textContent).toBe("Comment & post strategy5");
  });

  it("falls back to the run's reply drafts for the badge and shows none at zero", () => {
    render(<RedditOrganicBody data={payload()} onChanged={() => {}} />);
    expect(screen.getByRole("tab", { name: "Comment & post strategy" }).textContent).toBe("Comment & post strategy1");
    cleanup();
    render(
      <RedditOrganicBody
        data={payload({ insights: insights({ opportunities: [] }), suggestions: [] })}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByRole("tab", { name: "Comment & post strategy" }).textContent).toBe("Comment & post strategy");
  });

  it("drops the opportunities preview and the not-available block from the Overview", () => {
    render(<RedditOrganicBody data={payload({ insights: insights() })} onChanged={() => {}} />);
    expect(screen.queryByText(/Today's top comment opportunities/)).toBeNull();
    expect(screen.queryByText(/Not available/)).toBeNull();
    expect(screen.queryByText(/Impressions/i)).toBeNull();
    expect(screen.queryByLabelText("Add a subreddit")).toBeNull();
  });

  it("saves a rules verdict for an unsaved community in one request", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: "c1", name: "smallbusiness" }) } as Response);
    const onChanged = vi.fn();
    render(<RedditOrganicBody data={payload()} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText("What the rules of r/smallbusiness say"), {
      target: { value: "banned" },
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reddit/workspace/communities");
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({
      name: "smallbusiness",
      rules_verdict: "banned",
      selected: false,
    });
  });

  it("refreshes after a 409 so the already-saved community appears", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({}) } as Response);
    const onChanged = vi.fn();
    render(<RedditOrganicBody data={payload()} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText("What the rules of r/smallbusiness say"), {
      target: { value: "allowed" },
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByText("Already saved.")).toBeTruthy();
  });

  it("shows the scan line, one row of five KPIs and the top subreddits table from insights", () => {
    render(<RedditOrganicBody data={payload({ insights: insights() })} onChanged={() => {}} />);
    const scanLine = screen.getByLabelText("Today's scan");
    for (const part of ["Posts read today", "4,200", "Subreddits covered", "10", "Worth replying to", "38"]) {
      expect(scanLine.textContent).toContain(part);
    }
    expect(screen.getByRole("img", { name: "Scanned in the last 24 hours" })).toBeTruthy();

    const kpis = screen.getByRole("tablist", { name: "Headline numbers" });
    expect(kpis.className).not.toMatch(/\b(sm|md|lg|xl|2xl):grid-cols-/);
    expect(kpis.style.gridTemplateColumns).toBe(
      "repeat(auto-fill, minmax(max(132px, calc((100% - 56px) / 5)), 1fr))",
    );
    expect(kpis.querySelectorAll(':scope > :not([aria-hidden="true"])')).toHaveLength(5);
    expect(kpis.querySelectorAll(':scope > [role="tab"]')).toHaveLength(5);
    const card = (label: string) => screen.getByText(label).closest("button")!;
    expect(card("Brand mentions").textContent).toContain("Up20%");
    expect(card("Reply opportunities").textContent).toContain("Down10%");
    expect(card("Relevant posts").textContent).not.toMatch(/Up|Down/);
    expect(card("Relevant comments").textContent).not.toMatch(/Up|Down/);
    expect(card("Brand mentions").textContent).toBe("Brand mentions24↑Up20%");
    expect(screen.queryByText("3 brand terms · last 7 days")).toBeNull();
    expect(screen.queryByText("Score 60+ of 4,200 scanned today")).toBeNull();
    expect(card("Subreddits saved").getAttribute("aria-selected")).toBe("true");
    expect(card("Subreddits saved").className).not.toMatch(/(^| )ring-1( |$)/);
    expect(card("Subreddits saved").className).not.toContain("border-2");
    const kpiIndicator = within(kpis).getByTestId("sliding-indicator");
    expect(kpiIndicator.className).toMatch(/(^| )border-ink( |$)/);
    expect(kpiIndicator.className).not.toContain("border-2");

    expect(screen.getByRole("heading", { name: "Relevant subreddits" })).toBeTruthy();
    expect(
      screen.getByText("Relevance out of 100: how closely each community's conversations match your business."),
    ).toBeTruthy();
    const table = screen.getByRole("table");
    expect(table.className).not.toMatch(/min-w-/);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["#", "Subreddit", "Relevance", "Members", "Posts / day", "Self-promo", "Actions"]);
    const [saas, small] = screen.getAllByRole("row").slice(1);
    expect(saas.textContent).toContain("Recommended");
    expect(saas.textContent).toContain("12 of 25 threads this week were relevant");
    expect(saas.textContent).toContain("412K");
    expect(saas.textContent).toContain("25+");
    expect(saas.textContent).toContain("High");
    expect((screen.getByLabelText(/Self-promo in r\/SaaS/) as HTMLSelectElement).value).toBe("allowed");
    expect(small.textContent).toContain("Medium");
    expect(small.textContent).toContain("-");
    expect(small.textContent).not.toContain("Recommended");
    const smallSelect = screen.getByLabelText(/Self-promo in r\/smallbusiness/) as HTMLSelectElement;
    expect(smallSelect.value).toBe("");
    expect(smallSelect.selectedOptions[0].textContent).toBe("Check rules");
    expect(screen.queryByRole("button", { name: /Expand|Edit rules/i })).toBeNull();
  });

  it("hides low-relevance subreddits behind a toggle", () => {
    const base = insights();
    const low = { ...base.communities[1], name: "coffeeph", relevance: 3, relevance_why: null };
    render(<RedditOrganicBody data={payload({ insights: insights({ communities: [...base.communities, low] }) })} onChanged={() => {}} />);
    expect(screen.queryByText("r/coffeeph")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("r/coffeeph")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByText("r/coffeeph")).toBeNull();
  });

  it("does not offer to post a brand-mention reply again after hiding and reopening it", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ draft: { text: "x" } }) } as Response);
    mockSubmit.mockResolvedValue({ decisionId: "d-1", status: "published" });
    render(
      <RedditOrganicBody
        data={payload({ insights: insights(), account: { connected: true, handle: "founder" } })}
        onChanged={() => {}}
      />,
    );
    fireEvent.click(within(screen.getByRole("tablist", { name: "Headline numbers" })).getByRole("tab", { name: /Brand mentions/ }));
    const region = () => screen.getByRole("region", { name: "Brand mentions · last 7 days" });
    fireEvent.click(within(region()).getByRole("button", { name: "Draft reply" }));
    fireEvent.click(await within(region()).findByRole("button", { name: "Approve & post" }));
    expect(await within(region()).findByText("Posted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Show draft" }));
    expect(within(region()).getByText("Posted")).toBeTruthy();
    expect(within(region()).queryByRole("button", { name: "Approve & post" })).toBeNull();
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it("swaps the table under the KPI row when a card is clicked", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ draft: { text: "x" } }) } as Response);
    const onChanged = vi.fn();
    render(<RedditOrganicBody data={payload({ insights: insights() })} onChanged={onChanged} />);
    const cards = screen.getByRole("tablist", { name: "Headline numbers" });
    expect(within(cards).getByRole("tab", { name: /Subreddits saved/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Relevant subreddits" })).toBeTruthy();

    fireEvent.click(within(cards).getByRole("tab", { name: /Brand mentions/ }));
    expect(screen.getByRole("heading", { name: "Brand mentions · last 7 days" })).toBeTruthy();
    expect(screen.getByText("Anyone tried Acme for churn?")).toBeTruthy();
    expect(screen.getByText("Negative")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Relevant subreddits" })).toBeNull();
    fireEvent.click(
      within(screen.getByRole("region", { name: "Brand mentions · last 7 days" })).getByRole("button", { name: "Draft reply" }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mockFetch.mock.calls.at(-1)?.[0]).toBe("/api/reddit/threads/t9/draft");
    expect(await screen.findByText("x")).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Brand mentions · last 7 days" })).getByRole("button", { name: "Connect Reddit to post" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide draft" }));
    expect(screen.queryByText("x")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show draft" }));
    expect(screen.getByText("x")).toBeTruthy();

    fireEvent.click(within(cards).getByRole("tab", { name: /Reply opportunities/ }));
    expect(screen.getByRole("heading", { name: "Reply opportunities · last 7 days" })).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Reply opportunities · last 7 days" })).getByText("In approval queue"),
    ).toBeTruthy();

    fireEvent.click(within(cards).getByRole("tab", { name: /Relevant posts/ }));
    expect(screen.getByRole("heading", { name: "Relevant posts · today" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open post" })).toBeNull();
    expect(screen.getByRole("link", { name: /How do you track churn\?/ }).getAttribute("href")).toBe(
      "https://www.reddit.com/r/saas/comments/aa1/",
    );
    expect(screen.getByText("r/saas · 12 comments")).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Comments" })).toBeNull();

    fireEvent.click(within(cards).getByRole("tab", { name: /Relevant comments/ }));
    expect(screen.getByRole("heading", { name: "Relevant comments · today" })).toBeTruthy();
    expect(screen.getByText(/We need a better churn tool/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /We need a better churn tool/ }).getAttribute("href")).toBe(
      "https://www.reddit.com/r/saas/comments/aa1/",
    );
    expect(screen.getByText("u/ann · r/saas · 5 upvotes · How do you track churn?")).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Comment",
      "Relevance",
      "Reply",
    ]);
    expect(screen.queryByRole("rowheader", { name: /comment/ })).toBeNull();
  });

  it("sets the self-promo verdict from the table pill on a saved community", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as Response);
    const onChanged = vi.fn();
    render(
      <RedditOrganicBody
        data={payload({
          insights: insights(),
          workspace: {
            keywords: [{ id: "k1", term: "rent out my car", type: "problem", origin: "custom", status: "tracking" }],
            competitors: [],
            communities: [{ id: "c9", name: "SaaS", selected: true, rules_verdict: "allowed", rules_verdict_at: null }],
          },
        })}
        onChanged={onChanged}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Self-promo in r\/SaaS/), { target: { value: "unclear" } });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reddit/workspace/communities/c9");
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ rules_verdict: "unclear" });
  });

  it("keeps the dot grey after a failed scan and scans from the icon button", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ sweep_id: "s9" }) } as Response);
    const onChanged = vi.fn();
    const base = insights();
    render(
      <RedditOrganicBody
        data={payload({ insights: insights({ sweep: { ...base.sweep, last: { ...base.sweep.last!, status: "failed" } } }) })}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByRole("img", { name: "No successful scan in the last 24 hours" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scan now" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reddit/sweep");
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ trigger: "manual" });
  });

  it("clears a failed scan's message on its own, so it stops sitting over the tabs", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) } as Response);
    render(<RedditOrganicBody data={payload({ insights: insights() })} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan now" }));
    const message = await vi.waitFor(() => screen.getByText(/scan budget is used up/));
    expect(message).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.queryByText(/scan budget is used up/)).toBeNull();
    vi.useRealTimers();
  });

  it("shows Scanning… instead of the scan button while a sweep runs", () => {
    const base = insights();
    render(
      <RedditOrganicBody
        data={payload({
          insights: insights({ sweep: { ...base.sweep, last: { ...base.sweep.last!, status: "running", finished_at: null } } }),
        })}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText("Scanning…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Scan now" })).toBeNull();
    expect(screen.queryByRole("img", { name: /scan in the last 24 hours/i })).toBeNull();
  });

  it("says the insights failed to load, with a retry, instead of 'No Reddit scan yet'", () => {
    const onChanged = vi.fn();
    render(<RedditOrganicBody data={payload({ insights: null, insights_error: "timeout" })} onChanged={onChanged} />);
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load Reddit insights.");
    expect(screen.queryByText("No Reddit scan yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("lands on Suggested keywords and highlights it from the glance's to-review link", () => {
    const base = payload({ insights: insights() });
    const data = {
      ...base,
      workspace: {
        ...base.workspace!,
        keywords: [
          ...base.workspace!.keywords,
          { id: "k9", term: "turo alternative", type: "comparison", origin: "suggested", status: "suggested" },
        ],
      },
    } as typeof base;
    render(<RedditOrganicBody data={data} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /1 to review/ }));
    expect(screen.getByRole("tab", { name: "Keywords & competitors" }).getAttribute("aria-selected")).toBe("true");
    const section = screen.getByRole("heading", { name: "Suggested keywords" }).closest("section")!;
    expect(section.className).toContain("arrival-glow");
    expect(document.activeElement).toBe(section);
  });

  it("glows the strategy cards only when arriving from the Overview, not on a plain tab visit", () => {
    render(<RedditOrganicBody data={payload({ insights: insights() })} onChanged={() => {}} />);
    const strategyTab = () => screen.getByRole("tab", { name: /Comment & post strategy/ });
    const firstCard = () => screen.getByText("Anyone rent out their car on weekends?").closest("article")!;

    fireEvent.click(strategyTab());
    expect(firstCard().className).not.toMatch(/arrival-glow/);

    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    fireEvent.click(screen.getByRole("button", { name: "See strategy for r/smallbusiness" }));
    expect(firstCard().className).toMatch(/arrival-glow/);

    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    fireEvent.click(strategyTab());
    expect(firstCard().className).not.toMatch(/arrival-glow/);
  });

  it("opens the strategy tab with the subreddit pre-selected from See strategy", () => {
    render(<RedditOrganicBody data={payload({ insights: insights() })} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "See strategy for r/smallbusiness" }));
    expect(screen.getByRole("tab", { name: "Comment & post strategy" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Anyone rent out their car on weekends?")).toBeTruthy();
    expect(screen.queryByText("What tool do you use for churn?")).toBeNull();
    const card = screen.getByText("Anyone rent out their car on weekends?").closest("article")!;
    expect(card.className).toContain("arrival-glow");
  });

  it("offers a manual scan before the first sweep and posts no tenant id", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ sweep_id: "s1" }) } as Response);
    const onChanged = vi.fn();
    render(
      <RedditOrganicBody
        data={payload({ insights: insights({ has_data: false, sweep: { ...insights().sweep, last: null, stale: false } }) })}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText("No Reddit scan yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scan Reddit now" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [path, init] = mockFetch.mock.calls[0];
    expect(path).toBe("/api/reddit/sweep");
    expect(JSON.parse(String(init?.body))).toEqual({ trigger: "manual" });
  });

  it("never scans on its own, even when the data is stale and things are tracked", () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    const onChanged = vi.fn();
    const data = payload({ insights: insights({ sweep: { ...insights().sweep, stale: true } }) });
    const { rerender } = render(<RedditOrganicBody data={data} onChanged={onChanged} />);
    rerender(<RedditOrganicBody data={{ ...data }} onChanged={onChanged} />);
    expect(mockFetch.mock.calls.filter((c) => c[0] === "/api/reddit/sweep")).toHaveLength(0);
  });

  it("does not scan when nothing is tracked either", () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    render(
      <RedditOrganicBody
        data={payload({
          insights: insights({ sweep: { ...insights().sweep, stale: true } }),
          workspace: { keywords: [], competitors: [], communities: [] },
        })}
        onChanged={() => {}}
      />,
    );
    expect(mockFetch.mock.calls.filter((c) => c[0] === "/api/reddit/sweep")).toHaveLength(0);
  });

  it("never asks for keyword suggestions on its own, even with nothing saved, across rerenders and tabs", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ keywords_added: 3, competitors_added: 1 }) } as Response);
    const onChanged = vi.fn();
    const data = payload({ workspace: { keywords: [], competitors: [], communities: [] } });
    const { rerender } = render(<RedditOrganicBody data={data} onChanged={onChanged} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    rerender(<RedditOrganicBody data={{ ...data }} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("tab", { name: "Keywords & competitors" }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(mockFetch.mock.calls.filter((c) => c[0] === "/api/reddit/workspace/suggest")).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not ask for suggestions when keywords are already saved", () => {
    render(<RedditOrganicBody data={payload()} onChanged={() => {}} />);
    expect(mockFetch.mock.calls.filter((c) => c[0] === "/api/reddit/workspace/suggest")).toHaveLength(0);
  });

  it("tracks a keyword and never sends a tenant id", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({}) } as Response);
    const onChanged = vi.fn();
    render(<RedditOrganicBody data={payload()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("tab", { name: "Keywords & competitors" }));
    fireEvent.change(screen.getByLabelText("Add a keyword"), { target: { value: "turo alternative for hosts" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [path, init] = mockFetch.mock.calls[0];
    expect(path).toBe("/api/reddit/workspace/keywords");
    const body = JSON.parse(String(init?.body));
    expect(body.term).toBe("turo alternative for hosts");
    expect(body).not.toHaveProperty("tenant_id");
  });

  it("lists a thread that matches two brand terms once, with both terms", () => {
    const base = insights();
    const m = base.lists.brand_mentions[0];
    render(
      <RedditOrganicBody
        data={payload({
          insights: insights({ lists: { ...base.lists, brand_mentions: [m, { ...m, term: "Acme HQ" }, { ...m, term: "Acme" }] } }),
        })}
        onChanged={() => {}}
      />,
    );
    fireEvent.click(within(screen.getByRole("tablist", { name: "Headline numbers" })).getByRole("tab", { name: /Brand mentions/ }));
    expect(screen.getAllByText("Anyone tried Acme for churn?")).toHaveLength(1);
    expect(screen.getByText("Acme HQ")).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Brand mentions · last 7 days" })).getAllByRole("button", { name: "Draft reply" }),
    ).toHaveLength(1);
  });

  it("does not crash on an older payload with no lists", () => {
    const { lists: _lists, ...rest } = insights();
    render(<RedditOrganicBody data={payload({ insights: rest as RedditInsights })} onChanged={() => {}} />);
    const cards = screen.getByRole("tablist", { name: "Headline numbers" });
    fireEvent.click(within(cards).getByRole("tab", { name: /Brand mentions/ }));
    expect(screen.getByText(/No brand mentions in the last 7 days/)).toBeTruthy();
    fireEvent.click(within(cards).getByRole("tab", { name: /Relevant posts/ }));
    expect(screen.getByText(/No posts scored 60\+ today/)).toBeTruthy();
    fireEvent.click(within(cards).getByRole("tab", { name: /Relevant comments/ }));
    expect(screen.getByText(/No comments scored 60\+ today/)).toBeTruthy();
  });

  it("saves an 'allowed' verdict for an unsaved community selected (only banned is saved paused)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: "c1" }) } as Response);
    const onChanged = vi.fn();
    render(<RedditOrganicBody data={payload()} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText("What the rules of r/smallbusiness say"), { target: { value: "allowed" } });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({
      name: "smallbusiness",
      rules_verdict: "allowed",
      selected: true,
    });
  });

  it("badges the strategy tab with only the opportunities its subreddit filter shows", () => {
    const opps = [
      ...Array.from({ length: 4 }, (_, i) => opportunity({ thread_id: `s${i}`, subreddit: "SaaS" })),
      ...Array.from({ length: 3 }, (_, i) => opportunity({ thread_id: `b${i}`, subreddit: "smallbusiness" })),
    ];
    render(
      <RedditOrganicBody
        data={payload({
          insights: insights({ opportunities: opps }),
          workspace: {
            keywords: [{ id: "k1", term: "rent out my car", type: "problem", origin: "custom", status: "tracking" }],
            competitors: [],
            communities: [
              { id: "c1", name: "smallbusiness", selected: true, rules_verdict: null, rules_verdict_at: null },
              { id: "c2", name: "SaaS", selected: false, rules_verdict: null, rules_verdict_at: null },
            ],
          },
        })}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByRole("tab", { name: "Comment & post strategy" }).textContent).toBe("Comment & post strategy3");
  });

  it("does not ask for suggestions when only the auto-tracked brand keyword is saved", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    const onChanged = vi.fn();
    render(
      <RedditOrganicBody
        data={payload({
          workspace: {
            keywords: [{ id: "kb", term: "Acme", type: "brand", origin: "suggested", status: "tracking" }],
            competitors: [],
            communities: [],
          },
        })}
        onChanged={onChanged}
      />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(mockFetch.mock.calls.filter((c) => c[0] === "/api/reddit/workspace/suggest")).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not ask for suggestions when the workspace failed to load", () => {
    render(
      <RedditOrganicBody
        data={payload({ workspace: { keywords: [], competitors: [], communities: [] }, workspace_error: "timeout" })}
        onChanged={() => {}}
      />,
    );
    expect(mockFetch.mock.calls.filter((c) => c[0] === "/api/reddit/workspace/suggest")).toHaveLength(0);
  });
});
