// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
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
vi.mock("../../agent/XAgentDashboard", async () => {
  const actual = await vi.importActual<typeof import("../../agent/XAgentDashboard")>("../../agent/XAgentDashboard");
  return { ...actual, XAgentDashboard: () => <div /> };
});
vi.mock("../../agent/RedditOrganicDashboard", () => ({ RedditOrganicDashboard: () => <div /> }));
vi.mock("../../seo/SeoChannelPanel", () => ({ SeoChannelPanel: () => <div /> }));

const channel = (slug: string) => (CHANNELS as readonly Channel[]).find((c) => c.slug === slug)!;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const NO_HISTORY = { runs: [], closed: [], pre_switch: [] };

function dayOffset(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const setupFix = (slug: string, id: string, title: string, over: Partial<ChannelActionView> = {}) =>
  makeAction("fix", {
    id,
    channel_slug: slug,
    title,
    body: { intent: "fix_setup", step: { title, body: `Why: ${title} matters.\n\n1. Open settings\n2. Change it` } },
    how_to: ["Open settings", "Change it"],
    ...over,
  } as Partial<ChannelActionView>);

const post = (slug: string, id: string, title: string, day: string | null, over: Partial<ChannelActionView> = {}) =>
  makeAction("text_post", {
    id,
    channel_slug: slug,
    title,
    plan_day: day,
    body: { intent: "create", step: { title, deliverable: { kind: "post", label: "Post", content: `${title} copy` } } },
    ...over,
  } as Partial<ChannelActionView>);

function route(slug: string, body: { actions: ChannelActionView[]; plan?: unknown }, dashboard: unknown = null) {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes(`/api/channels/${slug}/actions`)) return ok({ ...body, more: 0, store: "channel_actions" });
    if (u.includes(`/api/channels/${slug}/metrics`)) return ok({ metrics: [] });
    if (u.includes(`/api/channels/${slug}/history`)) return ok(NO_HISTORY);
    if (u.includes(`/dashboard`)) return dashboard ? ok(dashboard) : { ok: false, status: 500, json: async () => ({}) };
    return ok({ snapshots: [], artifacts: [], briefs: [] });
  });
}

async function open(slug: string, over: Partial<ChannelDetail> = {}) {
  const detail: ChannelDetail = {
    channel: channel(slug),
    mode: "produce",
    connected: true,
    connectors: [],
    workState: "delivered",
    lastRunAt: new Date().toISOString(),
    lastProbeAt: null,
    lastProbeDelta: null,
    runnable: true,
    ...over,
  };
  const r = render(
    <ChannelDrawer detail={detail} actionCount={1} error={null} onClose={() => {}} onOpenConnectors={() => {}}>
      <li>An older suggestion</li>
    </ChannelDrawer>,
  );
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
      await new Promise((r2) => setTimeout(r2, 0));
    }
  });
  return r;
}

const at = (sel: string) => {
  const el = document.querySelector<HTMLElement>(sel);
  expect(el, `section ${sel}`).toBeTruthy();
  return el!;
};
function expectOrder(...sels: string[]) {
  const els = sels.map(at);
  for (let i = 1; i < els.length; i += 1) {
    expect(
      els[i - 1]!.compareDocumentPosition(els[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      `${sels[i - 1]} before ${sels[i]}`,
    ).toBeTruthy();
  }
}
function cardsOnScreen() {
  return Array.from(at("[data-testid='action-section']").querySelectorAll<HTMLElement>("article[data-action-type]"))
    .map((card) => card.dataset.testid?.replace(/^action-/, "")).sort();
}

beforeEach(() => {
  apiFetch.mockReset();
  __resetAgentDashCache();
});
afterEach(cleanup);

const X = "x_organic";
function xPayload(): XPayload {
  return {
    generic: false,
    connected: true,
    handle: "@example",
    account_name: "Example",
    window_days: 7,
    period: { from: "2026-09-13", to: "2026-09-20" },
    ranges: [{ id: "7d", label: "Last 7 days", days: 7 }],
    read_budget: { used: 1, cap: 2, remaining: 1 },
    read: { read: true },
    metrics: [
      { key: "engagement_rate", label: "Engagement rate", value: 2.5, unit: "pct", delta: null, delta_unit: "pp", basis: "period" },
      { key: "impressions", label: "Impressions", value: 40, unit: "count", delta: null, delta_unit: "pct", basis: "period" },
    ],
    attention: [],
    drafts: [],
    top_posts: [
      { id: "p1", external_post_id: "1", url: "https://x.com/example/status/1", text: "The post that worked", format: "single", posted_at: "2026-09-18T00:00:00Z", source: "zavi", status: "posted", thumb_url: null, media_type: null, views: 9100, likes: 84, replies: 12, reposts: 7, bookmarks: 3, link_clicks: 40, profile_clicks: 11, engagements: 120, eng_rate: 1.3, private_metrics_available: true },
    ],
    checklist: {
      passed: 1,
      total: 3,
      signals: [
        { key: "avatar", label: "Profile picture", status: "pass", note: "Custom image set", link: null },
        { key: "verified", label: "Verified", status: "unknown", note: "X did not say", link: null },
        { key: "pinned", label: "Pinned post", status: "fix", note: "Nothing pinned", link: "https://x.com/example" },
      ],
    },
    snapshot_days: 30,
  } as XPayload;
}

describe("X, full data", () => {
  const actions = [
    setupFix(X, "x-f1", "Link your X account from your site", { blocking: true }),
    post(X, "x-p1", "The 3pm slump post", dayOffset(1)),
    post(X, "x-p2", "1,200 reorders this summer", dayOffset(2)),
    makeAction("reply", { id: "x-r1", channel_slug: X, title: "Reply about shipping" }),
  ];

  it("keeps planning on the cards and orders the action queue before setup and history", async () => {
    route(X, { actions }, xPayload());
    await open(X, { connectors: ["x_social"] });
    expectOrder("[data-testid='action-section']", "[data-testid='prior-items']");
    expectOrder("[data-section='snapshot']", "[data-section='top-items']");
    expect(at("[data-testid='channel-tab-analytics']").contains(at("[data-section='snapshot']"))).toBe(true);
    expect(at("[data-testid='channel-tab-analytics']").contains(at("[data-section='top-items']"))).toBe(true);
    expect(screen.queryByTestId("this-week")).toBeNull();
    expect(screen.queryByTestId("series")).toBeNull();
    expect(at("[data-section='top-items']").textContent).not.toContain("Top posts");
    expect(document.querySelector("[data-section='setup']")).toBeNull();
    expect(at("[data-testid='channel-tab-overview']").textContent).not.toContain("Profile checklist");
  });

  it("shows every ranked card with the blocking fix first", async () => {
    route(X, { actions }, xPayload());
    await open(X, { connectors: ["x_social"] });
    expect(cardsOnScreen()).toEqual(actions.map((action) => action.id).sort());
    expect(at("[data-testid='action-section'] article").dataset.testid).toBe("action-x-f1");
    expect(within(at("[data-testid='action-section']")).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  const nulls = () =>
    (["impressions", "engagement_rate", "profile_visits", "link_clicks", "new_follows", "replies", "likes", "reposts"] as const).map(
      (key) => ({ key, label: key, value: null, unit: key === "engagement_rate" ? "pct" : "count", delta: null, delta_unit: "pct", basis: "none" }),
    );
  const tileTexts = () =>
    Array.from(at("[data-section='snapshot']").querySelectorAll<HTMLElement>("[data-metric]")).map((t) => t.textContent ?? "");

  it("not connected: the same eight tiles, empty, with why, above the Connect card", async () => {
    route(X, { actions }, { ...xPayload(), connected: false, metrics: nulls() });
    await open(X, { connected: false, connectors: ["x_social"] });
    const tiles = tileTexts();
    expect(tiles).toHaveLength(8);
    for (const t of tiles) {
      expect(t).not.toContain("Fills in once connected");
      expect(t).toMatch(/–/);
    }
    expect(within(at("[data-section='snapshot']")).getByTestId("connect-card")).toBeTruthy();
  });

  it("connected but nothing measured: each tile is its name and a dash, with no caption and no unverified mark", async () => {
    route(X, { actions }, { ...xPayload(), metrics: nulls() });
    await open(X, { connectors: ["x_social"] });
    const tiles = Array.from(at("[data-section='snapshot']").querySelectorAll<HTMLElement>("[data-metric]"));
    expect(tiles).toHaveLength(8);
    for (const t of tiles) {
      expect(t.textContent).not.toContain("Not measured yet");
      expect(t.textContent).not.toMatch(/unverified|NaN|\b0\b/i);
      expect(t.textContent).toMatch(/–/);
      expect(t.querySelectorAll("p.text-\\[13px\\]")).toHaveLength(0);
    }
  });

  it("a setup to-do shows its steps on the card itself, with no side drawer", async () => {
    route(X, { actions }, xPayload());
    await open(X, { connectors: ["x_social"] });
    const card = screen.getByTestId("action-x-f1");
    expect(card.textContent).toContain("Open settings");
    expect(card.textContent).toContain("Change it");
    expect(within(card).queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Link your X account from your site" })).toBeNull();
  });
});

describe("SEO, setup-heavy", () => {
  const S = "seo";
  const actions = [
    setupFix(S, "seo-f1", "Add a sitemap", { blocking: true }),
    setupFix(S, "seo-f2", "Add descriptions to 11 pages"),
    setupFix(S, "seo-f3", "Describe 7 product photos"),
    makeAction("page", { id: "seo-g1", channel_slug: S, title: "New page: caffeine in tea" }),
    makeAction("check", { id: "seo-c1", channel_slug: S, title: "Check your homepage title" }),
  ];
  const payload = {
    generic: false,
    connected: false,
    site_health: {
      status: "ok",
      site: "https://www.example.com",
      error_code: null,
      fetched_at: "2026-09-20T19:03:41.069+00:00",
      stale: false,
      notes: [],
      pages_analyzed: 1,
      findings: [{ code: "h1_missing", summary: "Two pages have no H1 heading.", urls: ["https://www.example.com/"] }],
      pages: [{ url: "https://www.example.com/", status: 200, title: "Home", title_length: 4, meta_description: null, canonical: null, h1_count: 0, schema_types: [], noindex: false, visible_words: 300 }],
    },
  };

  it("snapshot first, then every ranked setup fix and recommendation", async () => {
    route(S, { actions }, payload);
    await open(S, { connected: false, connectors: ["google_search_console"] });
    expectOrder("[data-testid='action-section']", "[data-testid='prior-items']");
    expect(at("[data-testid='channel-tab-analytics']").contains(at("[data-section='snapshot']"))).toBe(true);
    expect(cardsOnScreen()).toEqual(actions.map((action) => action.id).sort());
    expect(document.querySelector("[data-section='setup']")).toBeNull();
  });
});

describe("ChatGPT Ads settings", () => {
  it("shows the ad account and wallet panel on Settings only, with no posting choice", async () => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
    route("chatgpt_ads", { actions: [] });
    const answer = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string) =>
      String(url) === "/api/ads/accounts/chatgpt" ? ok({ accounts: [], managed: [], selected_id: null }) : String(url).includes("/api/ads/") ? ok({ campaigns: [] }) : answer(url));
    await open("chatgpt_ads");
    expect(screen.queryByTestId("ads-account-summary")).toBeNull();
    await act(async () => screen.getByRole("tab", { name: "Analytics" }).click());
    expect(screen.queryByTestId("ads-account-summary")).toBeNull();
    await act(async () => screen.getByRole("tab", { name: /Settings/ }).click());
    expect(screen.getByTestId("ads-account-summary")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Before Zavi posts" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Tell me when" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "An ad goes live" })).toBeNull();
  });
});

describe("Instagram, not connected", () => {
  const I = "instagram_organic";
  const actions = [
    setupFix(I, "ig-f1", "Put your shop link in your bio", { blocking: true }),
    post(I, "ig-p1", "Reel: steeping oolong", dayOffset(1), {
      series: { id: "brew30", name: "30-second brew", episode: 1, next: ["Green tea at 80C"] },
    } as Partial<ChannelActionView>),
    post(I, "ig-p2", "Photo: Sunday tea tray", dayOffset(3)),
    makeAction("send_message", { id: "ig-o1", channel_slug: I, title: "Message 3 local cafes" }),
  ];

  it("the snapshot draws without a connect sentence, above the same sections in the same order", async () => {
    route(I, { actions }, { connected: false, metrics: [] });
    await open(I, { connected: false, connectors: ["instagram_social", "composio.instagram"] });
    await act(async () => screen.getByRole("tab", { name: "Analytics" }).click());
    expect(at("[data-testid='channel-tab-analytics']").contains(at("[data-section='snapshot']"))).toBe(true);
    expectOrder("[data-testid='action-section']", "[data-testid='prior-items']");
    expect(screen.queryByTestId("this-week")).toBeNull();
    expect(screen.queryByTestId("series")).toBeNull();
    expect(at("[data-section='snapshot']").textContent).not.toContain("Connect Instagram in Settings");
    expect(screen.queryByTestId("connect-card")).toBeNull();
    expect(cardsOnScreen()).toEqual(actions.map((action) => action.id).sort());
  });
});

describe("Blog, plan and drafts", () => {
  const B = "blog";
  const actions = [
    post(B, "bl-p1", "How to brew loose leaf tea without gear", dayOffset(1)),
    post(B, "bl-p2", "Oolong vs green tea", dayOffset(2)),
    makeAction("page", { id: "bl-g1", channel_slug: B, title: "Give the Brewing guide a real title" }),
    makeAction("page", { id: "bl-g2", channel_slug: B, title: "Link your 3 oldest posts to the shop" }),
    makeAction("page", { id: "bl-g3", channel_slug: B, title: "Split the About page" }),
    makeAction("check", { id: "bl-c1", channel_slug: B, title: "Check the blog shows in Google" }),
  ];
  const plan = { id: "plan-1", title: "Blog strategy", content: "Get found when people search how to start with tea.", proposed_at: "2026-09-20T00:00:00Z", status: "pending" };

  it("puts the saved plan inside Ready for you with every ranked card", async () => {
    route(B, { actions, plan });
    await open(B, { connected: false, connectors: ["google_search_console"] });
    expect(at("[data-testid='channel-tab-analytics']").contains(at("[data-section='snapshot']"))).toBe(true);
    expect(at("[data-testid='action-section']").contains(at("[data-testid='channel-plan']"))).toBe(true);
    expectOrder("[data-testid='action-section']", "[data-testid='prior-items']");
    expect(screen.queryByTestId("this-week")).toBeNull();
    expect(cardsOnScreen()).toEqual(actions.map((action) => action.id).sort());
  });
});

describe("Email campaigns, which connect through Mailchimp or Klaviyo", () => {
  const E = "email_marketing";
  const actions = [makeAction("send_message", { id: "em-1", channel_slug: E, title: "Paste the 3-email welcome sequence into your email tool" })];

  it("offers both accounts on one Connect card in the snapshot, with no quiet note", async () => {
    route(E, { actions });
    await open(E, { connected: false, connectors: ["composio.mailchimp", "composio.klaviyo"] });
    const snapshot = at("[data-section='snapshot']");
    const card = within(snapshot).getByTestId("connect-card");
    expect(card.textContent).toContain("Mailchimp");
    expect(card.textContent).toContain("Klaviyo");
    expect(screen.queryByTestId("connect-note")).toBeNull();
  });

  it("Pinterest directs connection to Settings from its own Analytics page", async () => {
    route("pinterest_organic", { actions: [] }, { connected: false, analytics: { as_of: null, windows: {} } });
    await open("pinterest_organic", { connected: false, connectors: ["composio.pinterest"] });
    expect(at("[data-section='snapshot']").hidden).toBe(true);
    await act(async () => screen.getByRole("tab", { name: "Analytics" }).click());
    const analytics = await screen.findByTestId("pinterest-analytics");
    expect(await within(analytics).findByText(/Connect Pinterest in Settings/)).toBeTruthy();
    expect(within(analytics).queryByTestId("connect-card")).toBeNull();
  });
});

describe("card-level post scheduling", () => {
  it.each(["reddit_organic", "pinterest_organic", "email_marketing", "x_organic"])(
    "%s keeps dated posts in the action queue without a duplicate week calendar",
    async (slug) => {
      route(slug, { actions: [post(slug, `${slug}-p1`, "A dated post", dayOffset(1)), post(slug, `${slug}-p2`, "An undated post", null)] });
      await open(slug);
      expect(await screen.findByTestId("action-section")).toBeTruthy();
      expect(screen.queryByTestId("this-week")).toBeNull();
    },
  );
});
