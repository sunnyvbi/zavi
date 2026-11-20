// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ExtraTable } from "../ExtraTable";
import { toast } from "@/components/ui/toast";
import { extraTableData } from "../../agent/legacyChannelActions";
import { redditKpiTables } from "../../agent/reddit/extraTables";
import type { RedditInsights } from "../../agent/reddit/types";

const apiFetch = vi.hoisted(() => vi.fn(() => Promise.reject(new Error("offline"))));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiFetch,
}));

afterEach(cleanup);

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const INSIGHTS = {
  has_data: true,
  threshold: 60,
  sweep: { enabled: true, last: null, budget: { used_usd_7d: 0, cap_usd_7d: 5, exhausted: false }, stale: false },
  today: { posts_scanned: 400, communities_scanned: 6, posts_relevant: 12 },
  kpis: {
    brand_mentions: { value: 24, previous: 20, brand_terms: 1 },
    reply_opportunities: { value: 31, previous: 22, on_google: null },
    relevant_posts: { value: 12, previous: 9, scanned: 400 },
    relevant_comments: { value: 8, previous: 5, scanned: 900 },
    subreddits: { value: 2, top: null },
  },
  communities: [
    {
      name: "smallbusiness",
      relevance: 82,
      relevance_why: "Owners ask about booking software here",
      subscribers: 1_800_000,
      posts_per_day: 140,
      posts_per_day_capped: true,
      rules_verdict: "unclear",
      selected: true,
      saved: true,
      recommended: false,
      reply_opportunities: 4,
    },
    {
      name: "r/Entrepreneur",
      relevance: null,
      relevance_why: null,
      subscribers: null,
      posts_per_day: null,
      posts_per_day_capped: false,
      rules_verdict: null,
      selected: false,
      saved: false,
      recommended: true,
      reply_opportunities: 0,
    },
  ],
  opportunities: [
    {
      thread_id: "t3_aaa",
      url: "https://reddit.com/r/smallbusiness/aaa",
      subreddit: "smallbusiness",
      title: "What do you use to take deposits?",
      posted_at: "2026-09-19T12:00:00.000Z",
      score: 140,
      comment_count: 32,
      post_relevance: 88,
      comment_relevance: 41,
      relevance_why: null,
      matched_terms: ["deposits"],
      google: { checked: true, rank: 3, query: "take deposits small business" },
      draft: null,
    },
    {
      thread_id: "t3_bbb",
      url: "https://reddit.com/r/smallbusiness/comments/bbb/title/",
      subreddit: "smallbusiness",
      title: "Anyone switched off spreadsheets?",
      posted_at: null,
      score: null,
      comment_count: null,
      post_relevance: 62,
      comment_relevance: null,
      relevance_why: null,
      matched_terms: [],
      google: { checked: true, rank: null, query: null },
      draft: { text: "…", source: "zavi", state: "drafted", decision_id: null },
    },
  ],
  keyword_stats: {},
  competitors: [],
  lists: {
    brand_mentions: [
      {
        thread_id: "t3_m1",
        url: "https://reddit.com/r/smallbusiness/m1",
        subreddit: "smallbusiness",
        title: "Acme actually worked for us",
        author: "someone",
        term: "acme",
        sentiment: "positive",
        score: 61,
        comment_count: 9,
        observed_at: hoursAgo(12),
        draft: { text: "We had the same trouble with deposits.", state: "drafted" },
      },
      {
        thread_id: "t3_m2",
        url: "https://reddit.com/r/smallbusiness/m2",
        subreddit: "smallbusiness",
        title: "Acme billing is a mess",
        author: null,
        term: "acme",
        sentiment: "negative",
        score: null,
        comment_count: 3,
        observed_at: hoursAgo(40),
      },
    ],
    relevant_posts: [
      {
        thread_id: "t3_p1",
        url: "https://reddit.com/r/smallbusiness/p1",
        subreddit: "smallbusiness",
        title: "Best way to invoice repeat clients?",
        posted_at: "2026-09-19T18:00:00.000Z",
        relevance: 77,
        matched_terms: ["invoice"],
        score: 52,
        comment_count: 1,
      },
    ],
    relevant_comments: [
      {
        comment_id: "t1_c1",
        thread_id: "t3_p1",
        url: "https://reddit.com/r/smallbusiness/p1/c1",
        subreddit: "smallbusiness",
        thread_title: "Best way to invoice repeat clients?",
        author: "asker",
        excerpt: "We tried three and hated all of them",
        relevance: 71,
        matched_terms: ["invoice"],
        score: 4,
      },
    ],
  },
  share_of_voice: { window_days: 7, total_mentions: 24, items: [] },
} as unknown as RedditInsights;

const PAYLOAD = {
  connected: true,
  manual_publish: true,
  research_summary: null,
  suggestions: [],
  insights: INSIGHTS,
  workspace: {
    keywords: [{ id: "k1", term: "Acme", type: "brand", origin: "custom", status: "tracking" }],
    competitors: [],
    communities: [
      { id: "c1", name: "smallbusiness", selected: true, rules_verdict: "banned", rules_verdict_at: null },
    ],
  },
};

const byId = (id: string) => {
  const t = redditKpiTables(PAYLOAD).find((x) => x.id === id);
  if (!t) throw new Error(`no table ${id}`);
  return t;
};

const headers = () => screen.getAllByRole("columnheader").map((h) => h.textContent);

it("answers five named tables from ONE declared id", () => {
  const tables = extraTableData("reddit_kpi_tables", PAYLOAD);
  expect(tables.map((t) => t.id)).toEqual([
    "reddit_brand_mentions",
    "reddit_reply_opportunities",
    "reddit_relevant_posts",
    "reddit_relevant_comments",
    "reddit_subreddits",
  ]);
  expect(new Set(tables.map((t) => t.id)).size).toBe(tables.length);
});

it("answers NO table at all when nothing has scanned yet", () => {
  expect(extraTableData("reddit_kpi_tables", { ...PAYLOAD, insights: null })).toEqual([]);
  expect(extraTableData("reddit_kpi_tables", { ...PAYLOAD, insights: { has_data: false } })).toEqual([]);
  expect(extraTableData("reddit_kpi_tables", { generic: true })).toEqual([]);
});

it("keeps the brand-mentions columns, in their order, with their words", () => {
  render(<ExtraTable data={byId("reddit_brand_mentions")} />);
  expect(headers()).toEqual(["Thread", "Sentiment", "Upvotes", "Comments", "Age", "Reply"]);
  const row = screen.getByText("Acme actually worked for us").closest("tr")!;
  expect(within(row).getAllByRole("cell").map((c) => c.textContent).slice(0, 5)).toEqual([
    "Acme actually worked for usr/smallbusiness · u/someone",
    "Positive",
    "61",
    "9",
    "12h ago",
  ]);
  const quiet = screen.getByText("Acme billing is a mess").closest("tr")!;
  expect(within(quiet).getAllByRole("cell")[2].textContent).toBe("-");
});

it("keeps the reply-opportunity columns and reads a fit out of 100", () => {
  render(<ExtraTable data={byId("reddit_reply_opportunities")} />);
  expect(headers()).toEqual(["Thread", "Post fit", "Comment fit", "Google", "Status", "Reply"]);
  const row = screen.getByText("What do you use to take deposits?").closest("tr")!;
  const cells = within(row).getAllByRole("cell");
  expect(cells[1].textContent).toContain("88/100");
  expect(cells[2].textContent).toBe("41/100");
  expect(cells[3].textContent).toBe("Google #3 “take deposits small business”");
  expect(cells[4].textContent).toBe("-");
});

it("moves upvotes into the thread line instead of a column of their own", () => {
  render(<ExtraTable data={byId("reddit_reply_opportunities")} />);
  expect(headers()).not.toContain("Upvotes");
  const row = screen.getByText("What do you use to take deposits?").closest("tr")!;
  expect(within(row).getAllByRole("cell")[0].textContent).toContain("r/smallbusiness");
  expect(within(row).getAllByRole("cell")[0].textContent).toContain("32 comments · 140 upvotes");
  expect(within(row).getAllByRole("cell")).toHaveLength(6);
});

it("puts the terms that matched a thread behind its Post fit", () => {
  render(<ExtraTable data={byId("reddit_reply_opportunities")} />);
  const row = screen.getByText("What do you use to take deposits?").closest("tr")!;
  const fitCell = within(row).getAllByRole("cell")[1];
  fireEvent.click(within(fitCell).getByRole("button", { name: "Show 1 matched keyword" }));
  expect(screen.getByText("deposits")).toBeTruthy();
  const bare = screen.getByText("Anyone switched off spreadsheets?").closest("tr")!;
  expect(within(within(bare).getAllByRole("cell")[1]).queryByRole("button")).toBeNull();
});

it("always draws the Google column, saying Not checked rather than a dash nobody can read", () => {
  const payload = {
    ...PAYLOAD,
    insights: {
      ...INSIGHTS,
      opportunities: INSIGHTS.opportunities!.map((o) => ({ ...o, google: { checked: false, rank: null, query: null } })),
    },
  };
  const table = redditKpiTables(payload).find((t) => t.id === "reddit_reply_opportunities")!;
  render(<ExtraTable data={table} />);
  expect(headers()).toContain("Google");
  const row = screen.getByText("What do you use to take deposits?").closest("tr")!;
  expect(within(row).getAllByRole("cell")[3].textContent).toBe("Not checked");
  const checked = screen.getAllByRole("columnheader").findIndex((h) => h.textContent === "Google");
  expect(checked).toBe(3);
});

it("lays the reply table out narrow and opens drafts in a drawer, for both draft tables", () => {
  const reply = byId("reddit_reply_opportunities");
  const mentions = byId("reddit_brand_mentions");
  expect(reply.detailInDrawer).toBe(true);
  expect(mentions.detailInDrawer).toBe(true);
  render(<ExtraTable data={reply} />);
  expect(screen.getByRole("table").className).toContain("min-w-table-narrow");
  cleanup();
  render(<ExtraTable data={mentions} />);
  expect(screen.getByRole("table").className).not.toContain("min-w-table-narrow");
});

it("names the tracked brand in an empty mentions table instead of telling the founder to add it", () => {
  const empty = { ...PAYLOAD, insights: { ...INSIGHTS, lists: { ...INSIGHTS.lists, brand_mentions: [] } } };
  const table = redditKpiTables(empty).find((t) => t.id === "reddit_brand_mentions")!;
  expect(table.empty).toBe("No mentions of Acme in the last 7 days.");
  const untracked = { ...empty, workspace: { ...PAYLOAD.workspace, keywords: [] } };
  expect(redditKpiTables(untracked).find((t) => t.id === "reddit_brand_mentions")!.empty).toBe(
    "No brand mentions in the last 7 days. Track your brand name in Keywords, then scan.",
  );
});

it("keeps the relevant-posts and relevant-comments columns", () => {
  render(<ExtraTable data={byId("reddit_relevant_posts")} />);
  expect(headers()).toEqual(["Post", "Relevance", "Upvotes"]);
  const scored = within(screen.getByText("Best way to invoice repeat clients?").closest("tr")!);
  expect(scored.getByRole("meter", { name: "Relevance" }).getAttribute("aria-valuenow")).toBe("77");
  expect(scored.getAllByRole("cell")[1].textContent).toBe("77High");
  expect(scored.getByRole("button", { name: "Show 1 matched keyword" })).toBeTruthy();
  cleanup();

  render(<ExtraTable data={byId("reddit_relevant_comments")} />);
  expect(headers()).toEqual(["Comment", "Relevance", "Reply"]);
});

it("keeps the subreddit columns and shows the verdict the founder recorded", () => {
  render(<ExtraTable data={byId("reddit_subreddits")} />);
  expect(headers()).toEqual(["Subreddit", "Relevance", "Members", "Posts / day", "Self-promo"]);
  const row = screen.getByText("r/smallbusiness").closest("tr")!;
  expect(within(row).getAllByRole("cell").map((c) => c.textContent).slice(0, 4)).toEqual([
    "r/smallbusinessOwners ask about booking software here",
    "82High",
    "1.8M",
    "140+",
  ]);
  const verdict = within(row).getByRole("combobox", {
    name: "Self-promo in r/smallbusiness (your reading of its rules)",
  }) as HTMLSelectElement;
  expect(verdict.value).toBe("banned");
  const unscored = screen.getByText("r/Entrepreneur").closest("tr")!;
  expect(within(unscored).getAllByRole("cell")[1].textContent).toBe("-");
  expect(within(unscored).queryByRole("meter")).toBeNull();
  expect((within(unscored).getByRole("combobox") as HTMLSelectElement).value).toBe("");
});

it("offers a draft only where there is not one already", () => {
  render(<ExtraTable data={byId("reddit_reply_opportunities")} />);
  const open = screen.getByText("What do you use to take deposits?").closest("tr")!;
  expect(within(open).getByRole("button", { name: "Draft reply" })).toBeTruthy();
  expect(within(open).queryByRole("button", { name: /^Show draft/ })).toBeNull();

  const done = screen.getByText("Anyone switched off spreadsheets?").closest("tr")!;
  expect(within(done).queryByRole("button", { name: "Draft reply" })).toBeNull();
  expect(within(done).getByText("Drafted")).toBeTruthy();
  expect(within(done).getByRole("button", { name: "Show draft: Anyone switched off spreadsheets?" })).toBeTruthy();
});

it("opens the reply Zavi drafted in a drawer, with something to do about it", async () => {
  render(<ExtraTable data={byId("reddit_reply_opportunities")} />);
  const done = screen.getByText("Anyone switched off spreadsheets?").closest("tr")!;
  fireEvent.click(within(done).getByRole("button", { name: /^Show draft/ }));
  const drawer = await screen.findByRole("dialog");
  expect(await within(drawer).findByText("…")).toBeTruthy();
  expect(within(drawer).getByRole("button", { name: "Connect Reddit to post" })).toBeTruthy();
  expect(within(drawer).getByRole("button", { name: "Edit" })).toBeTruthy();
  fireEvent.click(within(drawer).getByRole("button", { name: "More actions" }));
  expect(screen.getByRole("menuitem", { name: /^Copy/ })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: /^Done/ })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /^Mark as posted/ })).toBeNull();
});

it("refuses to post a draft in a community whose rules ban self-promotion, and still lets the founder copy it", async () => {
  const connected = { ...PAYLOAD, account: { connected: true } };
  const table = redditKpiTables(connected).find((t) => t.id === "reddit_reply_opportunities")!;
  render(<ExtraTable data={table} />);
  fireEvent.click(within(screen.getByText("Anyone switched off spreadsheets?").closest("tr")!).getByRole("button", { name: /^Show draft/ }));
  const drawer = await screen.findByRole("dialog");
  await within(drawer).findByText("…");
  expect(within(drawer).getByText("This community does not allow self-promotion, so Zavi won't post here. You can still copy the reply.")).toBeTruthy();
  expect(within(drawer).getByRole("button", { name: "Post on Reddit" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(within(drawer).getByRole("button", { name: "More actions" }));
  expect(screen.getByRole("menuitem", { name: /^Copy/ }).hasAttribute("disabled")).toBe(false);
});

it("lets a draft in an allowed community post", async () => {
  const allowed = {
    ...PAYLOAD,
    account: { connected: true },
    workspace: { ...PAYLOAD.workspace, communities: [{ ...PAYLOAD.workspace.communities[0], rules_verdict: "allowed" }] },
  };
  const table = redditKpiTables(allowed).find((t) => t.id === "reddit_reply_opportunities")!;
  render(<ExtraTable data={table} />);
  fireEvent.click(within(screen.getByText("Anyone switched off spreadsheets?").closest("tr")!).getByRole("button", { name: /^Show draft/ }));
  const drawer = await screen.findByRole("dialog");
  await within(drawer).findByText("…");
  expect(within(drawer).queryByText(/does not allow self-promotion/)).toBeNull();
  expect(within(drawer).getByRole("button", { name: "Post on Reddit" }).hasAttribute("disabled")).toBe(false);
});

it("goes busy from the promise, not from a prop, and settles when it rejects", async () => {
  let reject: (e: Error) => void = () => {};
  const data = {
    ...byId("reddit_relevant_posts"),
    rows: [
      {
        id: "r1",
        cells: [{ text: "A row" }, { text: "—" }, { text: "0" }],
        actions: [
          {
            label: "Draft reply",
            busyLabel: "Drafting…",
            onClick: () => new Promise((_, r) => { reject = r; }),
          },
        ],
      },
    ],
  };
  render(<ExtraTable data={data} />);
  const button = screen.getByRole("button", { name: "Draft reply" });
  button.click();
  expect(await screen.findByRole("button", { name: "Drafting…" })).toBeTruthy();

  reject(new Error("nope"));
  expect(await screen.findByRole("button", { name: "Draft reply" })).toBeTruthy();
  expect(button.hasAttribute("disabled")).toBe(false);
});

it("links a comment reply rather than making it a button", () => {
  render(<ExtraTable data={byId("reddit_relevant_comments")} />);
  const reply = screen.getByRole("link", { name: "Reply on Reddit to u/asker" });
  expect(reply.getAttribute("href")).toBe("https://reddit.com/r/smallbusiness/p1/c1");
  expect(reply.getAttribute("rel")).toContain("noopener");
});

it("offers a brand mention its draft, and offers to write one where there is none", async () => {
  render(<ExtraTable data={byId("reddit_brand_mentions")} />);
  const drafted = screen.getByText("Acme actually worked for us").closest("tr")!;
  expect(within(drafted).queryByRole("button", { name: "Draft reply" })).toBeNull();
  fireEvent.click(within(drafted).getByRole("button", { name: "Show draft: Acme actually worked for us" }));
  expect(await within(await screen.findByRole("dialog")).findByText("We had the same trouble with deposits.")).toBeTruthy();

  const blank = screen.getByText("Acme billing is a mess").closest("tr")!;
  expect(within(blank).getByRole("button", { name: "Draft reply" })).toBeTruthy();
  expect(within(blank).queryByRole("button", { name: /^Show draft/ })).toBeNull();
});

it("names the action column for a screen reader, which the buttons alone do not", () => {
  render(<ExtraTable data={byId("reddit_reply_opportunities")} />);
  expect(screen.getByText("Reply").className).toContain("sr-only");
});

it("rejects with the reason when a draft fails, and does not re-read", async () => {
  const onChanged = vi.fn();
  const table = redditKpiTables(PAYLOAD, onChanged).find((t) => t.id === "reddit_reply_opportunities")!;
  const action = table.rows[0].actions![0];
  await expect(action.onClick?.()).rejects.toThrow("Couldn't reach Zavi. Check your connection.");
  expect(onChanged).not.toHaveBeenCalled();
  expect(action.retryLabel).toBe("Retry draft");
});

it("shows the failure in a pop-up, not inside the table row, and offers the retry", async () => {
  const shown = vi.spyOn(toast, "add").mockReturnValue("t");
  const table = redditKpiTables(PAYLOAD).find((t) => t.id === "reddit_reply_opportunities")!;
  const { container } = render(<ExtraTable data={table} />);
  const button = screen.getByRole("button", { name: "Draft reply" });
  fireEvent.click(button);
  expect(await screen.findByRole("button", { name: "Retry draft" })).toBeTruthy();
  expect(shown).toHaveBeenCalledWith({ type: "error", title: "Couldn't reach Zavi. Check your connection." });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(container.textContent).not.toContain("Couldn't reach Zavi");
  shown.mockRestore();
});
