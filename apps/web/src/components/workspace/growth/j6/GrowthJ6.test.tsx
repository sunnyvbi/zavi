// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GrowthPlanPayload } from "@/lib/workspace/useGrowthPlan";

type Reply = { status?: number; body?: unknown };
const m = vi.hoisted(() => ({
  routes: {} as Record<string, Reply>,
  fetch: vi.fn(),
  reconnect: vi.fn(async () => {}),
  openTab: vi.fn(),
  billing: vi.fn(),
  track: vi.fn(),
  role: "owner" as string | null,
}));
m.fetch.mockImplementation(async (path: string) => {
  const key = Object.keys(m.routes).find((k) => path.split("?")[0] === k.split("?")[0]);
  const r = key ? m.routes[key] : { status: 404, body: { error: { message: "not found" } } };
  const status = r.status ?? 200;
  return { ok: status < 300, status, json: async () => r.body ?? {}, clone() { return this; } };
});
vi.mock("@/lib/api", () => ({ apiFetch: m.fetch }));
vi.mock("../../settings/reconnectFlows", () => ({ startReconnectFlow: m.reconnect }));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({ tenantName: "Fernway", tenantId: "t1", role: m.role, openTab: m.openTab }),
}));
vi.mock("@/lib/workspace/openBilling", () => ({ openBillingSettings: m.billing }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: m.track }));
vi.mock("@/lib/marketing/pricing", () => ({
  fetchLivePricingClient: async () => ({ tiers: [] }),
  liveTier: () => ({ slug: "starter", usd: 20 }),
}));

import { GrowthJ6 } from "./GrowthJ6";

const EMPTY: GrowthPlanPayload = {
  plan: null,
  bets: [],
  goals: { max_active: null, active_count: 0, over_cap: false, items: [] },
  metrics: [],
  channels: [],
  changes: [],
  unreadable: [],
};

const PLAN: GrowthPlanPayload = {
  ...EMPTY,
  plan: {
    id: "p1",
    source: "typed",
    pending_acceptance: false,
    objective: "Grow",
    north_star_metric: null,
    constraint_lever_family: "demand",
    constraint_statement: "Salon owners who would pay haven't heard of Fernway yet.",
    constraint_confidence: "low",
    basis_evidence: [],
    version: 1,
    updated_at: null,
  },
  bets: [
    {
      id: "b1",
      channel_slug: "linkedin_organic",
      intent: "Post weekly",
      rationale: "Salon owners are the buyers.",
      expected_effect: null,
      falsifier: "6 weeks and no salon owner replies",
      status: "accepted",
      rejected_reason: null,
      sort_order: 1,
      result: { line: "12 replies · LinkedIn's count", label: "measured", source: null },
    },
  ],
  channels: [
    { slug: "linkedin_organic", last_run_at: null, last_run_status: null, metric_keys: [], metric_availability: "none", autorun: true, autorun_set_by: "", plan_selected: true, plan_selected_set_by: "plan" },
    { slug: "instagram_organic", last_run_at: null, last_run_status: null, metric_keys: [], metric_availability: "none", autorun: true, autorun_set_by: "", plan_selected: true, plan_selected_set_by: "plan" },
    { slug: "tiktok_ads", last_run_at: null, last_run_status: null, metric_keys: [], metric_availability: "none", autorun: false, autorun_set_by: "", plan_selected: false, plan_selected_set_by: "founder_stopped" },
  ],
  goals: {
    max_active: 3,
    active_count: 1,
    over_cap: false,
    items: [
      {
        id: "g1",
        objective: "40 new paying customers",
        target_metric: "new_paying_customers",
        target_value: 40,
        baseline_value: 0,
        current_value: 11,
        due_date: "2026-11-30",
        status: "active",
        priority: 50,
        source: "founder",
        falsifier: null,
        status_changed_by: null,
        status_changed_at: null,
        current_value_at: "2026-10-22T10:00:00Z",
      },
    ],
  },
  head_of_growth: { autopilot: true, note: null, undoable: [] },
};

const HYP = (id: string, status: "listed" | "testing" | "confirmed" | "ruled_out", claim: string) => ({ id, claim, status, evidence: [] });

const card = (over: Record<string, unknown>) => ({
  source: "channel_action",
  channel_slug: "x_organic",
  kind: "post",
  body: "No-shows cost a groomer a slot a day.",
  why: null,
  where: "X",
  card_kind: null,
  primary_label: null,
  amount: null,
  effect: null,
  tone: null,
  snoozed_until: null,
  created_at: "2026-10-24T00:00:00Z",
  ...over,
});

const posts = (path: string) =>
  m.fetch.mock.calls
    .filter(([p, init]) => p === path && (init as RequestInit | undefined)?.method)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body ?? "{}")) as Record<string, unknown>);

beforeEach(() => {
  m.role = "owner";
  m.fetch.mockClear();
  m.reconnect.mockClear();
  m.routes = {};
});
afterEach(cleanup);

describe("GrowthJ6 empty states", () => {
  it("renders all four steps with neutral values when nothing is there and every side read fails", async () => {
    render(<GrowthJ6 data={EMPTY} onChanged={async () => {}} />);
    expect(screen.getByText("Growth brief for Fernway · From Zavi")).toBeTruthy();
    expect(screen.getByText("No goal yet.")).toBeTruthy();
    for (const step of ["Pick your goal", "The plan", "Today", "Done & results"]) {
      expect(screen.getByRole("region", { name: step })).toBeTruthy();
    }
    await waitFor(() => expect(screen.getByText(/Couldn't load today's list yet/)).toBeTruthy());
    expect(screen.getByText("Tests, last 30 days: not read yet")).toBeTruthy();
    expect(screen.getByText("Ad money: not read yet")).toBeTruthy();
    expect(screen.getByText("No plan yet.")).toBeTruthy();
    expect(screen.getByText(/Also helping:/)).toBeTruthy();
    expect(screen.getByText("Not using")).toBeTruthy();
  });

  it("while the first plan is written, it neither asks for a goal nor lists every channel as not used", () => {
    render(<GrowthJ6 data={EMPTY} drafting onChanged={async () => {}} />);
    expect(screen.getByText("Zavi is setting your goal.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Your goal" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New paying customers" })).toBeNull();
    expect(screen.getByText("Not using").parentElement?.textContent).toContain("Zavi is still choosing.");
    expect(screen.queryByRole("button", { name: "Use it" })).toBeNull();
  });

  it("brings the goal picker back when the plan could not finish", () => {
    render(<GrowthJ6 data={EMPTY} drafting draftFailed onChanged={async () => {}} />);
    expect(screen.getByText("No goal yet.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Pick your goal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New paying customers" })).toBeTruthy();
  });

  it("asks for the number when a goal has none, and saves it to the goal", async () => {
    m.routes["/api/workspace/autopilot/goals/g1"] = { body: {} };
    const data = { ...PLAN, goals: { ...PLAN.goals, items: [{ ...PLAN.goals.items[0], current_value: null }] } };
    const onChanged = vi.fn(async () => {});
    render(<GrowthJ6 data={data} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText("How many so far?"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "See if I'm on track" }));
    await waitFor(() => expect(posts("/api/workspace/autopilot/goals/g1")).toEqual([{ current_value: 7 }]));
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("GrowthJ6 plan controls", () => {
  const renderPlan = (data = PLAN) => render(<GrowthJ6 data={data} onChanged={async () => {}} />);

  it("Sounds right agrees with Zavi's guess", async () => {
    m.routes["/api/workspace/growth/constraint/agree"] = { body: {} };
    renderPlan();
    expect(screen.getByText("not tested yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sounds right" }));
    await waitFor(() => expect(posts("/api/workspace/growth/constraint/agree")).toEqual([{}]));
  });

  it("Not quite… saves the founder's view as the diagnosis", async () => {
    m.routes["/api/workspace/growth/constraint/founder"] = { body: {} };
    renderPlan();
    fireEvent.click(screen.getByRole("button", { name: "Not quite…" }));
    fireEvent.change(screen.getByLabelText("What do you think it is?"), { target: { value: "  Our price page confuses people  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts("/api/workspace/growth/constraint/founder")).toEqual([{ text: "Our price page confuses people" }]));
  });

  it("shows the founder's view with Zavi's standing guess underneath, and Switch to Zavi's redrafts around it", async () => {
    m.routes["/api/workspace/growth/constraint/switch"] = { body: { run_id: "r7" } };
    const onDraftStarted = vi.fn();
    const data = {
      ...PLAN,
      plan: { ...PLAN.plan!, constraint_statement: "Our price page confuses people", founder_constraint: "Our price page confuses people" },
      goal_work: { g1: { status_line: null, status_at: null, moves: [], hypotheses: [HYP("h-old", "ruled_out", "Old idea"), HYP("h2", "testing", "Salon owners haven't heard of Fernway.")] } },
    };
    render(<GrowthJ6 data={data} onChanged={async () => {}} onDraftStarted={onDraftStarted} />);
    expect(screen.getByText("Your view:")).toBeTruthy();
    expect(screen.getByText(/Salon owners haven't heard of Fernway\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch to Zavi's" }));
    await waitFor(() => expect(posts("/api/workspace/growth/constraint/switch")).toEqual([{ hypothesis_id: "h2" }]));
    await waitFor(() => expect(onDraftStarted).toHaveBeenCalledWith("r7"));
  });

  it("with no standing guess, the founder can clear their view", async () => {
    m.routes["/api/workspace/growth/constraint/founder"] = { body: {} };
    renderPlan({ ...PLAN, plan: { ...PLAN.plan!, founder_constraint: "Our price page confuses people" } });
    expect(screen.queryByRole("button", { name: "Switch to Zavi's" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear my view" }));
    await waitFor(() => expect(posts("/api/workspace/growth/constraint/founder")).toEqual([{ text: null }]));
  });

  it("a conflict offers Keep mine and Switch to Zavi's, and the switch starts a redraft", async () => {
    m.routes["/api/workspace/growth/conflicts/h1/keep"] = { body: { kept_at: "2026-10-24T00:00:00Z" } };
    m.routes["/api/workspace/growth/constraint/switch"] = { body: { run_id: "r9" } };
    const onDraftStarted = vi.fn();
    render(
      <GrowthJ6
        data={{
          ...PLAN,
          constraint_conflicts: [{ goal_id: "g1", hypothesis_id: "h1", claim: "Not enough renters reach Upcar.", kept_at: null }],
          goal_work: { g1: { status_line: null, status_at: null, moves: [], hypotheses: [HYP("h1", "ruled_out", "Not enough renters reach Upcar."), HYP("h3", "listed", "Hosts cancel renters who booked.")] } },
        }}
        onChanged={async () => {}}
        onDraftStarted={onDraftStarted}
      />,
    );
    expect(screen.getByText(/Hosts cancel renters who booked\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(posts("/api/workspace/growth/conflicts/h1/keep")).toEqual([{ kept: true }]));
    fireEvent.click(screen.getByRole("button", { name: "Switch to Zavi's" }));
    await waitFor(() => expect(posts("/api/workspace/growth/constraint/switch")).toEqual([{ hypothesis_id: "h3" }]));
    await waitFor(() => expect(onDraftStarted).toHaveBeenCalledWith("r9"));
  });

  it("Stop this channel now takes a Zavi pick out of the plan, and Undo puts it back", async () => {
    m.routes["/api/workspace/growth/channels/linkedin_organic/plan"] = { body: {} };
    renderPlan();
    expect(screen.getByText(/12 replies/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "When it stops" }));
    expect(screen.getByText(/Zavi drops it if: 6 weeks and no salon owner replies\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop this channel now" }));
    await waitFor(() => expect(posts("/api/workspace/growth/channels/linkedin_organic/plan")).toEqual([{ in_plan: false }]));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(posts("/api/workspace/growth/channels/linkedin_organic/plan")).toEqual([{ in_plan: false }, { in_plan: true }]));
  });

  it("lists a stopped channel under Not using, and Use it turns it back on", async () => {
    m.routes["/api/workspace/growth/channels/tiktok_ads/plan"] = { body: {} };
    renderPlan();
    expect(document.querySelector('[data-why="stopped by you"]')?.textContent).toContain("TikTok Ads");
    expect(screen.getByText(/Also helping:/).closest("[data-section=helping]")?.textContent).toContain("Instagram");
    fireEvent.click(screen.getByRole("button", { name: /^Use TikTok Ads/ }));
    await waitFor(() => expect(posts("/api/workspace/growth/channels/tiktok_ads/plan")).toEqual([{ in_plan: true }]));
  });

  it("Also helping: × stops a channel, and the section collapses", async () => {
    m.routes["/api/workspace/growth/channels/instagram_organic/plan"] = { body: {} };
    renderPlan();
    fireEvent.click(screen.getByRole("button", { name: "Stop Instagram" }));
    await waitFor(() => expect(posts("/api/workspace/growth/channels/instagram_organic/plan")).toEqual([{ in_plan: false }]));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Also helping" }));
    expect(screen.queryByRole("list", { name: "Channels also helping" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show Also helping" }));
    expect(screen.getByRole("list", { name: "Channels also helping" }).textContent).toContain("Instagram");
  });

  it("Not using lists every other channel, filters it by Paid and Organic with counts, and + adds one", async () => {
    m.routes["/api/workspace/growth/channels/seo/plan"] = { body: {} };
    renderPlan();
    const list = () => screen.getByRole("list", { name: "Channels not in use" });
    expect(screen.getByRole("tab", { name: /^Paid/ }).getAttribute("aria-selected")).toBe("true");
    const all = screen.getByRole("tab", { name: /^All/ });
    fireEvent.click(all);
    expect(all.textContent).toMatch(/^All\(\d+\)$/);
    const names = within(list()).getAllByRole("listitem").map((li) => li.textContent);
    expect(names).toEqual([...names].sort((a, b) => a!.localeCompare(b!)));
    fireEvent.click(screen.getByRole("tab", { name: /^Paid/ }));
    expect(within(list()).queryByRole("button", { name: "Use SEO" })).toBeNull();
    expect(within(list()).getByRole("button", { name: /^Use TikTok Ads/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^Organic/ }));
    expect(within(list()).queryByRole("button", { name: /^Use TikTok Ads/ })).toBeNull();
    fireEvent.click(within(list()).getByRole("button", { name: "Use SEO" }));
    await waitFor(() => expect(posts("/api/workspace/growth/channels/seo/plan")).toEqual([{ in_plan: true }]));
  });
});

describe("GrowthJ6 today", () => {
  it("Not now snoozes a card into Later, and Undo reopens it", async () => {
    m.routes["/api/workspace/growth/open-cards"] = { body: { items: [card({ id: "c1", title: "Post a no-shows tip" })] } };
    m.routes["/api/channel-actions/c1"] = { body: { ok: true } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    expect(await screen.findByText("Post a no-shows tip")).toBeTruthy();
    expect(screen.getByText("Do this first")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(await screen.findByText("Later: Post a no-shows tip")).toBeTruthy();
    expect(posts("/api/channel-actions/c1")[0]).toMatchObject({ action: "snoozed" });
    const later = screen.getByText("Later: Post a no-shows tip").parentElement!;
    fireEvent.click(within(later).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(posts("/api/channel-actions/c1")[1]).toMatchObject({ action: "open" }));
    expect(await screen.findByRole("button", { name: "Copy & open X" })).toBeTruthy();
  });

  it("Copy & open asks 'Posted it?': Yes marks it acted, Not yet keeps it", async () => {
    m.routes["/api/workspace/growth/open-cards"] = { body: { items: [card({ id: "c2", title: "Post the Saturday tip" })] } };
    m.routes["/api/channel-actions/c2"] = { body: { ok: true } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy & open X" }));
    expect(screen.getByText("Posted it?")).toBeTruthy();
    await waitFor(() => expect(posts("/api/workspace/growth/cards/c2/copied")).toEqual([{ source: "channel_action" }]));
    fireEvent.click(screen.getByRole("button", { name: "Not yet" }));
    expect(posts("/api/channel-actions/c2")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Copy & open X" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, it's live" }));
    await waitFor(() => expect(posts("/api/channel-actions/c2")[0]).toMatchObject({ action: "acted" }));
  });

  it("a two-option question sends the pick as text", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: { items: [card({ id: "q1", source: "decision", kind: "question", channel_slug: null, body: null, title: "Who should Zavi write for?", options: ["Solo", "Salons"] })] },
    };
    m.routes["/api/workspace/growth/questions/q1/answer"] = { body: {} };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Salons" }));
    await waitFor(() => expect(posts("/api/workspace/growth/questions/q1/answer")).toEqual([{ answer: { text: "Salons" } }]));
  });

  it("a check card records what the founder found", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: { items: [card({ id: "d1", source: "decision", kind: "check", tone: "danger", channel_slug: "linkedin_ads", body: null, title: "A LinkedIn campaign may be spending by mistake" })] },
    };
    m.routes["/api/workspace/decisions/d1/check"] = { body: { ok: true } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Check" }));
    fireEvent.click(screen.getByRole("button", { name: "Nothing is live" }));
    await waitFor(() => expect(posts("/api/workspace/decisions/d1/check")).toEqual([{ went_through: false }]));
  });

  it("shows where the ad money goes under the headline", async () => {
    m.routes["/api/workspace/ad-budget/channels"] = {
      body: {
        month_start: "2026-10-01",
        today: "2026-10-31",
        spend_through: "2026-10-31",
        rows: [{ platform: "meta", name: "Meta Ads", spent_usd: 500, share: 1, last7_usd: 100, prev7_usd: 50, change: 1, results: null, results_status: "unavailable", spend_read_failed: false }],
        total: { spent_usd: 500, last7_usd: 100, prev7_usd: 50, change: 1 },
        budget: null,
        results_read_at: null,
      },
    };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    const table = await screen.findByTestId("money-table");
    expect(within(table).getByTestId("money-row-meta").textContent).toContain("$500.00");
  });

  it("the approve dialog takes the amount, the spend and the runs-out date from the one forecast", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(2026, 9, 10, 9) });
    m.routes["/api/workspace/growth/open-cards"] = {
      body: { items: [card({ id: "s1", source: "decision", kind: "spend", channel_slug: "google_ads", body: null, title: "Raise the campaign that books most", amount: 50, effect: "Raise “Sales Search” from $100 to $150 a day" })] },
    };
    m.routes["/api/workspace/ad-budget"] = {
      body: {
        budget: { id: "ab1", status: "active", monthly_usd: 3000, daily_limit_usd: null, month_cap_usd: 3000, spent_usd: 2000, held_usd: 400, left_usd: 600, next_month_start: "", days_left: 6 },
        can_manage: true,
        pro: true,
        forecast: { daily_usd: 100, runs_out_on: "2026-10-16", projected_month_usd: 2900 },
      },
    };
    m.routes["/api/approvals/s1/approve"] = { body: { ok: true } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    try {
      expect(await screen.findByText(/runs out about Oct 16/)).toBeTruthy();
      fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toContain("+$50/day");
      expect(dialog.textContent).toContain("Raise “Sales Search” from $100 to $150 a day");
      expect(dialog.textContent).toContain("About $1,100 more spend by Oct 31 (estimate).");
      expect(dialog.textContent).toContain("Ad money then runs out about Oct 14, 2 days sooner (estimate).");
      fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(m.fetch.mock.calls.some(([p]) => String(p).startsWith("/api/approvals/s1/approve"))).toBe(true));
    } finally {
      vi.useRealTimers();
    }
  });

  it("a ?decision= link puts that card first, scrolls to it and flashes it", async () => {
    const scrolled: string[] = [];
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
    const before = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.getAttribute("data-j6-card") ?? "");
    };
    try {
      m.routes["/api/workspace/growth/open-cards"] = {
        body: {
          items: [
            card({ id: "c-quick", kind: "question", source: "decision", body: null, channel_slug: null, title: "A quick question" }),
            card({ id: "c-link", kind: "task", body: "Settings → Email", title: "The card from the email", snoozed_until: "2026-12-01T00:00:00Z" }),
          ],
        },
      };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} focusDecisionId="c-link" />);
      await waitFor(() => expect(scrolled).toContain("c-link"));
      const first = screen.getByRole("region", { name: "Do this first" }).querySelector("[data-j6-card]") as HTMLElement;
      expect(first.getAttribute("data-j6-card")).toBe("c-link");
      expect(within(first).getByText("The card from the email")).toBeTruthy();
      expect(screen.queryByText("That card was already handled.")).toBeNull();
    } finally {
      proto.scrollIntoView = before;
    }
  });

  it("a ?decision= link to a card that is no longer open says so and stays on New", async () => {
    m.routes["/api/workspace/growth/open-cards"] = { body: { items: [card({ id: "c1", title: "Post a no-shows tip" })] } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} focusDecisionId="gone-id" />);
    expect(await screen.findByText("That card was already handled.")).toBeTruthy();
    expect(screen.getByText("Post a no-shows tip")).toBeTruthy();
    expect(document.querySelector('[data-growth-view="new"]')).not.toBeNull();
  });

  it("Undo on a decision the server holds as snoozed calls unsnooze", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: { items: [card({ id: "d9", source: "decision", kind: "plan", body: null, title: "Approve Zavi's next move", primary_label: "Approve", snoozed_until: "2026-12-01T00:00:00Z" })] },
    };
    m.routes["/api/approvals/d9/unsnooze"] = { body: { ok: true, changed: true } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    const later = (await screen.findByText("Later: Approve Zavi's next move")).parentElement!;
    fireEvent.click(within(later).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(posts("/api/approvals/d9/unsnooze")).toEqual([{}]));
    expect(await screen.findByRole("button", { name: "Looks good" })).toBeTruthy();
  });

  it("a broken connection in the cgo note becomes a Reconnect card first in Today", async () => {
    m.routes["/api/workspace/growth/open-cards"] = { body: { items: [card({ id: "c1", title: "Post a no-shows tip" })] } };
    const data = {
      ...PLAN,
      head_of_growth: {
        autopilot: true,
        undoable: [],
        note: {
          saw: [], changed: [], would_change: [], need: [], created_at: "", next_review_at: "",
          sections: [{ key: "needs_you" as const, title: "Needs you", more: null, rows: [{ line: "Reconnect Meta so approved ads can launch", url: null, fix: { kind: "reconnect" as const, slug: "meta_ads" } }] }],
        },
      },
    };
    render(<GrowthJ6 data={data} onChanged={async () => {}} />);
    const first = (await screen.findByText("Do this first")).nextElementSibling as HTMLElement;
    expect(within(first).getByText("Reconnect Meta so approved ads can launch")).toBeTruthy();
    fireEvent.click(within(first).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(m.reconnect).toHaveBeenCalledWith("meta_ads"));
  });

  it("Not now on a decision snoozes it on the server, and Undo unsnoozes it", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: { items: [card({ id: "d5", source: "decision", kind: "task", body: null, title: "Approve the new audience", primary_label: "Approve" })] },
    };
    m.routes["/api/approvals/d5/snooze"] = { body: { ok: true, changed: true } };
    m.routes["/api/approvals/d5/unsnooze"] = { body: { ok: true, changed: true } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    await screen.findByText("Approve the new audience");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(posts("/api/approvals/d5/snooze")).toEqual([{}]));
    const later = (await screen.findByText("Later: Approve the new audience")).parentElement!;
    fireEvent.click(within(later).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(posts("/api/approvals/d5/unsnooze")).toEqual([{}]));
  });

  it("Copy & open opens the card's own link", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      m.routes["/api/workspace/growth/open-cards"] = {
        body: { items: [card({ id: "c7", kind: "post", channel_slug: "reddit_organic", where: "Reddit", title: "Answer 41 groomers", url: "https://www.reddit.com/r/doggrooming/x" })] },
      };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      fireEvent.click(await screen.findByRole("button", { name: "Copy & open Reddit" }));
      expect(open).toHaveBeenCalledWith("https://www.reddit.com/r/doggrooming/x", "_blank", "noopener,noreferrer");
    } finally {
      open.mockRestore();
    }
  });

  it("cgo's own plan card offers Looks good but no Change it", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: { items: [card({ id: "d6", source: "decision", kind: "plan", body: null, channel_slug: null, title: "Run a Meta test", primary_label: "Approve" })] },
    };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    expect(await screen.findByRole("button", { name: "Looks good" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change it" })).toBeNull();
  });
});

describe("GrowthJ6 check and change paths", () => {
  const check = (over: Record<string, unknown>) =>
    card({ id: "k1", source: "decision", kind: "check", tone: "danger", body: null, title: "A campaign may be spending by mistake", ...over });

  it("a LinkedIn check offers 'Something is live: pause it', which files a pause", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: { items: [check({ channel_slug: "linkedin_ads", platform: "linkedin_ads", campaign_id: "123", account_id: "456" })] },
    };
    m.routes["/api/channels/linkedin_ads/campaigns/123/propose-pause"] = { status: 201, body: { decision_id: "p1" } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Check" }));
    fireEvent.click(screen.getByRole("button", { name: "Something is live: pause it" }));
    await waitFor(() => expect(posts("/api/channels/linkedin_ads/campaigns/123/propose-pause")).toEqual([{ account_id: "456" }]));
  });

  it("a Meta check, or a LinkedIn one without its ad account, has no pause option", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: { items: [check({ id: "k2", channel_slug: "meta_ads", platform: "meta_ads", campaign_id: "9" })] },
    };
    const { unmount } = render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Check" }));
    expect(screen.queryByRole("button", { name: "Something is live: pause it" })).toBeNull();
    unmount();
    m.routes["/api/workspace/growth/open-cards"] = {
      body: { items: [check({ id: "k3", channel_slug: "linkedin_ads", platform: "linkedin_ads", campaign_id: "123" })] },
    };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Check" }));
    expect(screen.queryByRole("button", { name: "Something is live: pause it" })).toBeNull();
  });

  it("Change it on a channel step from the decision rail redoes it with the note", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: { items: [card({ id: "d8", source: "decision", kind: "task", channel_slug: "seo", body: null, title: "Approve the blog plan", primary_label: "Approve", can_redo: true })] },
    };
    m.routes["/api/approvals/d8/redo"] = { body: { ok: true } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change it" }));
    fireEvent.change(screen.getByLabelText("What should Zavi change?"), { target: { value: "Drop topic 4" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts("/api/approvals/d8/redo")).toEqual([{ message: "Drop topic 4" }]));
  });

  it("Change it on a channel card redoes it with the note", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: { items: [card({ id: "c9", kind: "plan", channel_slug: "seo", body: "1. MoeGo vs Fernway", title: "Approve the blog plan", can_redo: true })] },
    };
    m.routes["/api/channel-actions/c9/redo"] = { body: { ok: true } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change it" }));
    fireEvent.change(screen.getByLabelText("What should Zavi change?"), { target: { value: "Add deposits" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts("/api/channel-actions/c9/redo")).toEqual([{ note: "Add deposits" }]));
  });
});

describe("GrowthJ6 Change it follows can_redo", () => {
  it("hides Change it on cards the server can't redo, and shows the server's refusal", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: {
        items: [
          card({ id: "n1", source: "decision", kind: "task", channel_slug: "seo", body: null, title: "Approve a fix", primary_label: "Approve", can_redo: false }),
          card({ id: "n2", kind: "plan", channel_slug: "seo", body: "1. Topic", title: "Approve the plan", can_redo: false }),
          card({ id: "n3", kind: "post", title: "Post the tip", can_redo: true }),
        ],
      },
    };
    m.routes["/api/channel-actions/n3/redo"] = { status: 403, body: { error: { message: "Only an owner or admin can change this." } } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    await screen.findByText("Post the tip");
    const changes = screen.getAllByRole("button", { name: "Change it" });
    expect(changes).toHaveLength(1);
    fireEvent.click(changes[0]);
    fireEvent.change(screen.getByLabelText("What should Zavi change?"), { target: { value: "Shorter" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Only an owner or admin can change this.")).toBeTruthy();
  });
});

describe("GrowthJ6 Change it never shows credits on the card", () => {
  it("the card says only Change it; the note box still names the server's flat price before it is spent", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: {
        items: [
          card({ id: "p1", kind: "post", channel_slug: "reddit_organic", title: "Post the tip", can_redo: true, redo_credits: 580 }),
          card({ id: "p2", kind: "plan", channel_slug: "seo", body: "1. Topic", title: "Approve the blog plan", can_redo: true, redo_credits: 1460 }),
        ],
      },
    };
    m.routes["/api/channel-actions/p1/redo"] = { body: { ok: true } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    await screen.findByText("Post the tip");
    expect(screen.queryByText(/credits/)).toBeNull();
    const changes = screen.getAllByRole("button", { name: "Change it" });
    expect(changes).toHaveLength(2);
    fireEvent.click(within(screen.getByText("Post the tip").closest("[data-j6-card]") as HTMLElement).getByRole("button", { name: "Change it" }));
    expect(screen.getByText(/This uses at least 580 credits\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What should Zavi change?"), { target: { value: "Shorter" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts("/api/channel-actions/p1/redo")).toEqual([{ note: "Shorter" }]));
  });

  it("never shows a price the server did not send, a bad one, or one on a card that can't be redone", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: {
        items: [
          card({ id: "q1", kind: "post", title: "Post one", can_redo: true }),
          card({ id: "q2", kind: "post", title: "Post two", can_redo: true, redo_credits: 12.5 }),
          card({ id: "q3", kind: "post", title: "Post three", can_redo: true, redo_credits: -40 }),
          card({ id: "q4", kind: "post", title: "Post four", can_redo: false, redo_credits: 460 }),
          card({ id: "q5", source: "decision", kind: "task", channel_slug: "seo", body: null, title: "Approve a fix", primary_label: "Approve", can_redo: true, redo_credits: 460 }),
        ],
      },
    };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    await screen.findByText("Post one");
    expect(screen.queryByText(/credits/)).toBeNull();
    const changes = screen.getAllByRole("button", { name: /^Change it/ });
    expect(changes.length).toBeGreaterThanOrEqual(3);
    for (const b of changes) expect(b.textContent).toBe("Change it");
  });
});

describe("GrowthJ6 plan review fixes", () => {
  it("a bet the founder stopped leaves Working on and shows under Not using", () => {
    const channels = PLAN.channels.map((c) => (c.slug === "linkedin_organic" ? { ...c, plan_selected: false, plan_selected_set_by: "founder_stopped" as const } : c));
    render(<GrowthJ6 data={{ ...PLAN, channels }} onChanged={async () => {}} />);
    expect(screen.queryByText("LinkedIn:")).toBeNull();
    expect(screen.getByText("No channels picked yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^Organic/ }));
    expect(screen.getByText("Not using").parentElement?.querySelector('[data-why="stopped by you"]')?.textContent).toBe("LinkedIn");
  });

  it("says the to-do count is not read yet when /api/approvals fails, and 0 only after it answers", async () => {
    const { unmount } = render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    await waitFor(() => expect(m.fetch.mock.calls.some(([p]) => p === "/api/approvals")).toBe(true));
    expect(screen.getByText("to-dos not read yet")).toBeTruthy();
    expect(screen.queryByText("0 to do")).toBeNull();
    unmount();
    m.routes["/api/approvals"] = { body: { channel_pending_counts: {} } };
    const onChanged = async () => {};
    const view = render(<GrowthJ6 data={PLAN} onChanged={onChanged} />);
    expect(await screen.findByText("0 to do")).toBeTruthy();
    m.routes["/api/approvals"] = { status: 500, body: {} };
    view.rerender(<GrowthJ6 data={{ ...PLAN }} onChanged={onChanged} />);
    expect(await screen.findByText("to-dos not read yet")).toBeTruthy();
    expect(screen.queryByText("0 to do")).toBeNull();
  });
});

describe("GrowthJ6 channel fit", () => {
  it("puts a medium-fit channel under Also helping and a low-fit one under Not using, with their lines", () => {
    const ch = (slug: string, fit: { value: "high" | "medium" | "low"; line: string }) => ({
      slug, last_run_at: null, last_run_status: null, metric_keys: [], metric_availability: "none" as const,
      autorun: false, autorun_set_by: "", plan_selected: false, plan_selected_set_by: null, fit,
    });
    render(
      <GrowthJ6
        data={{ ...PLAN, channels: [...PLAN.channels, ch("geo", { value: "medium", line: "so ChatGPT can name you." }), ch("email_marketing", { value: "low", line: "no customer list yet" })] }}
        onChanged={async () => {}}
      />,
    );
    expect(screen.getByText(/Also helping:/).closest("[data-section=helping]")?.textContent).toContain("so ChatGPT can name you");
    fireEvent.click(screen.getByRole("tab", { name: /^Organic/ }));
    expect(screen.getByText("Not using").parentElement?.querySelector('[data-why="no customer list yet"]')).toBeTruthy();
  });
});

describe("GrowthJ6 done for you (Free)", () => {
  const DFY = "/api/workspace/growth/done-for-you";
  const reconnect = card({ id: "fix1", kind: "reconnect", channel_slug: "meta_ads", title: "Reconnect Meta", body: null, where: null });
  const task = card({ id: "t2", kind: "task", channel_slug: "seo", title: "Check the pricing page text", body: null, where: null, dfy: "research" });
  const state = (over: Record<string, unknown>) => ({
    state: "available",
    run_id: null,
    action_id: null,
    mode: null,
    attempts_used: 0,
    last_outcome: null,
    result: null,
    ...over,
  });

  it("puts the offer on the first doable card when slot 1 is a fix Zavi cannot do", async () => {
    m.routes["/api/workspace/growth/open-cards"] = { body: { items: [reconnect, task] } };
    m.routes[DFY] = { body: state({}) };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    expect(await screen.findByRole("button", { name: "Have Zavi do this" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Have Zavi do this" })).toHaveLength(1);
    const offer = screen.getByText("Free plan: Zavi can do one task for you.");
    expect(offer.closest("div")?.parentElement?.textContent).toContain("Check the pricing page text");
    expect(offer.closest("div")?.parentElement?.textContent).not.toContain("Reconnect Meta");
    expect(m.track).toHaveBeenCalledWith("dfy_offered", expect.objectContaining({ action_id: "t2", mode: "research", slot: 2 }));
  });

  it("no offer once the task is done, or when it is unavailable", async () => {
    m.routes["/api/workspace/growth/open-cards"] = { body: { items: [task] } };
    m.routes[DFY] = { body: state({ state: "unavailable" }) };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    expect(await screen.findByText("Check the pricing page text")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Have Zavi do this" })).toBeNull();
    cleanup();
    m.routes[DFY] = { body: state({ state: "done", run_id: "r1", result: { markdown: "Google reads it.", caption: null, images: [] } }) };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    expect(await screen.findByText("Zavi's free task")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Have Zavi do this" })).toBeNull();
  });

  it("Start posts once, then the result and the Starter ask show; Upgrade opens Starter billing", async () => {
    m.routes["/api/workspace/growth/open-cards"] = { body: { items: [task] } };
    m.routes[DFY] = { body: state({}) };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Have Zavi do this" }));
    expect(screen.getByText("Have Zavi do this?")).toBeTruthy();
    expect(screen.getByText(/Zavi checks this itself and writes up what it found/)).toBeTruthy();
    m.routes[DFY] = { status: 202, body: { ok: true, run_id: "r1", attempt: 1 } };
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(posts(DFY)).toHaveLength(1));
    expect(posts(DFY)[0]).toMatchObject({ action_id: "t2" });
    expect(typeof posts(DFY)[0].request_id).toBe("string");
    m.routes[DFY] = { body: state({ state: "done", run_id: "r1", action_id: "t2", result: { markdown: "Google reads the pricing text.", caption: null, images: [] } }) };
    cleanup();
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    expect(await screen.findByText("Google reads the pricing text.")).toBeTruthy();
    expect(screen.getByText("Done by Zavi.")).toBeTruthy();
    expect(await screen.findByText(/On Starter, Zavi does this every week/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Starter" }));
    expect(m.billing).toHaveBeenCalledWith(m.openTab, "billing-upgrade-starter");
  });

  it("shows running, can't do and used up from the server", async () => {
    m.routes["/api/workspace/growth/open-cards"] = { body: { items: [] } };
    m.routes[DFY] = { body: state({ state: "running", run_id: "r1" }) };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    expect(await screen.findByText("Zavi is doing this…")).toBeTruthy();
    cleanup();
    m.routes[DFY] = { body: state({ last_outcome: "cannot_do" }) };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    expect(await screen.findByText("Zavi couldn't finish that one, and your free task wasn't used.")).toBeTruthy();
    cleanup();
    m.routes[DFY] = { body: state({ state: "used_up", attempts_used: 3, last_outcome: "failed" }) };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    expect(await screen.findByText("Zavi couldn't finish a free task this time.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upgrade to Starter" })).toBeTruthy();
  });
});

describe("GrowthJ6 #ad-budget lands on a working budget form", () => {
  const ACTIVE = {
    id: "bud1",
    status: "active",
    monthly_usd: 155,
    daily_limit_usd: null,
    started_on: "2026-10-01",
    month_cap_usd: 155,
    spent_usd: 20,
    held_usd: 0,
    left_usd: 135,
    month_start: "2026-10-01",
    next_month_start: "2026-11-01",
    days_left: 2,
    days_in_month: 31,
    stopped_at: null,
    still_running: [],
  };
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("with no budget, the New view carries #ad-budget, scrolls to it, and Set up opens the amount field and saves", async () => {
    window.history.replaceState(null, "", "/workspace?tab=growth-strategy#ad-budget");
    const scrollIntoView = vi.fn();
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = scrollIntoView;
    try {
      m.routes["/api/workspace/ad-budget"] = { body: { budget: null, can_manage: true, pro: true, forecast: null } };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      const section = await waitFor(() => {
        const el = document.getElementById("ad-budget");
        expect(el?.getAttribute("aria-label")).toBe("Ad budget");
        return el!;
      });
      expect(section.closest('[data-growth-view="new"]')).toBeTruthy();
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      fireEvent.click(within(section).getByRole("button", { name: "Set up" }));
      fireEvent.change(within(section).getByLabelText("$ per month"), { target: { value: "155" } });
      m.routes["/api/workspace/ad-budget"] = { status: 201, body: { budget_id: "bud1", month_cap_usd: 10 } };
      fireEvent.click(within(section).getByRole("button", { name: "Set up budget" }));
      await waitFor(() => expect(posts("/api/workspace/ad-budget")).toEqual([{ monthly_usd: 155, daily_limit_usd: null }]));
    } finally {
      proto.scrollIntoView = original;
    }
  });

  it("with an active budget, the link still lands on the budget block with Edit, not on plain text", async () => {
    window.history.replaceState(null, "", "/workspace?tab=growth-strategy#ad-budget");
    m.routes["/api/workspace/ad-budget"] = { body: { budget: ACTIVE, can_manage: true, pro: true, forecast: null } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    await waitFor(() => expect(document.getElementById("ad-budget")?.getAttribute("aria-label")).toBe("Ad budget"));
    const section = document.getElementById("ad-budget")!;
    await waitFor(() => expect(within(section).getByRole("button", { name: "Edit" })).toBeTruthy());
  });

  it("after a save through step 1's Edit budget row, the linked budget block shows the new amount from the page's one read", async () => {
    window.history.replaceState(null, "", "/workspace?tab=growth-strategy#ad-budget");
    m.routes["/api/workspace/ad-budget"] = { body: { budget: ACTIVE, can_manage: true, pro: true, forecast: null } };
    m.routes["/api/workspace/ad-budget/bud1"] = { body: { ok: true, month_cap_usd: 300 } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    await waitFor(() => expect(document.getElementById("ad-budget")?.textContent).toContain("Ads: $155 a month"));
    const budgetReads = () => m.fetch.mock.calls.filter(([p, init]) => p === "/api/workspace/ad-budget" && !(init as RequestInit | undefined)?.method).length;
    const before = budgetReads();
    fireEvent.click(await screen.findByRole("button", { name: "Edit budget" }));
    fireEvent.change(await screen.findByLabelText("Monthly ad budget"), { target: { value: "300" } });
    m.routes["/api/workspace/ad-budget"] = { body: { budget: { ...ACTIVE, monthly_usd: 300, month_cap_usd: 300, left_usd: 280 }, can_manage: true, pro: true, forecast: null } };
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.getElementById("ad-budget")?.textContent).toContain("Ads: $300 a month"));
    expect(document.getElementById("ad-budget")?.textContent).not.toContain("$155");
    expect(budgetReads() - before).toBe(1);
  });

  it("without the link, an active budget is not shown twice: the brief's Edit budget row is enough", async () => {
    m.routes["/api/workspace/ad-budget"] = { body: { budget: ACTIVE, can_manage: true, pro: true, forecast: null } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    await screen.findByRole("button", { name: "Edit budget" });
    expect(document.getElementById("ad-budget")).toBeNull();
  });
});

describe("GrowthJ6 Today's LinkedIn cards", () => {
  const OPEN = "/api/workspace/growth/open-cards";
  const spend = (over: Record<string, unknown>) => card({ source: "decision", kind: "spend", channel_slug: "linkedin_ads", platform: "linkedin_ads", body: null, primary_label: "Approve", ...over });
  const others = (n: number, slug = "google_ads") =>
    Array.from({ length: n }, (_, i) => spend({ id: `other${i}`, channel_slug: slug, platform: slug, title: `Raise budget ${i}` }));
  const approves = (id: string, source: "decision" | "channel_action" = "channel_action") =>
    m.fetch.mock.calls.filter(([p, init]) => (init as RequestInit | undefined)?.method && String(p).startsWith(source === "decision" ? `/api/approvals/${id}/approve` : `/api/channel-actions/${id}/approve`));

  describe("a launch", () => {
    const TITLE = "Launch “CFO Checklist”: $500 total, ends Nov 30, 2026, 5:00 PM UTC";

    it("shows campaign, amount and end on the row and again in the dialog that starts the spend", async () => {
      m.routes[OPEN] = { body: { items: [spend({ id: "l1", title: TITLE, effect: TITLE })] } };
      m.routes["/api/approvals/l1/approve"] = { body: { ok: true } };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      expect(await screen.findByText(TITLE)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toContain("CFO Checklist");
      expect(dialog.textContent).toContain("$500 total");
      expect(dialog.textContent).toContain("ends Nov 30, 2026");
      expect(approves("l1", "decision")).toEqual([]);
      fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(approves("l1", "decision")).toHaveLength(1));
    });

    it("one the server cannot describe has no Approve at all, says why, and can still be rejected", async () => {
      m.routes[OPEN] = { body: { items: [spend({ id: "l2", title: "A LinkedIn launch that would start spending: Zavi can't read its campaign, budget or end date", approve_blocked: "Zavi won't start this spend from here." })] } };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      expect(await screen.findByText("Zavi won't start this spend from here.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
      expect(approves("l2", "decision")).toEqual([]);
    });

    it("another channel's money card with the same shape keeps its Approve", async () => {
      m.routes[OPEN] = { body: { items: [spend({ id: "g1", channel_slug: "google_ads", platform: "google_ads", title: "Raise Search" })] } };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
    });
  });

  describe("a campaign draft", () => {
    const draft = (over: Record<string, unknown> = {}) =>
      card({ id: "dr1", kind: "task", channel_slug: "linkedin_ads", title: "Review and create your LinkedIn campaign", body: "CFO Checklist\nLinkedIn audience\nPaste the link", card_kind: "ad_manual", primary_label: "Review and create", opens_review: true, ...over });
    const writes = () => m.fetch.mock.calls.filter(([p, init]) => (init as RequestInit | undefined)?.method && String(p).startsWith("/api/channel-actions/dr1"));

    it("its only main control goes to the card's review on its channel page; nothing closes it and nothing reads as done", async () => {
      const clip = vi.fn(async () => {});
      Object.assign(navigator, { clipboard: { writeText: clip } });
      m.routes[OPEN] = { body: { items: [draft()] } };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      const link = await screen.findByRole("link", { name: "Review and create" });
      expect(link.getAttribute("href")).toBe("/workspace?tab=channels&channel=linkedin_ads&action=dr1");
      link.addEventListener("click", (e) => e.preventDefault());
      fireEvent.click(link);
      expect(clip).not.toHaveBeenCalled();
      for (const name of [/^Yes/, "Not yet", "Mark done", /^Copy/]) expect(screen.queryByRole("button", { name })).toBeNull();
      expect(screen.queryByText("Done it?")).toBeNull();
      expect(writes()).toEqual([]);
      expect(m.fetch.mock.calls.filter(([p]) => String(p).endsWith("/copied"))).toEqual([]);
      expect(screen.getByRole("link", { name: "Review and create" })).toBeTruthy();
    });

    it("another channel's Copy ad card still copies, asks, and closes on Yes", async () => {
      m.routes[OPEN] = { body: { items: [card({ id: "rd1", kind: "task", channel_slug: "reddit_ads", title: "Run this ad", body: "Buy now", card_kind: "ad_manual", primary_label: "Copy ad" })] } };
      m.routes["/api/channel-actions/rd1"] = { body: { ok: true } };
      m.routes["/api/workspace/growth/cards/rd1/copied"] = { body: { ok: true } };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      fireEvent.click(await screen.findByRole("button", { name: "Copy ad" }));
      fireEvent.click(await screen.findByRole("button", { name: "Yes" }));
      await waitFor(() => expect(posts("/api/channel-actions/rd1")[0]).toMatchObject({ action: "acted" }));
      expect(screen.queryByRole("link", { name: "Review and create" })).toBeNull();
    });
  });

  describe("a pause of live spend", () => {
    const CHECK = card({ id: "k1", source: "decision", kind: "check", tone: "danger", body: null, title: "A campaign may be spending by mistake", channel_slug: "linkedin_ads", platform: "linkedin_ads", campaign_id: "123", account_id: "456" });
    const TITLE = 'Pause the LinkedIn campaign "CFO Checklist"';
    const pause = (over: Record<string, unknown> = {}) =>
      spend({ id: "p1", source: "channel_action", title: TITLE, effect: "It stops spending until someone turns it back on.", stops_live_spend: true, card_kind: "executes", ...over });
    const FILED = "/api/channels/linkedin_ads/campaigns/123/propose-pause";

    it("a pause filed from Today, after 3 cards were already picked, lands on top without opening anything", async () => {
      const items = [CHECK, ...others(4)];
      m.routes[OPEN] = { body: { items } };
      m.routes[FILED] = { status: 201, body: { action_id: "p1", campaign: { id: "123", name: "CFO Checklist" } } };
      m.routes["/api/channel-actions/p1/approve"] = { body: { ok: true } };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      fireEvent.click(await screen.findByRole("button", { name: "Check" }));
      m.routes[OPEN] = { body: { items: [pause(), ...items] } };
      fireEvent.click(screen.getByRole("button", { name: "Something is live: pause it" }));
      const row = (await screen.findByText(TITLE)).closest("[data-j6-card]") as HTMLElement;
      expect(row.getAttribute("data-j6-card")).toBe("p1");
      expect(row.textContent).toContain("Stops live spend");
      expect(row.closest("section")?.getAttribute("aria-label")).toBe("Do this first");
      const rows = [...document.querySelectorAll("[data-j6-card]")].map((e) => e.getAttribute("data-j6-card"));
      expect(rows[0]).toBe("p1");
      expect(screen.getByText(/Zavi filed a pause for "CFO Checklist"\. Approve it at the top of Today/)).toBeTruthy();
      fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toContain("CFO Checklist");
      expect(dialog.textContent).toContain("It stops spending");
      fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(approves("p1")).toHaveLength(1));
    });

    it("on a fresh visit an open check would hold it back, and three other cards fill the list: it still shows", async () => {
      m.routes[OPEN] = { body: { items: [...others(4), CHECK, pause()] } };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      expect(await screen.findByText(TITLE)).toBeTruthy();
      expect(document.querySelector("[data-j6-card]")?.getAttribute("data-j6-card")).toBe("p1");
    });

    it("every open pause shows, not only the first", async () => {
      m.routes[OPEN] = { body: { items: [...others(4), pause(), pause({ id: "p2", title: 'Pause the LinkedIn campaign "Second"' })] } };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      expect(await screen.findByText(TITLE)).toBeTruthy();
      expect(screen.getByText('Pause the LinkedIn campaign "Second"')).toBeTruthy();
    });

    it("the list failing to refresh after filing says the campaign is still spending, never that all is well", async () => {
      m.routes[OPEN] = { body: { items: [CHECK] } };
      m.routes[FILED] = { status: 201, body: { action_id: "p1", campaign: { id: "123", name: "CFO Checklist" } } };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      fireEvent.click(await screen.findByRole("button", { name: "Check" }));
      m.routes[OPEN] = { status: 503, body: {} };
      fireEvent.click(screen.getByRole("button", { name: "Something is live: pause it" }));
      const line = await screen.findByText(/It keeps spending until you approve the pause/);
      expect(line.textContent).toContain('"CFO Checklist"');
      expect(screen.queryByText(TITLE)).toBeNull();
    });

    it("a refused filing shows the server's reason and no filed line", async () => {
      m.routes[OPEN] = { body: { items: [CHECK] } };
      m.routes[FILED] = { status: 409, body: { error: { message: "A pause for this campaign is already waiting." } } };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      fireEvent.click(await screen.findByRole("button", { name: "Check" }));
      fireEvent.click(screen.getByRole("button", { name: "Something is live: pause it" }));
      expect(await screen.findByText("A pause for this campaign is already waiting.")).toBeTruthy();
      expect(screen.queryByText(/It keeps spending until you approve/)).toBeNull();
    });

    it("a pause the founder moved to later stays later", async () => {
      m.routes[OPEN] = { body: { items: [...others(3), pause({ snoozed_until: "2099-01-01T00:00:00Z" })] } };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      expect(await screen.findByText("Raise budget 0")).toBeTruthy();
      expect(document.querySelector("[data-j6-card]")?.getAttribute("data-j6-card")).not.toBe("p1");
      expect(screen.getByText(/^Later: Pause the LinkedIn campaign/)).toBeTruthy();
    });

    it("a Meta pause keeps today's behaviour: past the 3 picked it waits under Then, in High, not in Medium", async () => {
      const metaTitle = "Pause “Spring”";
      m.routes[OPEN] = { body: { items: [...others(4), spend({ id: "m1", channel_slug: "meta_ads", platform: "meta_ads", title: metaTitle })] } };
      render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
      expect(await screen.findByText("Raise budget 0")).toBeTruthy();
      expect(within(screen.getByRole("region", { name: "Do this first" })).queryByText(metaTitle)).toBeNull();
      expect(screen.getByText(metaTitle).closest("section")?.getAttribute("aria-label")).toBe("Then");
      const high = screen.getByRole("tab", { name: /^High/ });
      expect(high.textContent).toBe("High(5)");
      fireEvent.click(screen.getByRole("tab", { name: /^Medium/ }));
      expect(screen.queryByText(metaTitle)).toBeNull();
      fireEvent.click(high);
      expect(high.getAttribute("aria-selected")).toBe("true");
      expect(screen.getByText(metaTitle)).toBeTruthy();
      expect(screen.getByText("Raise budget 0")).toBeTruthy();
    });
  });
});

describe("GrowthJ6 a channel under Not using never gets Today work", () => {
  const low = (slug: string) => ({
    slug, last_run_at: null, last_run_status: null, metric_keys: [], metric_availability: "none" as const,
    autorun: false, autorun_set_by: "", plan_selected: false, plan_selected_set_by: null, fit: { value: "low" as const, line: "not where your buyers are" },
  });
  const data = { ...PLAN, channels: [PLAN.channels[0]!, low("instagram_organic"), PLAN.channels[2]!] };

  it("an Instagram post is not the first card while Instagram is listed under Not using", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: {
        items: [
          card({ id: "ig", channel_slug: "instagram_organic", where: "Instagram", title: "Post a before-and-after on Instagram" }),
          card({ id: "tt", channel_slug: "tiktok_ads", where: "TikTok", title: "Post a TikTok clip" }),
          card({ id: "li", channel_slug: "linkedin_organic", where: "LinkedIn", title: "Post the salon owner tip" }),
        ],
      },
    };
    render(<GrowthJ6 data={data} onChanged={async () => {}} />);
    expect(await screen.findByText("Post the salon owner tip")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^Organic/ }));
    expect(screen.getByText("Not using").parentElement?.textContent).toMatch(/Instagram/);
    expect(screen.queryByText("Post a before-and-after on Instagram")).toBeNull();
    expect(screen.queryByText("Post a TikTok clip")).toBeNull();
    const first = screen.getByText("Do this first").closest("div")!.parentElement!;
    expect(first.textContent).toContain("Post the salon owner tip");
  });

  it("a money-at-risk check on a Not-using channel still shows", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: { items: [card({ id: "d9", source: "decision", kind: "check", tone: "danger", channel_slug: "tiktok_ads", body: null, title: "A TikTok campaign may be spending by mistake" })] },
    };
    render(<GrowthJ6 data={data} onChanged={async () => {}} />);
    expect(await screen.findByText("A TikTok campaign may be spending by mistake")).toBeTruthy();
  });

  it("once Instagram is back in the plan its card shows again", async () => {
    m.routes["/api/workspace/growth/open-cards"] = {
      body: { items: [card({ id: "ig", channel_slug: "instagram_organic", where: "Instagram", title: "Post a before-and-after on Instagram" })] },
    };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    expect(await screen.findByText("Post a before-and-after on Instagram")).toBeTruthy();
  });
});

describe("GrowthJ6 every goal in Where you stand", () => {
  const SECOND = {
    ...PLAN.goals.items[0],
    id: "g2",
    objective: "Reach 30 signups",
    target_metric: "signups",
    target_value: 30,
    current_value: 5,
    priority: 40,
  };
  const TWO = { ...PLAN, goals: { ...PLAN.goals, active_count: 2, items: [PLAN.goals.items[0], SECOND] } };
  const step1 = () => screen.getByRole("region", { name: "Where you stand" });
  const calls = (path: string, method: string) =>
    m.fetch.mock.calls.filter(([p, init]) => p === path && (init as RequestInit | undefined)?.method === method);

  it("lists every active goal with its own Edit, and the higher one leads the page", async () => {
    render(<GrowthJ6 data={TWO} onChanged={async () => {}} />);
    expect(await within(step1()).findByRole("button", { name: "Edit Reach 30 signups" })).toBeTruthy();
    expect(within(step1()).getByRole("button", { name: "Edit 40 new paying customers" })).toBeTruthy();
    expect(within(step1()).getAllByRole("button", { name: "Edit" })).toHaveLength(2);
    expect(screen.getByText("11 of 40 new paying customers.")).toBeTruthy();
  });

  it("opens the editor on the second goal, and its Pause pauses that goal", async () => {
    m.routes["/api/workspace/autopilot/goals/g2"] = { body: {} };
    const onChanged = vi.fn(async () => {});
    render(<GrowthJ6 data={TWO} onChanged={onChanged} />);
    fireEvent.click(await within(step1()).findByRole("button", { name: "Edit Reach 30 signups" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Pause goal/ }));
    await waitFor(() => expect(posts("/api/workspace/autopilot/goals/g2")).toEqual([{ status: "paused" }]));
    expect(onChanged).toHaveBeenCalled();
  });

  it("adds a goal while one exists", async () => {
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    fireEvent.click(await within(step1()).findByRole("button", { name: "Add a goal" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("stops adding at the limit and says why", async () => {
    const data = { ...TWO, goals: { ...TWO.goals, max_active: 2 } };
    render(<GrowthJ6 data={data} onChanged={async () => {}} />);
    expect(await within(step1()).findByText("2 goals is the most this plan chases at once. Pause one to add another.")).toBeTruthy();
    expect(within(step1()).queryByRole("button", { name: "Add a goal" })).toBeNull();
  });

  it("deleting the lead moves the page to the next goal and drops a number typed for the old one", async () => {
    m.routes["/api/workspace/autopilot/goals/g1"] = { body: {} };
    const data = { ...TWO, goals: { ...TWO.goals, items: [{ ...TWO.goals.items[0], current_value: null }, SECOND] } };
    render(<GrowthJ6 data={data} onChanged={async () => {}} />);
    fireEvent.change(screen.getByLabelText("How many so far?"), { target: { value: "99" } });
    fireEvent.click(await within(step1()).findByRole("button", { name: "Delete 40 new paying customers" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this goal?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls("/api/workspace/autopilot/goals/g1", "DELETE")).toHaveLength(1));
    expect(await screen.findByText("5 of 30 signups.")).toBeTruthy();
    expect(screen.queryByLabelText("How many so far?")).toBeNull();
    expect(posts("/api/workspace/autopilot/goals/g2")).toEqual([]);
  });

  it("does not repeat the lead's number under the rows, and says so when a typed number is not a number", async () => {
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    await within(step1()).findByRole("button", { name: "Edit 40 new paying customers" });
    expect(within(step1()).queryByText(/you typed/)).toBeNull();
    cleanup();
    const data = { ...PLAN, goals: { ...PLAN.goals, items: [{ ...PLAN.goals.items[0], current_value: null }] } };
    render(<GrowthJ6 data={data} onChanged={async () => {}} />);
    fireEvent.change(screen.getByLabelText("How many so far?"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "See if I'm on track" }));
    expect(await screen.findByText("Type a number, like 12.")).toBeTruthy();
    expect(posts("/api/workspace/autopilot/goals/g1")).toEqual([]);
  });

  it("hides the ad changes row when there are none, and keeps it while unread", async () => {
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    expect(await within(step1()).findByText("Changes in your ad accounts: not read yet")).toBeTruthy();
    cleanup();
    m.routes["/api/workspace/ad-budget/ledger"] = { body: { rows: [] } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    await waitFor(() => expect(m.fetch.mock.calls.some(([p]) => p === "/api/workspace/ad-budget/ledger")).toBe(true));
    await within(step1()).findByRole("button", { name: "Edit 40 new paying customers" });
    
    await waitFor(() => expect(within(step1()).queryByRole("button", { name: /in your ad accounts/ })).toBeNull());
  });

  it("a failed delete puts the goal back and says so", async () => {
    m.routes["/api/workspace/autopilot/goals/g1"] = { status: 500, body: { error: { message: "Could not delete that goal. Try again." } } };
    render(<GrowthJ6 data={PLAN} onChanged={async () => {}} />);
    fireEvent.click(await within(step1()).findByRole("button", { name: "Delete 40 new paying customers" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this goal?" })).getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(within(step1()).getByRole("button", { name: "Edit 40 new paying customers" })).toBeTruthy();
    expect(screen.getByText("11 of 40 new paying customers.")).toBeTruthy();
  });

  it("moving a goal down writes the new order", async () => {
    m.routes["/api/workspace/autopilot/goals/g1"] = { body: {} };
    m.routes["/api/workspace/autopilot/goals/g2"] = { body: {} };
    render(<GrowthJ6 data={TWO} onChanged={async () => {}} />);
    fireEvent.click(await within(step1()).findByRole("button", { name: "Move 40 new paying customers down" }));
    await waitFor(() => expect(posts("/api/workspace/autopilot/goals/g2")).toEqual([{ priority: 100 }]));
    expect(posts("/api/workspace/autopilot/goals/g1")).toEqual([{ priority: 99 }]);
  });

  it("a member sees every goal but no goal controls", async () => {
    m.role = "member";
    render(<GrowthJ6 data={TWO} onChanged={async () => {}} />);
    expect(await within(step1()).findByText(/Signups 5 \/ 30/)).toBeTruthy();
    expect(within(step1()).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(step1()).queryByRole("button", { name: "Add a goal" })).toBeNull();
    expect(within(step1()).queryByRole("button", { name: "Update number" })).toBeNull();
    expect(within(step1()).queryByRole("button", { name: /^Delete / })).toBeNull();
  });

  it("with no goal, Zavi's suggested goal shows beside the first-goal picks", async () => {
    const data = {
      ...EMPTY,
      goals: { ...EMPTY.goals, items: [{ ...SECOND, id: "g9", status: "proposed", source: "agent_proposed", objective: "Reach 30 signups" }] },
    };
    render(<GrowthJ6 data={data as GrowthPlanPayload} onChanged={async () => {}} />);
    expect(screen.getByRole("button", { name: "Signups" })).toBeTruthy();
    expect(await screen.findByText(/Reach 30 signups/)).toBeTruthy();
  });

  it("a suggested goal is not a goal still coming, even while a plan is written", async () => {
    const data = {
      ...EMPTY,
      goals: { ...EMPTY.goals, items: [{ ...SECOND, id: "g9", status: "proposed", source: "agent_proposed", objective: "Reach 30 signups" }] },
    };
    render(<GrowthJ6 data={data as GrowthPlanPayload} drafting onChanged={async () => {}} />);
    expect(await screen.findByText(/Reach 30 signups/)).toBeTruthy();
    expect(screen.queryByText("Zavi is setting your goal.")).toBeNull();
    expect(screen.getByRole("button", { name: "Signups" })).toBeTruthy();
  });

  it("a live number that differs from the stored one hides the stored pace, and a failed live read says it is the last reading", async () => {
    const auto = {
      ...PLAN.goals.items[0],
      target_metric: "mrr",
      measurement_mode: "auto",
      trajectory: { kind: "gauge", pace_usable: true, projected: 20, progress: 10, line: null },
    };
    const data = { ...PLAN, goals: { ...PLAN.goals, items: [auto] } } as unknown as GrowthPlanPayload;
    m.routes["/api/workspace/autopilot/goals/current-value"] = { body: { measured: true, value: 30 } };
    render(<GrowthJ6 data={data} onChanged={async () => {}} />);
    expect(await screen.findByText(/^\$30 of \$40/)).toBeTruthy();
    expect(screen.queryByText(/short by/)).toBeNull();
    cleanup();
    m.routes["/api/workspace/autopilot/goals/current-value"] = { status: 500, body: {} };
    render(<GrowthJ6 data={data} onChanged={async () => {}} />);
    expect(await screen.findByText("Showing the last reading: the live number could not be read just now.")).toBeTruthy();
  });

  it("an automatic goal its source cannot measure still draws its rows, shows no stored pace, and takes no typed number", async () => {
    const auto = {
      ...PLAN.goals.items[0],
      target_metric: "mrr",
      measurement_mode: "auto",
      trajectory: { kind: "gauge", pace_usable: true, projected: 50, progress: 10, line: null },
    };
    const data = { ...PLAN, goals: { ...PLAN.goals, items: [auto] } } as unknown as GrowthPlanPayload;
    m.routes["/api/workspace/autopilot/goals/current-value"] = { body: { measured: false } };
    render(<GrowthJ6 data={data} onChanged={async () => {}} />);
    expect(await within(step1()).findByRole("button", { name: "Edit 40 new paying customers" })).toBeTruthy();
    expect(screen.getByText("Showing the last reading: the live number could not be read just now.")).toBeTruthy();
    expect(screen.queryByText(/On track|short by/)).toBeNull();
    cleanup();
    const none = { ...data, goals: { ...data.goals, items: [{ ...auto, current_value: null }] } } as unknown as GrowthPlanPayload;
    m.routes["/api/workspace/autopilot/goals/current-value"] = { status: 500, body: {} };
    render(<GrowthJ6 data={none} onChanged={async () => {}} />);
    expect(await screen.findByText("Zavi could not read this number from your data yet.")).toBeTruthy();
    expect(screen.queryByLabelText("How many so far?")).toBeNull();
  });

  it("says when a goal under the lead shows its last reading", async () => {
    const second = { ...SECOND, target_metric: "mrr", measurement_mode: "auto" };
    const data = { ...TWO, goals: { ...TWO.goals, items: [TWO.goals.items[0], second] } } as unknown as GrowthPlanPayload;
    m.routes["/api/workspace/autopilot/goals/current-value"] = { status: 500, body: {} };
    render(<GrowthJ6 data={data} onChanged={async () => {}} />);
    expect(await screen.findByText("Showing the last reading for Reach 30 signups: the live number could not be read just now.")).toBeTruthy();
  });
});
