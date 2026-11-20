// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ApiError } from "@/lib/workspace/channelActionsApi";

const h = vi.hoisted(() => ({
  approve: vi.fn(),
  apiFetch: vi.fn(),
  refresh: vi.fn(),
  refreshSilent: vi.fn(),
  seed: vi.fn(),
  openTab: vi.fn(),
  listActions: vi.fn(),
  listMetrics: vi.fn(),
  setAction: vi.fn(),
  redoAction: vi.fn(),
  approveAction: vi.fn(),
  data: null as unknown,
  params: null as Record<string, string> | null,
}));

vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch }));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: h.approve }));
vi.mock("@/lib/workspace/channelActionsApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/workspace/channelActionsApi")>("@/lib/workspace/channelActionsApi");
  return {
    ...actual,
    listChannelActions: h.listActions,
    listChannelMetrics: h.listMetrics,
    setChannelAction: h.setAction,
    redoChannelAction: h.redoAction,
    approve: h.approveAction,
    newRequestId: () => "req-1",
  };
});
vi.mock("../WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({ openAgentTab: h.openTab, seedComposer: h.seed, tenantName: "t" }),
}));
vi.mock("../layout/shared", () => ({ useOpenStatic: () => vi.fn(), FOCUS_RING: "" }));
vi.mock("./dashboard-ui", async () => {
  const actual = await vi.importActual<typeof import("./dashboard-ui")>("./dashboard-ui");
  return {
    ...actual,
    useAgentDashboard: (_slug: string, opts?: { params?: Record<string, string> }) => {
      h.params = opts?.params ?? null;
      return { data: h.data, loading: false, refreshing: false, error: null, refresh: h.refresh, refreshSilent: h.refreshSilent, newRowIds: new Set() };
    },
  };
});

import { XAgentDashboard, type XPayload, type XMetric } from "./XAgentDashboard";
import { makeAction } from "../actions/__tests__/fixtures";
import { xIntentUrl } from "../actions/platforms";

const metric = (key: XMetric["key"], label: string, value: number | null, delta: number | null, extra: Partial<XMetric> = {}): XMetric => ({
  key, label, value, delta, unit: "count", delta_unit: "pct", basis: value === null ? "none" : "period", ...extra,
});

const payload = (): XPayload => ({
  connected: true,
  handle: "@coupleapp",
  account_name: "Couple App",
  window_days: 30,
  period: { from: "2026-08-20", to: "2026-09-18" },
  read: { read: true },
  read_budget: { used: 0, cap: 1, remaining: 1 },
  actions_waiting: 3,
  metrics: [
    metric("impressions", "Impressions", 24800, 18.2),
    metric("engagement_rate", "Engagement rate", 2.8, 0.4, { unit: "pct", delta_unit: "pp" }),
    metric("profile_visits", "Profile visits", 186, 12),
    metric("link_clicks", "Link clicks", 74, -19.4),
    metric("new_follows", "New follows", 42, null),
    metric("replies", "Replies", 28, 27.3),
    metric("likes", "Likes", 482, 14.2),
    metric("reposts", "Reposts", 36, 20),
  ],
  attention: [
    { key: "bio", title: "Bio does not say what Couple App is", detail: "Write one line that says what Couple App does, and keep the link.", mode: "manual", status: "open", effort: "1 min", decision_id: null, link: "https://x.com/coupleapp", blocking: false },
    { key: "avatar", title: "Profile picture is the default placeholder", detail: "Upload the logo at 400×400.", mode: "manual", status: "done", effort: "1 min", decision_id: null, link: "https://x.com/coupleapp", blocking: false },
    { key: "step:d3", title: "Reply under @lovecoach's thread", detail: "Their audience is your buyer.", mode: "approval", status: "open", effort: "2 min", decision_id: "d3", link: null, blocking: false },
  ],
  drafts: [
    { decision_id: "d1", channel: "x", text: "Your first 10 customers don't need a perfect product.", thread: null, image_path: null, video_path: null, scheduled_at: "2026-09-17T09:30:00Z", rationale: "Opens with a hook people react to, then resolves it in one line.", emitted_at: null },
  ],
  top_posts: [
    { id: "p1", external_post_id: "1", url: "https://x.com/i/web/status/1", text: "A first note from the account", format: "thread", posted_at: "2026-09-15T10:00:00Z", source: "zavi", status: "published", thumb_url: null, media_type: null, views: 4, likes: 0, replies: 1, reposts: 0, bookmarks: 0, link_clicks: 0, profile_clicks: 0, engagements: 1, eng_rate: 25, private_metrics_available: true },
    { id: "p2", external_post_id: "2", url: "https://x.com/i/web/status/2", text: "What to check before you list", format: "post", posted_at: "2026-09-17T10:00:00Z", source: "zavi", status: "published", thumb_url: null, media_type: null, views: 1, likes: 0, replies: 0, reposts: 0, bookmarks: 0, link_clicks: 0, profile_clicks: 0, engagements: 0, eng_rate: 0, private_metrics_available: true },
  ],
  checklist: {
    passed: 5,
    total: 10,
    signals: [
      { key: "avatar", label: "Profile picture", status: "fix", note: "Still the default placeholder", link: "https://x.com/coupleapp" },
      { key: "header", label: "Header image", status: "fix", note: "No header image", link: "https://x.com/coupleapp" },
      { key: "bio", label: "Bio states what you do", status: "fix", note: "Bio is empty", link: "https://x.com/coupleapp" },
      { key: "link", label: "Link in bio", status: "pass", note: "https://coupleapp.com", link: "https://x.com/coupleapp" },
      { key: "location", label: "Location set", status: "pass", note: "SF", link: "https://x.com/coupleapp" },
      { key: "pinned", label: "Pinned post", status: "fix", note: "Nothing pinned", link: "https://x.com/coupleapp" },
      { key: "cadence", label: "Posting cadence ≥ 3 / week", status: "pass", note: "4 posts a week", link: null },
      { key: "reply_rate", label: "Reply rate ≥ 50%", status: "unknown", note: "No replies received", link: null },
      { key: "verified", label: "Verified", status: "pass", note: "Verified", link: "https://x.com/i/premium_sign_up" },
      { key: "handle", label: "Handle matches brand", status: "pass", note: "@coupleapp", link: "https://x.com/settings/screen_name" },
    ],
  },
  snapshot_days: 2,
});

const switched = (actions = [makeAction("text_post", {
  id: "ca-1",
  channel_slug: "x_organic",
  title: "Post the three-step rule",
  proposed_at: "2026-09-17T09:30:00Z",
  body: {
    step: {
      body: "Numbered, practical posts are what this audience replies to.",
      effort: "minutes",
      deliverable: { kind: "post", label: "Post", content: "Three steps, in order. Write the problem down first." },
    },
  },
})], more = 0) => ({ actions, more, store: "channel_actions" as const });

beforeEach(() => {
  cleanup();
  window.sessionStorage.clear();
  h.approve.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  h.apiFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  h.refresh.mockReset();
  h.refreshSilent.mockReset();
  h.seed.mockReset();
  h.openTab.mockReset().mockResolvedValue(undefined);
  h.listActions.mockReset().mockResolvedValue({ actions: [], more: 0, store: "decisions" });
  h.listMetrics.mockReset().mockResolvedValue([]);
  h.setAction.mockReset().mockResolvedValue({});
  h.redoAction.mockReset().mockResolvedValue({});
  h.approveAction.mockReset().mockResolvedValue({});
  h.data = payload();
});

async function renderSettled() {
  const r = render(<XAgentDashboard />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return r;
}

describe("the eight", () => {
  it("renders all eight on the shared metric cards, in X's order, with their deltas", () => {
    render(<XAgentDashboard />);
    const region = screen.getByRole("region", { name: "Headline numbers" });
    const keys = Array.from(region.querySelectorAll("[data-metric]")).map((e) => e.getAttribute("data-metric"));
    expect(keys).toEqual(["impressions", "profile_visits", "link_clicks", "new_follows", "replies", "likes", "reposts", "engagement_rate"]);
    expect(within(region).getByText("24.8K")).toBeTruthy();
    expect(within(region).getByText("2.8%")).toBeTruthy();
    expect(screen.getByTestId("delta-impressions").textContent).toBe("+18.2%");
    expect(screen.getByTestId("delta-engagement_rate").textContent).toBe("+0.4pp");
    expect(screen.getByTestId("delta-link_clicks").textContent).toBe("-19.4%");
    expect(screen.getByTestId("delta-link_clicks").getAttribute("data-good")).toBe("false");
  });

  it("shows no delta when history does not cover the previous window", () => {
    render(<XAgentDashboard />);
    expect(screen.queryByTestId("delta-new_follows")).toBeNull();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("says when the numbers are first-day totals rather than a period", () => {
    const p = payload();
    p.metrics = p.metrics.map((m) => ({ ...m, delta: null, basis: "totals" as const }));
    h.data = p;
    render(<XAgentDashboard />);
    expect(screen.getByText(/lifetime totals of posts published in the window/)).toBeTruthy();
  });

  it("keeps a card for a number it could not read, rather than hiding it", () => {
    const p = payload();
    p.metrics = p.metrics.map((m) => ({ ...m, value: null, delta: null, basis: "none" as const }));
    h.data = p;
    render(<XAgentDashboard />);
    const region = screen.getByRole("region", { name: "Headline numbers" });
    expect(within(region).getAllByText("-")).toHaveLength(8);
  });

  it("prefers the metrics endpoint the moment it has rows", async () => {
    h.listMetrics.mockResolvedValue([
      { key: "impressions", value: 1200, unit: "count", window_kind: "7d", day: "2026-09-18", grounded: true, prev_value: 1000, prev_day: "2026-09-11" },
    ]);
    render(<XAgentDashboard />);
    await vi.waitFor(() => expect(screen.getByText("1,200")).toBeTruthy());
    expect(screen.queryByText("24.8K")).toBeNull();
  });
});

describe("Needs your attention", () => {
  it("a manual check gets Open X and Did it — never Fix, because the API cannot write the profile", () => {
    render(<XAgentDashboard />);
    const row = screen.getByText("Bio does not say what Couple App is").closest("div")!.parentElement!;
    const link = within(row).getByRole("link", { name: /Open X/ });
    expect(link.getAttribute("href")).toBe("https://x.com/coupleapp");
    expect(within(row).getByRole("button", { name: "Did it" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Fix" })).toBeNull();
    expect(within(row).getByText("On X · 1 min")).toBeTruthy();
  });

  it("Did it records the dismissal and refetches silently, spending no read", async () => {
    render(<XAgentDashboard />);
    fireEvent.click(screen.getByRole("button", { name: "Did it" }));
    await vi.waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith("/api/channels/x_organic/checks/bio/done", { method: "POST" }));
    await vi.waitFor(() => expect(h.refreshSilent).toHaveBeenCalled());
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("a done check shows Done and no button", () => {
    render(<XAgentDashboard />);
    const row = screen.getByText("Profile picture is the default placeholder").closest("div")!.parentElement!;
    expect(within(row).getByText("Done")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Did it" })).toBeNull();
  });

  it("the agent's own proposal is an approval: Review", async () => {
    await renderSettled();
    const row = screen.getByText("Reply under @lovecoach's thread").closest("div")!.parentElement!;
    expect(within(row).getByRole("button", { name: "Review" })).toBeTruthy();
    expect(within(row).getByText("Needs approval · 2 min")).toBeTruthy();
  });

  it("shows four action items and expands to all of them in place", async () => {
    const p = payload();
    p.attention = Array.from({ length: 9 }, (_, i) => ({ ...p.attention[2], key: `step:${i}`, title: `Action ${i}` }));
    h.data = p;
    await renderSettled();
    const region = screen.getByRole("region", { name: "Needs your attention" });
    expect(within(region).getByText("Action 3")).toBeTruthy();
    expect(within(region).queryByText("Action 4")).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Show more" }));
    expect(within(region).getByText("Action 8")).toBeTruthy();
  });

  it("no longer hops to the Board: an attention row has no Ask Zavi button", () => {
    render(<XAgentDashboard />);
    const region = screen.getByRole("region", { name: "Needs your attention" });
    expect(within(region).queryByRole("button", { name: /Zavi/ })).toBeNull();
    expect(h.openTab).not.toHaveBeenCalled();
    expect(h.seed).not.toHaveBeenCalled();
  });
});

describe("the draft card, on the decisions store", () => {
  it("renders on the shared post card, with the account header", async () => {
    await renderSettled();
    const card = screen.getByTestId("action-d1");
    expect(within(card).getByText("Couple App")).toBeTruthy();
    expect(within(card).getByText(/@coupleapp · /)).toBeTruthy();
    expect(screen.getByTestId("post-text").textContent).toContain("Your first 10 customers");
  });

  it("does not print the handle twice before the first profile read", async () => {
    h.data = { ...payload(), account_name: null };
    await renderSettled();
    const card = screen.getByTestId("action-d1");
    expect(within(card).getAllByText(/@coupleapp/)).toHaveLength(1);
    expect(within(card).queryByText(/@coupleapp · /)).toBeNull();
  });

  it("shows the reason on the card's left side, beside the post", async () => {
    await renderSettled();
    expect(within(screen.getByTestId("split-left")).getByText(/Opens with a hook/)).toBeTruthy();
  });

  it("Post approves the decision as-is, refetches silently, and never approves twice", async () => {
    await renderSettled();
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await vi.waitFor(() => expect(h.approve).toHaveBeenCalledWith("d1", {}));
    await vi.waitFor(() => expect(h.refreshSilent).toHaveBeenCalled());
    expect(h.approve).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("Edit → Post carries the corrected text", async () => {
    await renderSettled();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Edit/ }));
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Shorter." } });
    fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await vi.waitFor(() => expect(h.approve).toHaveBeenCalledWith("d1", { payload_text: "Shorter.", thread: null }));
  });

  it("a recipe step's post is staged, approved, then the step is recorded as done", async () => {
    h.data = { ...payload(), drafts: [{ ...payload().drafts[0], decision_id: "step1", source: "step", label: "Monday post", scheduled_at: null }] };
    h.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, decision_id: "new-card" }) });
    await renderSettled();
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await vi.waitFor(() => expect(h.approve).toHaveBeenCalledTimes(2));
    expect(h.apiFetch).toHaveBeenCalledWith("/api/social/propose", {
      method: "POST",
      body: JSON.stringify({ channel: "x", payload: { text: "Your first 10 customers don't need a perfect product." } }),
      idempotent: true,
    });
    expect(h.approve.mock.calls.map((c) => c[0])).toEqual(["new-card", "step1"]);
  });

  it("an unverified [CONFIRM: …] fact blocks Post until it is edited out", async () => {
    h.data = { ...payload(), drafts: [{ ...payload().drafts[0], text: "[CONFIRM: 10,000+ readers] The number went up." }] };
    await renderSettled();
    expect(screen.getByRole("button", { name: "Post" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Fill the 1 blank above before posting.");
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Edit/ }));
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "12,400 readers. The number went up." } });
    fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
    expect(screen.getByRole("button", { name: "Post" }).hasAttribute("disabled")).toBe(false);
  });

  it("carries no AI edit or Ask Zavi yet: the side chat lands in PR 3, and nothing opens another tab", () => {
    render(<XAgentDashboard />);
    expect(screen.queryByRole("button", { name: /AI edit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ask Zavi/ })).toBeNull();
    expect(h.openTab).not.toHaveBeenCalled();
  });

  it("does not read the ranked endpoint's rows while the channel is on decisions", async () => {
    h.listActions.mockResolvedValue({ actions: [makeAction("text_post", { id: "ca-x" })], more: 0, store: "decisions" });
    await renderSettled();
    await vi.waitFor(() => expect(h.listActions).toHaveBeenCalled());
    expect(screen.getByTestId("action-d1")).toBeTruthy();
    expect(screen.queryByTestId("action-ca-x")).toBeNull();
  });
});

describe("the draft card, on the channel_actions store", () => {
  it("renders the ranked endpoint's cards instead of the payload's drafts", async () => {
    h.listActions.mockResolvedValue(switched());
    render(<XAgentDashboard />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());
    expect(screen.queryByTestId("action-d1")).toBeNull();
    expect(screen.getByTestId("post-text").textContent).toContain("Three steps, in order");
    expect(screen.getByText("Couple App")).toBeTruthy();
  });

  it("Done posts to the channel-actions route with a request id", async () => {
    h.listActions.mockResolvedValue(switched());
    render(<XAgentDashboard />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Done/ }));
    await vi.waitFor(() => expect(h.setAction).toHaveBeenCalledWith("ca-1", { action: "acted", request_id: "req-1" }));
    expect(h.approve).not.toHaveBeenCalled();
  });

  it("Not now sends a snooze date", async () => {
    h.listActions.mockResolvedValue(switched());
    render(<XAgentDashboard />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Not now/ }));
    fireEvent.click(within(screen.getByTestId("snooze-picker")).getByRole("button", { name: "1 week" }));
    await vi.waitFor(() => expect(h.setAction).toHaveBeenCalled());
    expect(h.setAction.mock.calls[0][0]).toBe("ca-1");
    expect(h.setAction.mock.calls[0][1].action).toBe("snoozed");
    expect(typeof h.setAction.mock.calls[0][1].until).toBe("string");
  });

  it("Reject sends the founder's reason", async () => {
    h.listActions.mockResolvedValue(switched());
    render(<XAgentDashboard />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Reject/ }));
    fireEvent.change(screen.getByLabelText("Why are you rejecting it?"), { target: { value: "Off brand" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await vi.waitFor(() => expect(h.setAction).toHaveBeenCalledWith("ca-1", { action: "rejected", note: "Off brand", request_id: "req-1" }));
  });

  it("Redo sends the note to the redo route", async () => {
    h.listActions.mockResolvedValue(switched());
    render(<XAgentDashboard />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Redo/ }));
    fireEvent.change(screen.getByLabelText("What should Zavi do differently?"), { target: { value: "Use last month" } });
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await vi.waitFor(() => expect(h.redoAction).toHaveBeenCalledWith("ca-1", "Use last month"));
  });

  it("offers the rest of the ranked list", async () => {
    h.listActions.mockResolvedValue(switched(undefined, 3));
    render(<XAgentDashboard />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await vi.waitFor(() => expect(h.listActions).toHaveBeenCalledWith("x_organic", { all: true }));
  });

  it("keeps a staged proposal on screen and approves THAT one, staging nothing", async () => {
    const p = payload();
    p.drafts = [{ ...p.drafts[0], decision_id: "staged-only", source: "staged", text: "A post the run already staged." }];
    h.data = p;
    h.listActions.mockResolvedValue(switched());
    render(<XAgentDashboard />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());
    expect(screen.getByTestId("action-staged-only")).toBeTruthy();

    const card = screen.getByTestId("action-staged-only");
    fireEvent.click(within(card).getByRole("button", { name: "Post" }));
    await vi.waitFor(() => expect(h.approve).toHaveBeenCalledWith("staged-only"));
    expect(h.apiFetch.mock.calls.filter((c) => String(c[0]) === "/api/social/propose")).toHaveLength(0);
    expect(h.approve).toHaveBeenCalledTimes(1);
  });

  it("Post on an action whose copy is already staged makes ONE proposal, not two", async () => {
    const p = payload();
    p.drafts = [{ ...p.drafts[0], decision_id: "staged-pair", source: "staged", text: "Three steps, in order. Write the problem down first." }];
    h.data = p;
    h.listActions.mockResolvedValue(switched());
    render(<XAgentDashboard />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());
    expect(screen.queryByTestId("action-staged-pair")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await vi.waitFor(() => expect(h.approve).toHaveBeenCalledWith("staged-pair"));
    expect(h.apiFetch.mock.calls.filter((c) => String(c[0]) === "/api/social/propose")).toHaveLength(0);
    expect(h.approve).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.setAction).toHaveBeenCalledWith("ca-1", { action: "acted", request_id: "req-1" }));
  });

  it("draws no action id in both the card list and Needs your attention", async () => {
    const p = payload();
    p.attention = [
      p.attention[0],
      { key: "step:ca-1", title: "Post the three-step rule", detail: "It is the plan's first step.", mode: "approval", status: "open", effort: "2 min", decision_id: "ca-1", link: null, blocking: false },
    ];
    h.data = p;
    h.listActions.mockResolvedValue(switched());
    render(<XAgentDashboard />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());

    const attention = screen.getByRole("region", { name: "Needs your attention" });
    expect(within(attention).queryByText("Post the three-step rule")).toBeNull();
    expect(within(attention).getByText("Bio does not say what Couple App is")).toBeTruthy();
    expect(screen.getAllByText("Post the three-step rule")).toHaveLength(1);
  });

  it("Post publishes through the connected account, then marks the action done", async () => {
    h.listActions.mockResolvedValue(switched());
    h.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, decision_id: "staged-1" }) });
    render(<XAgentDashboard />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await vi.waitFor(() => expect(h.approve).toHaveBeenCalledWith("staged-1"));
    await vi.waitFor(() => expect(h.setAction).toHaveBeenCalledWith("ca-1", { action: "acted", request_id: "req-1" }));
  });
});

describe("money", () => {
  it("shows the single daily read while it is unspent", () => {
    render(<XAgentDashboard />);
    expect(screen.getByText("1 of 1 reads left today")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Refresh/ }).hasAttribute("disabled")).toBe(false);
  });

  it("shows the allowance and disables Refresh at zero, with the reason", () => {
    h.data = { ...payload(), read_budget: { used: 1, cap: 1, remaining: 0 } };
    render(<XAgentDashboard />);
    expect(screen.getByText("No reads left today")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Refresh/ }).hasAttribute("disabled")).toBe(true);
  });

  it("treats a reached cap as information, not an error", () => {
    h.data = { ...payload(), read: { read: false, error_code: "x_read_cap_reached" } };
    render(<XAgentDashboard />);
    const msg = screen.getByText(/allowance is used up/);
    expect(msg.textContent).toContain("midnight UTC");
    expect(msg.textContent).not.toMatch(/fail|error/i);
  });

  it("changing the range asks for a new window without spending a read", () => {
    render(<XAgentDashboard />);
    expect(h.params).toEqual({ days: "30" });
    fireEvent.click(screen.getByText("Last 7 days"));
    expect(h.params).toEqual({ days: "7" });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("labels the window with its real dates", () => {
    render(<XAgentDashboard />);
    expect(screen.getByText("Last 30 days: Aug 20 – Sep 18, 2026")).toBeTruthy();
  });
});

describe("the table", () => {
  it("lists the top posts with totals and a single attribution line", () => {
    render(<XAgentDashboard />);
    const table = within(screen.getByRole("region", { name: "Top posts" })).getByRole("table");
    expect(within(table).getByText("A first note from the account")).toBeTruthy();
    expect(within(table).getByText("2 posts")).toBeTruthy();
    expect(within(table).getByText("25%")).toBeTruthy();
    expect(screen.getAllByText(/not independently audited/)).toHaveLength(1);
  });
});

describe("the profile checklist", () => {
  it("is the last section, scores out of ten, and never fakes a pass", () => {
    render(<XAgentDashboard />);
    const regions = screen.getAllByRole("region");
    expect(regions[regions.length - 1].getAttribute("aria-label")).toBe("X profile checklist");
    const list = screen.getByRole("region", { name: "X profile checklist" });
    expect(within(list).getByText("5/10")).toBeTruthy();
    expect(within(list).getAllByText("Pass")).toHaveLength(5);
    expect(within(list).getByText("No data yet")).toBeTruthy();
  });

  it("a profile Fix opens x.com; one with nowhere to send you says so instead of hopping to a tab", () => {
    render(<XAgentDashboard />);
    const list = screen.getByRole("region", { name: "X profile checklist" });
    const row = within(list).getByText("Profile picture").closest("tr")!;
    expect(within(row).getByRole("link", { name: "Fix" }).getAttribute("href")).toBe("https://x.com/coupleapp");
    expect(within(list).queryByRole("button", { name: "Fix" })).toBeNull();
  });
});

describe("an older backend's payload", () => {
  it("renders, names the deploy gap, and crashes on nothing", () => {
    h.data = {
      connected: true, handle: "@coupleapp", window_days: 30, read: { read: true }, snapshot_days: 0,
      kpis: { posts: 3 }, next_actions: [], ready_to_post: [], posts: [], daily_views: [],
    } as unknown as XPayload;
    render(<XAgentDashboard />);
    expect(screen.getByText(/has not been redeployed yet/)).toBeTruthy();
    expect(screen.getByText("@coupleapp")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("a list endpoint that is not there yet leaves the panel on the legacy path", async () => {
    h.listActions.mockRejectedValue(new ApiError("HTTP 404", 404));
    await renderSettled();
    expect(screen.getByTestId("action-d1")).toBeTruthy();
    expect(screen.getByText("24.8K")).toBeTruthy();
  });
});

describe("layout", () => {
  it("drafts sit directly under the numbers, before the action items", () => {
    render(<XAgentDashboard />);
    const order = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(order).toEqual(["Headline numbers", "Drafts", "Needs your attention", "Top posts", "X profile checklist"]);
  });

  it("no suggested post is ever text in an action row — only post cards carry one", async () => {
    await renderSettled();
    const attention = screen.getByRole("region", { name: "Needs your attention" });
    expect(within(attention).queryByRole("article")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Drafts" })).getAllByRole("article")).toHaveLength(1);
  });
});

describe("the Analytics tab mode", () => {
  it("shows the numbers and the top posts, and none of the work sections", () => {
    render(<XAgentDashboard variant="analytics" />);
    expect(screen.getByText("Impressions")).toBeTruthy();
    expect(screen.getByText(/Top posts/i)).toBeTruthy();
    expect(screen.queryByText(/Needs your attention/i)).toBeNull();
    expect(screen.queryByLabelText("X profile checklist")).toBeNull();
    expect(screen.queryByTestId("post-text")).toBeNull();
  });

  it("the host's Refresh drives it: no own button, a tick refreshes only while active", () => {
    const { rerender } = render(<XAgentDashboard variant="analytics" refreshTick={0} active />);
    expect(screen.queryByRole("button", { name: /^Refresh$/ })).toBeNull();
    rerender(<XAgentDashboard variant="analytics" refreshTick={1} active={false} />);
    expect(h.refresh).not.toHaveBeenCalled();
    rerender(<XAgentDashboard variant="analytics" refreshTick={2} active />);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("X not connected", () => {
  const step = (over: Record<string, unknown> = {}) => ({
    ...payload(), connected: false, handle: null, account_name: null,
    drafts: [{ ...payload().drafts[0], decision_id: "step1", source: "step", label: "Monday post", scheduled_at: null, ...over }],
  });

  it("hands the post to X's own composer instead of publishing it", async () => {
    h.data = step();
    await renderSettled();
    expect(screen.getByTestId("post-text").textContent).toContain("Your first 10 customers");
    expect(screen.queryByRole("button", { name: "Post" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: /^Copy/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const link = screen.getByRole("link", { name: /Open draft/ }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(xIntentUrl("Your first 10 customers don't need a perfect product."));
    expect(link.target).toBe("_blank");
  });

  it("Done records the step as done and stages nothing", async () => {
    h.data = step();
    await renderSettled();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Done/ }));
    await vi.waitFor(() => expect(h.approve).toHaveBeenCalledWith("step1"));
    expect(h.apiFetch).not.toHaveBeenCalledWith("/api/social/propose", expect.anything());
  });

  it("an unverified [CONFIRM: …] fact blocks the composer link too", async () => {
    h.data = step({ text: "[CONFIRM: 10,000+ readers] The number went up." });
    await renderSettled();
    expect(screen.queryByRole("link", { name: /Open draft/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Open draft" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
