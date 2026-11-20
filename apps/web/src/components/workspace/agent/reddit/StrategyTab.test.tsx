// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { apiFetch } from "@/lib/api";
import { StrategyTab, strategyDefaultSubs, strategyVisibleOpportunities, type Opportunity } from "./StrategyTab";
import type { RedditPayload, Community } from "./shared";
import type { RedditInsights } from "./types";
import { submitToReddit } from "./publish";
import { resetRedditPublishStates } from "./useRedditPublish";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-test" }));
vi.mock("@/app/connectors/connectStrategies", () => ({ startRailConnect: vi.fn() }));
vi.mock("./publish", async (importOriginal) => ({ ...(await importOriginal<typeof import("./publish")>()), submitToReddit: vi.fn() }));
const mockFetch = vi.mocked(apiFetch);
const mockPublish = vi.mocked(submitToReddit);

function opp(id: string, sub: string, over: Partial<Opportunity> = {}): Opportunity {
  return {
    thread_id: id,
    url: `https://www.reddit.com/r/${sub}/comments/${id}/`,
    subreddit: sub,
    title: `Thread ${id}`,
    posted_at: new Date(Date.now() - 6 * 3600_000).toISOString(),
    score: 412,
    comment_count: 186,
    post_relevance: 96,
    comment_relevance: 91,
    relevance_why: null,
    matched_terms: ["first customers"],
    google: { checked: false, rank: null, query: null },
    draft: null,
    ...over,
  };
}

function insights(opportunities: Opportunity[]): RedditInsights {
  return {
    has_data: true,
    sweep: { enabled: true, last: null, budget: { used_usd_7d: 0, cap_usd_7d: 3, exhausted: false }, stale: false },
    threshold: 70,
    today: { posts_scanned: 0, communities_scanned: 0, posts_relevant: 0 },
    kpis: {
      brand_mentions: { value: 0, previous: null, brand_terms: 1 },
      reply_opportunities: { value: 0, previous: null, on_google: null },
      relevant_posts: { value: 0, previous: null, scanned: 0 },
      relevant_comments: { value: 0, previous: null, scanned: 0 },
      subreddits: { value: 3, top: null },
    },
    communities: [],
    opportunities,
    keyword_stats: {},
    competitors: [],
    lists: { brand_mentions: [], relevant_posts: [], relevant_comments: [] },
    share_of_voice: { window_days: 7, total_mentions: 0, items: [] },
  };
}

const community = (name: string, selected: boolean): Community => ({
  id: `c-${name}`,
  name,
  selected,
  rules_verdict: null,
  rules_verdict_at: null,
});

function payload(opps: Opportunity[], over: Partial<RedditPayload> = {}): RedditPayload {
  return {
    connected: true,
    manual_publish: true,
    research_summary: null,
    suggestions: [],
    workspace: { keywords: [], competitors: [], communities: [] },
    insights: insights(opps),
    ...over,
  };
}

const ok = () => ({ ok: true, status: 200, json: async () => ({}) }) as Response;

beforeEach(() => {
    resetRedditPublishStates();
  mockFetch.mockReset();
  mockPublish.mockReset().mockResolvedValue({ decisionId: "d-new", status: "published" });
});

const connectedAccount = { account: { connected: true, handle: "founder" } };
afterEach(() => cleanup());

const step = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  title: "Set up free Reddit keyword alerts",
  body: "F5bot is free and catches these in your email.",
  blocking: false,
  effort: "minutes",
  evidence: ["run"],
  ...over,
});

const cardTitles = () => screen.queryAllByRole("article").map((a) => within(a).queryByText(/^Thread /)?.textContent);

describe("StrategyTab", () => {
  it("defaults to all subreddits with no chips when none are saved", () => {
    const data = payload([opp("a1", "startups"), opp("b1", "saas")]);
    render(<StrategyTab data={data} onChanged={() => {}} selectedSubs={null} onSelectSubs={() => {}} />);
    expect(screen.getByRole("button", { name: /Subreddits/ }).textContent).not.toMatch(/\d|all/);
    expect(screen.queryByRole("list", { name: "Selected subreddits" })).toBeNull();
    expect(cardTitles()).toEqual(["Thread a1", "Thread b1"]);
    expect(screen.getByRole("heading", { name: "Comment opportunities · last 7 days" })).toBeTruthy();
    expect(screen.queryByText(/Today/)).toBeNull();
    expect(
      screen.getByText("Threads from the last 7 days across every tracked subreddit, ranked by post and comment relevance."),
    ).toBeTruthy();
    expect(screen.getAllByText("r/startups").length).toBeGreaterThan(0);
    expect(screen.getAllByText("412").length).toBeGreaterThan(0);
    const fit = screen.getAllByText("High fit");
    expect(fit).toHaveLength(2);
    expect(fit[0].getAttribute("title")).toMatch(/^Post relevance \d+\/100$/);
  });

  it("defaults to the founder's selected communities and shows chips for them only", () => {
    const data = payload([opp("a1", "startups"), opp("b1", "saas"), opp("c1", "marketing")], {
      workspace: {
        keywords: [],
        competitors: [],
        communities: [community("startups", true), community("SaaS", true), community("marketing", false)],
      },
    });
    const onSelect = vi.fn();
    render(<StrategyTab data={data} onChanged={() => {}} selectedSubs={null} onSelectSubs={onSelect} />);
    const chips = screen.getByRole("list", { name: "Selected subreddits" });
    expect(within(chips).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["r/startups", "r/SaaS"]);
    expect(screen.getByRole("button", { name: /Subreddits/ }).textContent).toContain("2");
    expect(cardTitles()).toEqual(["Thread a1", "Thread b1"]);
    fireEvent.click(within(chips).getByRole("button", { name: "Remove r/SaaS" }));
    expect(onSelect).toHaveBeenCalledWith(["startups"]);
  });

  it("uses one-subreddit sub-copy from the shell selection", () => {
    const data = payload([opp("a1", "startups"), opp("b1", "saas")]);
    render(<StrategyTab data={data} onChanged={() => {}} selectedSubs={["saas"]} onSelectSubs={() => {}} />);
    expect(cardTitles()).toEqual(["Thread b1"]);
    expect(screen.getByText("Threads from the last 7 days in r/saas, ranked by post and comment relevance.")).toBeTruthy();
  });

  it("Google-only keeps ranks <= 10 and labels ranks past 10 as not on page 1", () => {
    const data = payload([
      opp("a1", "startups", { google: { checked: true, rank: 4, query: "how to get first 100 customers for saas" } }),
      opp("b1", "startups", { google: { checked: true, rank: 14, query: "x" } }),
      opp("c1", "startups", { google: { checked: false, rank: null, query: null } }),
    ]);
    render(<StrategyTab data={data} onChanged={() => {}} selectedSubs={null} onSelectSubs={() => {}} />);
    expect(screen.getByText("Google #4")).toBeTruthy();
    expect(screen.queryByText("Google #14")).toBeNull();
    expect(screen.getAllByText("Not on Google page 1")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Ranking on Google only"));
    expect(cardTitles()).toEqual(["Thread a1"]);
  });

  it("says Top 5 only when five opportunities are shown", () => {
    const data = payload(["a1", "b1", "c1", "d1", "e1", "f1"].map((id) => opp(id, "startups")));
    render(<StrategyTab data={data} onChanged={() => {}} selectedSubs={null} onSelectSubs={() => {}} />);
    expect(screen.getByRole("heading", { name: "Top 5 comment opportunities · last 7 days" })).toBeTruthy();
    expect(cardTitles()).toHaveLength(5);
  });

  it("drafts a reply with one POST and refreshes", async () => {
    mockFetch.mockResolvedValue(ok());
    const onChanged = vi.fn();
    render(<StrategyTab data={payload([opp("a1", "startups")])} onChanged={onChanged} selectedSubs={null} onSelectSubs={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft reply" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mockFetch).toHaveBeenCalledWith("/api/reddit/threads/a1/draft", { method: "POST" });
  });

  it("shows an inline error when drafting fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) } as Response);
    const onChanged = vi.fn();
    render(<StrategyTab data={payload([opp("a1", "startups")])} onChanged={onChanged} selectedSubs={null} onSelectSubs={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft reply" }));
    expect(await screen.findByText("Couldn't draft a reply. Try again in a moment.")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("posts a run draft to its thread, then closes it through the approval", async () => {
    mockFetch.mockResolvedValue(ok());
    const onChanged = vi.fn();
    const data = payload(
      [opp("a1", "startups", { draft: { text: "Try this.", source: "run", state: "proposed", decision_id: "d-1" } })],
      connectedAccount,
    );
    render(<StrategyTab data={data} onChanged={onChanged} selectedSubs={null} onSelectSubs={() => {}} />);
    expect(screen.getByText("In approval queue")).toBeTruthy();
    expect(screen.getByText("Try this.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    expect(await screen.findByText("Posted")).toBeTruthy();
    await waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: 3000 });
    expect(screen.queryByText("Try this.")).toBeNull();
    const [action, content] = mockPublish.mock.calls[0];
    expect(action.body.link).toBe("https://www.reddit.com/r/startups/comments/a1/");
    expect(content).toEqual({ text: "Try this." });
    expect(mockFetch.mock.calls[0][0]).toBe("/api/approvals/d-1/approve");
    const patch = mockFetch.mock.calls.find(([url]) => url === "/api/reddit/threads/a1");
    expect(patch?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ draft_state: "posted" });
  });

  it("closes a channel_actions draft on the channel-actions route after posting", async () => {
    mockFetch.mockResolvedValue(ok());
    const onChanged = vi.fn();
    const data = payload(
      [
        opp("a1", "startups", {
          draft: { text: "Try this.", source: "run", state: "proposed", decision_id: "ca-1", action_source: "channel_action" },
        }),
      ],
      connectedAccount,
    );
    render(<StrategyTab data={data} onChanged={onChanged} selectedSubs={null} onSelectSubs={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: 3000 });
    expect(mockFetch.mock.calls[0][0]).toBe("/api/channel-actions/ca-1");
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body)).action).toBe("acted");
    expect(mockFetch.mock.calls.some(([url, init]) => url === "/api/reddit/threads/a1" && init?.method === "PATCH")).toBe(true);
  });

  it("posts a Zavi draft and records it as posted with a PATCH", async () => {
    mockFetch.mockResolvedValue(ok());
    const onChanged = vi.fn();
    const data = payload(
      [opp("a1", "startups", { draft: { text: "Hi.", source: "zavi", state: "drafted", decision_id: null } })],
      connectedAccount,
    );
    render(<StrategyTab data={data} onChanged={onChanged} selectedSubs={null} onSelectSubs={() => {}} />);
    expect(screen.queryByText("In approval queue")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reddit/threads/a1");
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ draft_state: "posted" });
  });

  it("keeps the draft and shows why when Reddit refuses it", async () => {
    mockPublish.mockRejectedValue(new Error("Reddit did not take it (THREAD_LOCKED)."));
    const onChanged = vi.fn();
    const data = payload(
      [opp("a1", "startups", { draft: { text: "Hi.", source: "zavi", state: "drafted", decision_id: null } })],
      connectedAccount,
    );
    render(<StrategyTab data={data} onChanged={onChanged} selectedSubs={null} onSelectSubs={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Reddit did not take it (THREAD_LOCKED).");
    expect(screen.getByText("Hi.")).toBeTruthy();
    expect(screen.queryByText("Posted")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not let a run reply the community rules forbid be posted", () => {
    const data = payload(
      [
        opp("a1", "startups", {
          draft: { text: "Try this.", source: "run", state: "proposed", decision_id: "d-1", rule_status: "not_allowed" },
        }),
      ],
      connectedAccount,
    );
    render(<StrategyTab data={data} onChanged={() => {}} selectedSubs={null} onSelectSubs={() => {}} />);
    const approve = screen.getByRole("button", { name: "Approve & post" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("offers to connect Reddit instead of posting when no account is connected", () => {
    const data = payload([opp("a1", "startups", { draft: { text: "Hi.", source: "zavi", state: "drafted", decision_id: null } })]);
    render(<StrategyTab data={data} onChanged={() => {}} selectedSubs={null} onSelectSubs={() => {}} />);
    expect(screen.getByRole("button", { name: "Connect Reddit to post" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve & post" })).toBeNull();
  });

  it("shows a posted pill and keeps the comment visible", () => {
    const data = payload([
      opp("a1", "startups", { draft: { text: "Already out there.", source: "run", state: "posted", decision_id: "d-1" } }),
    ]);
    render(<StrategyTab data={data} onChanged={() => {}} selectedSubs={null} onSelectSubs={() => {}} />);
    expect(screen.getByText("Posted")).toBeTruthy();
    expect(screen.getByText("Already out there.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("keeps run drafts that match no opportunity in their own section", () => {
    const data = payload([opp("a1", "startups")], {
      suggestions: [
        {
          id: "r-match",
          type: "reddit_reply",
          subreddit: "startups",
          thread_title: "Matched thread",
          thread_url: "https://www.reddit.com/r/startups/comments/A1/some_slug/",
          body: "matched body",
          reply_style: "helpful",
          rule_status: "ready",
        },
        {
          id: "r-orphan",
          type: "reddit_reply",
          subreddit: "startups",
          thread_title: "Orphan thread",
          thread_url: "https://www.reddit.com/r/startups/comments/zz9/other/",
          body: "orphan body",
          reply_style: "helpful",
          rule_status: "ready",
        },
      ],
    });
    render(<StrategyTab data={data} onChanged={() => {}} selectedSubs={null} onSelectSubs={() => {}} />);
    const section = screen.getByRole("region", { name: "Replies Zavi drafted for you" });
    expect(within(section).getByText("Orphan thread")).toBeTruthy();
    expect(within(section).queryByText("Matched thread")).toBeNull();
  });

  it("shows a run draft for a thread ranked below the five cards on screen", () => {
    const opps = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"].map((id) => opp(id, "startups"));
    opps.push(opp("a8", "startups", { post_relevance: 71, comment_relevance: 71 }));
    const reply = (id: string, title: string) => ({
      id: `r-${id}`,
      type: "reddit_reply" as const,
      subreddit: "startups",
      thread_title: title,
      thread_url: `https://www.reddit.com/r/startups/comments/${id}/slug/`,
      body: `${title} body`,
      reply_style: "helpful",
      rule_status: "ready",
    });
    const data = payload(opps, { suggestions: [reply("a1", "On a card"), reply("a8", "Below the fold")] } as never);

    render(<StrategyTab data={data} onChanged={() => {}} selectedSubs={null} onSelectSubs={() => {}} />);

    expect(screen.queryByText("Thread a8")).toBeNull();
    const section = screen.getByRole("region", { name: "Replies Zavi drafted for you" });
    expect(within(section).getByText("Below the fold")).toBeTruthy();
    expect(within(section).queryByText("On a card")).toBeNull();
  });

  it("adds a subreddit from the picker", async () => {
    mockFetch.mockResolvedValue(ok());
    const onChanged = vi.fn();
    render(<StrategyTab data={payload([opp("a1", "startups")])} onChanged={onChanged} selectedSubs={null} onSelectSubs={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Subreddits/ }));
    fireEvent.change(screen.getByLabelText("Add a subreddit"), { target: { value: "r/Entrepreneur" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reddit/workspace/communities");
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ name: "entrepreneur" });
  });
  it("keeps an 'all' view after adding a subreddit (the new one is saved selected)", async () => {
    mockFetch.mockResolvedValue(ok());
    const onChanged = vi.fn();
    const onSelect = vi.fn();
    const data = payload([opp("a1", "startups")], {
      workspace: { keywords: [], competitors: [], communities: [community("startups", true)] },
    });
    render(<StrategyTab data={data} onChanged={onChanged} selectedSubs={null} onSelectSubs={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Subreddits/ }));
    fireEvent.change(screen.getByLabelText("Add a subreddit"), { target: { value: "r/Entrepreneur" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onSelect).not.toHaveBeenCalled();
    const after = payload([opp("a1", "startups"), opp("b1", "saas")], {
      workspace: {
        keywords: [],
        competitors: [],
        communities: [community("startups", true), community("Entrepreneur", true)],
      },
    });
    cleanup();
    render(<StrategyTab data={after} onChanged={onChanged} selectedSubs={null} onSelectSubs={onSelect} />);
    expect(cardTitles()).toEqual(["Thread a1", "Thread b1"]);
    expect(screen.queryByRole("list", { name: "Selected subreddits" })).toBeNull();
  });

  it("adds a new subreddit to an explicit selection", async () => {
    mockFetch.mockResolvedValue(ok());
    const onSelect = vi.fn();
    render(
      <StrategyTab data={payload([opp("a1", "startups")])} onChanged={() => {}} selectedSubs={["startups"]} onSelectSubs={onSelect} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Subreddits/ }));
    fireEvent.change(screen.getByLabelText("Add a subreddit"), { target: { value: "saas" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(["startups", "saas"]));
  });

  it("pins 'all' explicitly when the new row alone would become a deliberate selection", async () => {
    mockFetch.mockResolvedValue(ok());
    const onSelect = vi.fn();
    const data = payload([opp("a1", "startups"), opp("b1", "saas")], {
      workspace: { keywords: [], competitors: [], communities: [community("marketing", false)] },
    });
    render(<StrategyTab data={data} onChanged={() => {}} selectedSubs={null} onSelectSubs={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Subreddits/ }));
    fireEvent.change(screen.getByLabelText("Add a subreddit"), { target: { value: "growth" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect([...onSelect.mock.calls[0][0]].sort()).toEqual(["growth", "marketing", "saas", "startups"]);
  });
});

describe("strategyDefaultSubs", () => {
  const withCommunities = (communities: Community[]) =>
    payload([], { workspace: { keywords: [], competitors: [], communities } });

  it("is all (null) with no saved communities", () => {
    expect(strategyDefaultSubs(withCommunities([]))).toBeNull();
    expect(strategyDefaultSubs(payload([], { workspace: undefined }))).toBeNull();
  });

  it("is all (null) when every saved community is selected, including a single one", () => {
    expect(strategyDefaultSubs(withCommunities([community("startups", true)]))).toBeNull();
    expect(strategyDefaultSubs(withCommunities([community("startups", true), community("saas", true)]))).toBeNull();
  });

  it("is all (null) when none are selected", () => {
    expect(strategyDefaultSubs(withCommunities([community("startups", false)]))).toBeNull();
  });

  it("is the selected ones, normalised, when the founder deselected some on purpose", () => {
    expect(
      strategyDefaultSubs(
        withCommunities([community("r/Startups", true), community("SaaS", true), community("marketing", false)]),
      ),
    ).toEqual(["startups", "saas"]);
  });
});

describe("strategyVisibleOpportunities", () => {
  const opps = [opp("a1", "startups"), opp("b1", "SaaS"), opp("c1", "marketing")];

  it("lists every opportunity for the 'all' default, in server order", () => {
    expect(strategyVisibleOpportunities(payload(opps), null).map((o) => o.thread_id)).toEqual(["a1", "b1", "c1"]);
  });

  it("uses the deliberate saved selection as the default", () => {
    const data = payload(opps, {
      workspace: {
        keywords: [],
        competitors: [],
        communities: [community("startups", true), community("marketing", false)],
      },
    });
    expect(strategyVisibleOpportunities(data, null).map((o) => o.thread_id)).toEqual(["a1"]);
  });

  it("filters to an explicit pick, case-insensitively, and [] for an empty pick", () => {
    expect(strategyVisibleOpportunities(payload(opps), ["saas", "r/Marketing"]).map((o) => o.thread_id)).toEqual(["b1", "c1"]);
    expect(strategyVisibleOpportunities(payload(opps), [])).toEqual([]);
  });

  it("ignores the Google filter and is empty with no sweep data", () => {
    const ranked = payload([opp("a1", "startups", { google: { checked: true, rank: 30, query: "x" } })]);
    expect(strategyVisibleOpportunities(ranked, null)).toHaveLength(1);
    expect(strategyVisibleOpportunities(payload([], { insights: null }), null)).toEqual([]);
  });

  it("matches the cards the tab shows", () => {
    const data = payload(opps, {
      workspace: {
        keywords: [],
        competitors: [],
        communities: [community("startups", true), community("saas", true), community("marketing", false)],
      },
    });
    render(<StrategyTab data={data} onChanged={() => {}} selectedSubs={null} onSelectSubs={() => {}} />);
    expect(cardTitles()).toEqual(strategyVisibleOpportunities(data, null).map((o) => `Thread ${o.thread_id}`));
  });
});

describe("checks only you can do", () => {
  it("says how long a step takes and copies its paste-ready block", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(
      <StrategyTab
        data={payload([], {
          supporting_steps: [
            step({ deliverable: { kind: "text", label: "Keywords to add", content: "1. turo alternative" } }),
          ],
        })}
        onChanged={() => {}}
        selectedSubs={null}
        onSelectSubs={() => {}}
      />,
    );
    expect(screen.getByText("Takes minutes")).toBeTruthy();
    expect(screen.getByText("Keywords to add")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Copy$/ }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("1. turo alternative"));
    const copied = await screen.findByRole("button", { name: "Copied" });
    expect(copied.textContent).toBe("");
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("falls back to a plain label when the step names none", () => {
    render(
      <StrategyTab
        data={payload([], { supporting_steps: [step({ deliverable: { kind: "text", label: null, content: "do this" } })] })}
        onChanged={() => {}}
        selectedSubs={null}
        onSelectSubs={() => {}}
      />,
    );
    expect(screen.getByText("Ready to paste")).toBeTruthy();
  });
});
