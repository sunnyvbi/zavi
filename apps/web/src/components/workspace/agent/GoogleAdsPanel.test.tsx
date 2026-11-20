// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ApiError } from "@/lib/workspace/channelActionsApi";

const h = vi.hoisted(() => ({
  approve: vi.fn(),
  apiFetch: vi.fn(),
  connect: vi.fn(),
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
vi.mock("@/app/connectors/GoogleAdsConnectButton", () => ({ startGoogleAdsConnect: h.connect }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({ openAgentTab: h.openTab, seedComposer: h.seed, tenantName: "t" }),
}));
vi.mock("../layout/shared", () => ({ useOpenStatic: () => vi.fn(), FOCUS_RING: "" }));
vi.mock("./ScheduleView", () => ({ ScheduleView: () => <div data-testid="schedule-view" /> }));
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

import { GoogleAdsPanel } from "./GoogleAdsPanel";
import { makeAction } from "../actions/__tests__/fixtures";
import type { GadsAction, GadsKpi, GadsPayload } from "./google-ads/types";

const k = (key: GadsKpi["key"], label: string, unit: GadsKpi["unit"], value: number | null, prev: number | null, delta_pct: number | null, delta_abs: number | null, delta_good: boolean | null, extra: Partial<GadsKpi> = {}): GadsKpi => ({
  key, label, unit, value, prev, delta_pct, delta_abs, delta_good, ...extra,
});

const budgetCard: GadsAction = {
  key: "gads:d1",
  decision_id: "d1",
  decision_class: "google_ads.update_campaign_budget_review",
  bucket: "needs_approval",
  title: "Raise the top campaign's budget to $250 a day",
  is_new: true,
  effort_label: "1 min",
  change_sentence: "Zavi changes the daily budget of the top campaign from $180 to $250.",
  evidence: { window_label: "Aug 17 – Sep 15, 2026 · 30 days", tiles: [{ value: "26 of 30", caption: "days the campaign hit its daily cap" }], reasoning: "It is the cheapest source of booked work." },
  exact_change: { rows: [{ item: "Top campaign daily budget", before: "$180/day", after: "$250/day" }] },
  estimate: { tiles: [{ value: "≈ 39", caption: "more results a month" }] },
  link: "https://ads.google.com/aw/campaigns?__c=1&campaignId=1",
  applied_at: null,
};

const legacyCard: GadsAction = {
  ...budgetCard,
  key: "gads:d2",
  decision_id: "d2",
  title: "Pause campaign 7",
  is_new: false,
  change_sentence: null,
  evidence: null,
  exact_change: null,
  estimate: null,
  link: null,
};

const stepCard: GadsAction = {
  ...legacyCard,
  key: "step:d3",
  decision_id: "d3",
  decision_class: "channel.recipe_step",
  bucket: "needs_you",
  title: "Send booked value back to Google Ads",
  effort_label: "about an hour",
};

const payload = (): GadsPayload => ({
  connected: true,
  error_code: null,
  window_days: 30,
  period: { from: "2026-08-17", to: "2026-09-15" },
  prev_period: { from: "2026-07-18", to: "2026-08-16" },
  account: { name: "The main account", customer_id: "123-456-7890", campaign_count: 2 },
  kpis: [
    k("spend", "Spend", "usd", 18420, 16446, 12, 1974, null),
    k("conversions", "Conversions", "count", 338, 319, 6, 19, true, { conversions: { calls: 197, forms: 141, other: 0 } }),
    k("cpa", "Cost per conversion", "usd", 54.51, 57.61, -5.4, -3.1, true),
    k("conv_value", "Conversion value", "usd", 57400, 50000, 14.8, 7400, true, { partial: true }),
    k("roas", "ROAS", "ratio", 3.12, 3.04, 2.6, 0.08, true, { floor: true }),
    k("pacing", "Spend vs plan", "pct", 94, null, null, null, null, { pacing: { spend: 18420, plan: 19600, plan_basis: "auto", pct: 94, capped_campaigns: 3, campaigns: 7, days_elapsed: 15, days_in_month: 30 } }),
  ],
  campaigns: [
    { id: "1", name: "Top campaign", status: "ENABLED", limited_by_budget: true, spend: 5240, conversions: 128, cpa: 40.94, conv_value: 22300, url: null },
    { id: "2", name: "Second campaign", status: "ENABLED", limited_by_budget: false, spend: 0, conversions: 0, cpa: null, conv_value: 0, url: null },
  ],
  totals: { campaigns: 2, spend: 18420, conversions: 338, cpa: 54.5, conv_value: 57400, roas: 3.12 },
  actions: [budgetCard, legacyCard, stepCard],
  counts: { all: 3, needs_you: 3, autonomous: 0 },
  actions_more: 0,
});

const execCard = () =>
  makeAction("update_ad", {
    id: "ca-1",
    channel_slug: "google_ads",
    title: "Raise the budget on the campaign that is capped",
    executable: true,
    body: {
      change_sentence: "Zavi raises the daily budget from $40 to $55.",
      exact_change: { rows: [{ item: "Daily budget", before: "$40", after: "$55" }] },
      decision_evidence: { stats: [{ value: "26 of 30", caption: "days the budget ran out" }] },
      link: "https://ads.google.com/aw/campaigns",
    },
  });

const switched = (actions = [execCard()], more = 0) => ({ actions, more, store: "channel_actions" as const });

beforeEach(() => {
  cleanup();
  h.approve.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  h.apiFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  h.connect.mockReset();
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

describe("the headline numbers", () => {
  it("asks for the selected range", () => {
    render(<GoogleAdsPanel />);
    expect(h.params).toEqual({ days: "30" });
  });

  it("draws spend, cost per result and pacing big, the rest as a grid", () => {
    const { container } = render(<GoogleAdsPanel />);
    const rows = screen.getAllByTestId("summary-row");
    expect(rows[0].getAttribute("data-variant")).toBe("spend");
    expect(Array.from(rows[0].querySelectorAll("[data-metric]")).map((e) => e.getAttribute("data-metric"))).toEqual(["spend", "cpa", "pacing"]);
    expect(rows[1].getAttribute("data-variant")).toBe("grid");
    expect(Array.from(rows[1].querySelectorAll("[data-metric]")).map((e) => e.getAttribute("data-metric"))).toEqual(["conversions", "conv_value", "roas"]);
    expect(container.querySelectorAll("[data-metric]")).toHaveLength(6);
  });

  it("prints the values and colours a cost-per-conversion DROP green", () => {
    render(<GoogleAdsPanel />);
    const rows = screen.getAllByTestId("summary-row");
    expect(within(rows[0]).getByText("$54.51")).toBeTruthy();
    expect(within(rows[0]).getByText("$18,420")).toBeTruthy();
    expect(within(rows[1]).getByText("3.12×")).toBeTruthy();
    const cpa = screen.getByTestId("delta-cpa");
    expect(cpa.textContent).toContain("$3.10");
    expect(cpa.getAttribute("data-good")).toBe("true");
    expect(within(rows[0]).getByText(/94%/)).toBeTruthy();
    expect(within(rows[0]).getByText(/\$18,420 of \$19,600/)).toBeTruthy();
  });

  it("keeps the monthly plan and its editor", async () => {
    render(<GoogleAdsPanel />);
    const plan = screen.getByTestId("monthly-plan");
    expect(within(plan).getByText(/\$18,420 of \$19,600 this month/)).toBeTruthy();
    expect(within(plan).getByText(/3 of 7 campaigns spent their full daily budget on most days/)).toBeTruthy();
    fireEvent.click(within(plan).getByRole("button", { name: /Edit plan/ }));
    fireEvent.change(screen.getByLabelText("Monthly plan in dollars"), { target: { value: "21000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() =>
      expect(h.apiFetch).toHaveBeenCalledWith("/api/channels/google_ads/monthly-budget", { method: "PUT", body: JSON.stringify({ usd: 21000 }) }),
    );
  });

  it("prefers the metrics endpoint the moment it has rows", async () => {
    h.listMetrics.mockResolvedValue([
      { key: "spend", value: 900, unit: "usd", window_kind: "7d", day: "2026-09-18", grounded: true, prev_value: 800, prev_day: "2026-09-11" },
    ]);
    render(<GoogleAdsPanel />);
    await vi.waitFor(() => expect(screen.getByText("$900")).toBeTruthy());
    const rows = screen.getAllByTestId("summary-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).queryByText("$18,420")).toBeNull();
  });
});

describe("the dashboard around the cards", () => {
  it("keeps the account strip and the campaign table", () => {
    render(<GoogleAdsPanel />);
    expect(screen.getByText(/Google Ads · The main account/)).toBeTruthy();
    expect(screen.getByText("Limited")).toBeTruthy();
    const totals = screen.getByTestId("totals-row");
    expect(within(totals).getByText("2 campaigns")).toBeTruthy();
    expect(within(totals).getByText("ROAS 3.12×")).toBeTruthy();
    const second = screen.getByText("Second campaign").closest("tr")!;
    expect(within(second).getByText("-")).toBeTruthy();
  });
});

async function renderSettled() {
  const r = render(<GoogleAdsPanel />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return r;
}

const approveButton = (card: HTMLElement) => card.querySelector("button[data-approve]") as HTMLButtonElement | null;

const closeCard = (card: HTMLElement) => fireEvent.click(within(card).getByRole("button", { name: /^Close “/ }));

describe("the cards, on the decisions store", () => {
  it("renders each open action on the shared card, with its evidence and exact change", async () => {
    await renderSettled();
    const card = screen.getByTestId("action-d1");
    expect(card.getAttribute("data-action-type")).toBe("update_ad");
    expect(within(card).getByText("26 of 30 days the campaign hit its daily cap")).toBeTruthy();
    const change = within(card).getByTestId("exact-change");
    expect(within(change).getByText("$180/day")).toBeTruthy();
    expect(within(change).getByText("$250/day")).toBeTruthy();
    expect(within(card).getByText(/New/)).toBeTruthy();
    expect(card.querySelector("input, textarea")).toBeNull();
  });

  it("approving sends only the decision id, through the old rail", async () => {
    await renderSettled();
    const card = screen.getByTestId("action-d1");
    const go = approveButton(card)!;
    expect(go.textContent?.trim()).toBe("Apply change");
    fireEvent.click(go);
    await vi.waitFor(() => expect(h.approve).toHaveBeenCalledWith("d1"));
    expect(h.approveAction).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.refreshSilent).toHaveBeenCalled());
  });

  it("closing a card posts to the reject route", async () => {
    await renderSettled();
    closeCard(screen.getByTestId("action-d1"));
    await vi.waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith("/api/approvals/d1/reject", { method: "POST" }));
  });

  it("a recipe step is not executable: mark it done, never approve it", async () => {
    await renderSettled();
    const card = screen.getByTestId("action-d3");
    expect(card.getAttribute("data-action-type")).toBe("other");
    expect(within(card).queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(card.querySelector("button[data-approve]")).toBeNull();
    expect(within(card).getByRole("button", { name: /I did this/ })).toBeTruthy();
  });

  it("an already-applied change is history, not a card with an Approve on it", async () => {
    const d = payload();
    d.actions = [{ ...budgetCard, key: "gads:d9", decision_id: "d9", bucket: "autonomous", applied_at: "2026-09-15T10:00:00Z" }];
    d.counts = { all: 1, needs_you: 0, autonomous: 1 };
    h.data = d;
    await renderSettled();
    expect(screen.queryByTestId("action-d9")).toBeNull();
    expect(screen.getByText(/Nothing waiting right now/)).toBeTruthy();
  });

  it("an older card with no evidence renders its title and buttons only", async () => {
    await renderSettled();
    const card = screen.getByTestId("action-d2");
    expect(within(card).getByText("Pause campaign 7")).toBeTruthy();
    expect(within(card).queryByTestId("exact-change")).toBeNull();
    expect(within(card).queryByText("Why this")).toBeNull();
    expect(approveButton(card)).toBeTruthy();
  });

  it("invents no score for a row that has none", () => {
    render(<GoogleAdsPanel />);
    expect(screen.queryByTestId("action-score")).toBeNull();
  });

  it("no longer hops to the Board: no Ask Zavi until the side chat lands", () => {
    render(<GoogleAdsPanel />);
    expect(screen.queryByRole("button", { name: /Ask Zavi/ })).toBeNull();
    expect(h.openTab).not.toHaveBeenCalled();
    expect(h.seed).not.toHaveBeenCalled();
  });

  it("0 actions: a calm empty line", async () => {
    h.data = { ...payload(), actions: [], counts: { all: 0, needs_you: 0, autonomous: 0 } };
    await renderSettled();
    expect(screen.getByText(/Nothing waiting right now/)).toBeTruthy();
  });
});

describe("the cards, on the channel_actions store", () => {
  it("renders the ranked endpoint's cards instead of the payload's actions", async () => {
    h.listActions.mockResolvedValue(switched());
    render(<GoogleAdsPanel />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());
    expect(screen.queryByTestId("action-d1")).toBeNull();
    const change = within(screen.getByTestId("action-ca-1")).getByTestId("exact-change");
    expect(within(change).getByText("$40")).toBeTruthy();
    expect(within(change).getByText("$55")).toBeTruthy();
  });

  it("approving runs the executable change through the channel-actions route", async () => {
    h.listActions.mockResolvedValue(switched());
    render(<GoogleAdsPanel />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());
    fireEvent.click(approveButton(screen.getByTestId("action-ca-1"))!);
    await vi.waitFor(() => expect(h.approveAction).toHaveBeenCalledWith("ca-1", "req-1"));
    expect(h.approve).not.toHaveBeenCalled();
  });

  it("closing a card rejects it on the channel-actions route", async () => {
    h.listActions.mockResolvedValue(switched());
    render(<GoogleAdsPanel />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());
    closeCard(screen.getByTestId("action-ca-1"));
    await vi.waitFor(() =>
      expect(h.setAction).toHaveBeenCalledWith("ca-1", expect.objectContaining({ action: "rejected", request_id: "req-1" })),
    );
  });

  it("locks the card while an approved change is on its way", async () => {
    h.listActions.mockResolvedValue(switched([{ ...execCard(), id: "ca-2", exec_status: "queued" }]));
    render(<GoogleAdsPanel />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-2")).toBeTruthy());
    const card = screen.getByTestId("action-ca-2");
    expect(within(card).getByTestId("exec-state").getAttribute("data-exec")).toBe("queued");
    expect(approveButton(card)).toBeNull();
    expect(card.querySelectorAll("button")).toHaveLength(0);
  });

  it("offers the rest of the ranked list", async () => {
    h.listActions.mockResolvedValue(switched(undefined, 4));
    render(<GoogleAdsPanel />);
    await vi.waitFor(() => expect(screen.getByTestId("action-ca-1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await vi.waitFor(() => expect(h.listActions).toHaveBeenCalledWith("google_ads", { all: true }));
  });
});

describe("connection states", () => {
  it("not connected: a Connect button, no numbers", () => {
    h.data = { ...payload(), connected: false, error_code: "not_connected", kpis: [], campaigns: [], actions: [], counts: { all: 0, needs_you: 0, autonomous: 0 } };
    const { container } = render(<GoogleAdsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(h.connect).toHaveBeenCalled();
    expect(container.querySelector("[data-metric]")).toBeNull();
  });

  it("token revoked: a Reconnect banner, and the cards stay", async () => {
    h.data = { ...payload(), error_code: "google_ads_token_revoked", kpis: [], campaigns: [], totals: null };
    await renderSettled();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(h.connect).toHaveBeenCalled();
    expect(screen.getByTestId("action-d1")).toBeTruthy();
  });

  it("a list endpoint that is not there yet leaves the panel on the legacy path", async () => {
    h.listActions.mockRejectedValue(new ApiError("HTTP 404", 404));
    await renderSettled();
    expect(screen.getByTestId("action-d1")).toBeTruthy();
    expect(within(screen.getAllByTestId("summary-row")[0]).getByText("$18,420")).toBeTruthy();
  });
});
