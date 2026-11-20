// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { apiFetch } from "@/lib/api";
import { KeywordsTab } from "./KeywordsTab";
import type { Keyword, RedditPayload } from "./shared";
import type { RedditInsights } from "./types";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
const mockFetch = vi.mocked(apiFetch);

function insights(over: Partial<RedditInsights> = {}): RedditInsights {
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
      subreddits: { value: 10, top: null },
    },
    communities: [],
    opportunities: [],
    keyword_stats: {
      k1: { mentions_7d: 214, mentions_prev_7d: 167, top_subreddit: "smallbusiness", matches_today: 12 },
      k2: { mentions_7d: 88, mentions_prev_7d: 0, top_subreddit: "sweatystartup", matches_today: 3 },
      k4: { mentions_7d: 0, mentions_prev_7d: 0, top_subreddit: null, matches_today: 0 },
    },
    competitors: [
      {
        id: "c1",
        name: "HubSpot",
        domain: "hubspot.com",
        is_you: false,
        mentions_7d: 60,
        mentions_prev_7d: 80,
        sentiment: { positive: 41, neutral: 37, negative: 22, sample: 100 },
        top_subreddits: ["marketing", "sales"],
        latest_thread: {
          title: "Is HubSpot worth it for a 5 person team?",
          url: "https://www.reddit.com/r/marketing/comments/x/",
          subreddit: "marketing",
          posted_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        },
      },
    ],
    lists: { brand_mentions: [], relevant_posts: [], relevant_comments: [] },
    share_of_voice: {
      window_days: 7,
      total_mentions: 80,
      items: [
        { name: "Pipedrive", mentions: 20, share: 0.25, is_you: false },
        { name: "HubSpot", mentions: 60, share: 0.75, is_you: false },
      ],
    },
    ...over,
  };
}

function payload(over: Partial<RedditPayload> = {}): RedditPayload {
  return {
    connected: false,
    manual_publish: true,
    research_summary: null,
    suggestions: [],
    workspace: {
      keywords: [
        { id: "k1", term: "crm for small team", type: "problem", origin: "custom", status: "tracking" },
        { id: "k2", term: "sales pipeline", type: "industry", origin: "suggested", status: "suggested", why: "Asked weekly." },
        { id: "k3", term: "Acme", type: "brand", origin: "custom", status: "paused" },
        { id: "k4", term: "lead tracking", type: "problem", origin: "suggested", status: "suggested", why: "Seen in r/sales." },
      ],
      competitors: [
        { id: "c1", name: "HubSpot", domain: "hubspot.com", origin: "custom", status: "tracking" },
        { id: "c2", name: "Pipedrive", domain: null, origin: "suggested", status: "suggested", why: "In your profile." },
      ],
      communities: [],
    },
    insights: insights(),
    ...over,
  };
}

const ok = () => ({ ok: true, status: 200, json: async () => ({}) }) as Response;

beforeEach(() => {
  mockFetch.mockReset();
});
afterEach(() => cleanup());

describe("KeywordsTab", () => {
  it("renders keyword stats and uses — where there is no stat", () => {
    render(<KeywordsTab data={payload()} onChanged={() => {}} />);
    expect(screen.getByText("88 mentions this week · most in r/sweatystartup")).toBeTruthy();
    expect(screen.queryByText("Asked weekly.")).toBeNull();
    expect(screen.getByText("Seen in r/sales")).toBeTruthy();
    expect(screen.queryByText(/^0 mentions/)).toBeNull();
    const suggested = screen.getByRole("region", { name: "Suggested keywords" });
    expect(within(suggested).queryByText("Pipedrive")).toBeNull();
    const comps = screen.getByRole("region", { name: "Competitors" });
    expect(within(comps).getAllByText("Pipedrive").length).toBeGreaterThan(0);
    expect(within(comps).getByRole("button", { name: "Track Pipedrive" })).toBeTruthy();
    expect(within(comps).queryByText("Suggested competitors")).toBeNull();

    const table = screen.getByRole("region", { name: "Tracked keywords" });
    const row = within(table).getByText("crm for small team").closest("tr")!;
    expect(within(row).getByText("214")).toBeTruthy();
    expect(within(row).getByText("28%")).toBeTruthy();
    expect(within(row).getByText("r/smallbusiness")).toBeTruthy();
    expect(within(row).getByText("12")).toBeTruthy();
    expect(within(row).getByText("Tracking")).toBeTruthy();

    const paused = within(table).getByText("Acme").closest("tr")!;
    expect(within(paused).getAllByText("-").length).toBe(4);
    expect(within(paused).getByText("Paused")).toBeTruthy();
    expect(screen.getByText("2 keywords watched across 10 subreddits.")).toBeTruthy();
  });

  it("tracks and dismisses suggestions with a PATCH", async () => {
    mockFetch.mockResolvedValue(ok());
    const onChanged = vi.fn();
    render(<KeywordsTab data={payload()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Track sales pipeline" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Pipedrive" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reddit/workspace/keywords/k2");
    expect(mockFetch.mock.calls[0][1]?.method).toBe("PATCH");
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ status: "tracking" });
    expect(mockFetch.mock.calls[1][0]).toBe("/api/reddit/workspace/competitors/c2");
    expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ status: "dismissed" });
  });

  it("adds a keyword and a competitor with no tenant id", async () => {
    mockFetch.mockResolvedValue(ok());
    const onChanged = vi.fn();
    render(<KeywordsTab data={payload()} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText("Add a keyword"), { target: { value: "crm alternative" } });
    expect(screen.queryByLabelText("Keyword type")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Add a competitor"), { target: { value: "salesforce.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add competitor" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));

    const [kPath, kInit] = mockFetch.mock.calls[0];
    expect(kPath).toBe("/api/reddit/workspace/keywords");
    expect(JSON.parse(String(kInit?.body))).toEqual({ term: "crm alternative" });
    const [cPath, cInit] = mockFetch.mock.calls[1];
    expect(cPath).toBe("/api/reddit/workspace/competitors");
    const cBody = JSON.parse(String(cInit?.body));
    expect(cBody).toEqual({ name: "salesforce.com" });
    expect(cBody).not.toHaveProperty("tenant_id");
  });

  it("pauses a tracked keyword and dismisses from a chip (all tracked keywords are chips)", async () => {
    mockFetch.mockResolvedValue(ok());
    const onChanged = vi.fn();
    render(<KeywordsTab data={payload()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause crm for small team" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ status: "paused" });
    expect(screen.getByRole("button", { name: "Stop tracking crm for small team" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop tracking Acme" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(mockFetch.mock.calls[1][0]).toBe("/api/reddit/workspace/keywords/k3");
    expect(mockFetch.mock.calls[1][1]?.method).toBe("PATCH");
    expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({ status: "dismissed" });
    expect(screen.queryByRole("button", { name: /^Remove crm/ })).toBeNull();
  });

  it("changes a tracked keyword's type with a PATCH", async () => {
    mockFetch.mockResolvedValue(ok());
    const onChanged = vi.fn();
    render(<KeywordsTab data={payload()} onChanged={onChanged} />);
    const select = screen.getByLabelText("Type for crm for small team") as HTMLSelectElement;
    expect(select.value).toBe("problem");
    fireEvent.change(select, { target: { value: "industry" } });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reddit/workspace/keywords/k1");
    expect(mockFetch.mock.calls[0][1]?.method).toBe("PATCH");
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({ type: "industry" });
  });

  it("adds competitors from the Competitors card and capitalises all-lowercase names", () => {
    const base = payload();
    const data = payload({
      workspace: {
        ...base.workspace!,
        competitors: [{ id: "c3", name: "turo", domain: null, origin: "suggested", status: "suggested", why: "In your profile." }],
      },
    });
    render(<KeywordsTab data={data} onChanged={() => {}} />);
    const card = screen.getByRole("region", { name: "Competitors" });
    expect(within(card).getByLabelText("Add a competitor")).toBeTruthy();
    expect(within(card).getAllByText("Turo").length).toBeGreaterThan(0);
  });

  it("keeps a competitor with no mentions out of the table, as a chip under it", () => {
    const base = payload();
    const data = payload({
      workspace: {
        ...base.workspace!,
        competitors: [{ id: "c9", name: "Drivemobi", domain: null, origin: "custom", status: "tracking" }],
      },
    });
    render(<KeywordsTab data={data} onChanged={() => {}} />);
    const card = screen.getByRole("region", { name: "Competitors" });
    expect(within(card).queryByRole("table")).toBeNull();
    expect(within(card).getByRole("button", { name: "Remove Drivemobi" })).toBeTruthy();
  });

  it("shows share-of-voice percents for competitors only, largest first in black", () => {
    render(<KeywordsTab data={payload()} onChanged={() => {}} />);
    const bar = screen.getByRole("img", { name: /Share of voice/ });
    expect(bar.getAttribute("aria-label")).toBe("Share of voice: HubSpot 75%, Pipedrive 25%");
    expect((bar.firstElementChild as HTMLElement).className).toContain("bg-ink");
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.queryByText(/\(you\)/)).toBeNull();
  });

  it("never shows a legacy company row in share of voice or the competitors table", () => {
    const base = insights();
    const data = payload({
      insights: {
        ...base,
        competitors: [
          { ...base.competitors[0], id: null, name: "Acme", domain: "acme.com", is_you: true },
          ...base.competitors,
        ],
        share_of_voice: {
          ...base.share_of_voice,
          items: [...base.share_of_voice.items, { name: "Acme", mentions: 50, share: 0.4, is_you: true }],
        },
      },
    });
    render(<KeywordsTab data={data} onChanged={() => {}} />);
    expect(screen.getByRole("img", { name: /Share of voice/ }).getAttribute("aria-label")).toBe(
      "Share of voice: HubSpot 75%, Pipedrive 25%",
    );
    expect(screen.queryByText("acme.com")).toBeNull();
  });

  it("labels sentiment as inferred and shows the competitor row", () => {
    render(<KeywordsTab data={payload()} onChanged={() => {}} />);
    expect(screen.getByText("(inferred)")).toBeTruthy();
    const label = screen.getByText(/41% positive · 22% negative/);
    expect(label.closest("[title]")?.getAttribute("title")).toMatch(/^Inferred by Zavi.*100 mentions read$/);
    expect(screen.getByText("hubspot.com")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Is HubSpot worth it/ }).getAttribute("href")).toContain("reddit.com");
    expect(screen.getByText("r/marketing · 2h ago")).toBeTruthy();
    const hub = screen.getByRole("region", { name: "Competitors" });
    expect(within(hub).getByText("25%")).toBeTruthy();
  });

  it("shows empty states with no insights and draws no bar", () => {
    render(
      <KeywordsTab
        data={payload({
          insights: null,
          workspace: { keywords: [{ id: "k9", term: "x", type: "problem", origin: "custom", status: "tracking" }], competitors: [], communities: [] },
        })}
        onChanged={() => {}}
      />,
    );
    expect(screen.queryByRole("region", { name: "Share of voice on Reddit" })).toBeNull();
    expect(screen.queryByRole("img", { name: /Share of voice/ })).toBeNull();
    expect(screen.getByText(/No competitors yet/)).toBeTruthy();
    expect(screen.getByText("1 keyword watched.")).toBeTruthy();
  });

  it("does not auto-suggest on mount (the shell does), but Refresh asks for suggestions", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ keywords_added: 2 }) } as Response);
    const onChanged = vi.fn();
    render(
      <KeywordsTab data={payload({ workspace: { keywords: [], competitors: [], communities: [] } })} onChanged={onChanged} />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(mockFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Refresh suggestions/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reddit/workspace/suggest");
  });

  it("moves a tracked suggestion at once and puts it back if the save fails", async () => {
    let fail!: (r: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((res) => (fail = res)));
    const onChanged = vi.fn();
    render(<KeywordsTab data={payload()} onChanged={onChanged} />);
    const suggested = screen.getByRole("region", { name: "Suggested keywords" });
    fireEvent.click(within(suggested).getByRole("button", { name: "Track sales pipeline" }));
    expect(within(suggested).queryByText("sales pipeline")).toBeNull();
    expect(screen.getByText(/Now tracking “sales pipeline”/)).toBeTruthy();
    expect((within(suggested).getByRole("button", { name: "Track lead tracking" }) as HTMLButtonElement).disabled).toBe(false);
    fail({ ok: false, status: 500, json: async () => ({}) } as Response);
    expect(await within(suggested).findByText("sales pipeline")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });
  it("disables a row's status pill and chip while its PATCH is in flight, so clicks can't race", async () => {
    let settle!: (r: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((res) => (settle = res)));
    const onChanged = vi.fn();
    render(<KeywordsTab data={payload()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause crm for small team" }));
    const pill = screen.getByRole("button", { name: "Resume crm for small team" }) as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Stop tracking crm for small team" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pill);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Resume Acme" }) as HTMLButtonElement).disabled).toBe(false);
    mockFetch.mockReturnValueOnce(new Promise<Response>(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Track Pipedrive" }));
    expect((screen.getByRole("button", { name: "Remove Pipedrive" }) as HTMLButtonElement).disabled).toBe(true);
    settle(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("button", { name: "Resume crm for small team" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("lets fresh server data win after a successful write, even when it disagrees", async () => {
    mockFetch.mockResolvedValue(ok());
    const onChanged = vi.fn();
    const first = payload();
    const { rerender } = render(<KeywordsTab data={first} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause crm for small team" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Resume crm for small team" })).toBeTruthy();
    rerender(<KeywordsTab data={payload()} onChanged={onChanged} />);
    expect(await screen.findByRole("button", { name: "Pause crm for small team" })).toBeTruthy();
  });

  it("keeps the override while the write is pending even if an unrelated refresh lands", async () => {
    mockFetch.mockReturnValueOnce(new Promise<Response>(() => {}));
    const { rerender } = render(<KeywordsTab data={payload()} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause crm for small team" }));
    rerender(<KeywordsTab data={payload()} onChanged={() => {}} />);
    expect(screen.getByRole("button", { name: "Resume crm for small team" })).toBeTruthy();
  });

  it("caps the tracked keywords table at 10 rows behind Show more / Show less", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      id: `t${i}`,
      term: `term ${i}`,
      type: "problem",
      origin: "custom",
      status: "tracking",
    })) as Keyword[];
    render(
      <KeywordsTab
        data={payload({ workspace: { keywords: many, competitors: [], communities: [] } })}
        onChanged={() => {}}
      />,
    );
    const table = () => within(screen.getByRole("region", { name: "Tracked keywords" })).getByRole("table");
    expect(within(table()).getAllByRole("row")).toHaveLength(11);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(within(table()).getAllByRole("row")).toHaveLength(14);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(within(table()).getAllByRole("row")).toHaveLength(11);
  });

  it("hides the expander when 10 or fewer keywords are tracked", () => {
    render(<KeywordsTab data={payload()} onChanged={() => {}} />);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("scrolls only the panel's scroll container to the Competitors section and focuses it", () => {
    const intoView = vi.fn();
    Element.prototype.scrollIntoView = intoView;
    const scrollTo = vi.fn();
    const inPanel = (arrival: number) => (
      <div data-testid="panel" style={{ overflowY: "auto" }}>
        <KeywordsTab data={payload()} onChanged={() => {}} competitorsArrival={arrival} />
      </div>
    );
    const { rerender } = render(inPanel(0));
    const panel = screen.getByTestId("panel");
    Object.defineProperty(panel, "scrollHeight", { value: 2000 });
    Object.defineProperty(panel, "clientHeight", { value: 600 });
    panel.scrollTo = scrollTo as unknown as typeof panel.scrollTo;
    expect(scrollTo).not.toHaveBeenCalled();
    rerender(inPanel(1));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(intoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Competitors" }));
  });
});
