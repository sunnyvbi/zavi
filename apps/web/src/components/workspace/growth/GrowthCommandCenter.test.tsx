import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GrowthCommandCenter } from "./GrowthCommandCenter";
import { __needsYouOwner, __resetNeedsYouStore } from "./needsYou";
import { goalPace, goalProgress } from "./growthPresentation";
import { resetChannelLocksCache } from "../layout/useChannelLocks";
import type {
  GrowthBet,
  GrowthChannel,
  GrowthGoal,
  GrowthPlanPayload,
} from "@/lib/workspace/useGrowthPlan";

const calls: Array<{ path: string; body?: unknown }> = [];
let routes: Record<string, unknown> = {};
const apiFetchMock = vi.fn(async (path: string, opts?: { body?: string }) => {
  calls.push({ path, body: opts?.body ? JSON.parse(opts.body) : undefined });
  const hit = routes[path] as { __status?: number; body?: unknown } | undefined;
  const status = hit?.__status ?? 200;
  return {
    ok: status < 400,
    status,
    json: async () => (hit?.__status ? hit.body : hit) ?? { ok: true },
  } as unknown as Response;
});
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts?: { body?: string }) => apiFetchMock(path, opts),
}));

vi.mock("../AutopilotGoalsPanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../AutopilotGoalsPanel")>()),
  GoalEditor: ({
    goal,
    initialObjective,
  }: {
    goal: { objective: string } | null;
    initialObjective?: string;
  }) => <div role="dialog">{goal?.objective ?? `New goal: ${initialObjective ?? ""}`}</div>,
}));

const goal: GrowthGoal = {
  id: "goal-1",
  objective: "Activate more hosts",
  target_metric: "host_activation",
  target_value: 40,
  baseline_value: 20,
  current_value: 30,
  due_date: "2026-12-31",
  status: "active",
  priority: 1,
  source: "founder",
  falsifier: null,
  status_changed_by: null,
  status_changed_at: null,
};

const channel = (slug: string, over: Partial<GrowthChannel> = {}): GrowthChannel => ({
  slug,
  last_run_at: null,
  last_run_status: null,
  metric_availability: "none",
  metric_keys: [],
  autorun: false,
  autorun_set_by: "",
  plan_selected: false,
  plan_selected_set_by: null,
  ...over,
});

const bet = (slug: string, over: Partial<GrowthBet> = {}): GrowthBet =>
  ({
    id: `bet-${slug}`,
    channel_slug: slug,
    intent: `Work ${slug} hard`,
    rationale: `Because ${slug} converts`,
    expected_effect: null,
    falsifier: "no lift",
    status: "accepted",
    rejected_reason: null,
    sort_order: 1,
  }) as GrowthBet;

const livePlan = {
  id: "plan-1",
  source: "typed" as const,
  pending_acceptance: false,
  objective: "Turn supply into trips",
  north_star_metric: "host_activation",
  constraint_lever_family: "demand",
  constraint_statement: "Demand is not reaching hosts",
  constraint_confidence: "medium" as const,
  basis_evidence: [],
  version: 2,
  updated_at: "2026-09-07",
};

const data: GrowthPlanPayload = {
  plan: livePlan,
  goals: { active_count: 1, max_active: 3, over_cap: false, items: [goal] },
  channels: [
    channel("seo", { plan_selected: true, plan_selected_set_by: "plan" }),
    channel("sms", { plan_selected: true, plan_selected_set_by: "founder" }),
  ],
  metrics: [],
  bets: [bet("seo")],
  changes: [],
  unreadable: [],
};

beforeEach(() => {
  calls.length = 0;
  resetChannelLocksCache();
  routes = {
    "/api/channels": { channel_locks: { seo: null, sms: null, email_marketing: null } },
    "/api/connectors/company-facts": {
      facts: [
        { key: "company_name", value_text: "Upcar" },
        { key: "what_we_sell", value_text: "P2P car rental" },
        { key: "competitors", value_text: "Turo, Getaround" },
      ],
    },
    "/api/connectors": { connectors: [{ slug: "slack" }, { slug: "github" }] },
    "/api/connectors/recommendations": {
      recommendations: [
        { slug: "google_analytics", name: "Google Analytics", connected: false, recommended: true },
        { slug: "google_search_console", name: "Google Search Console", connected: false, recommended: true, rationale: "Shows searches." },
      ],
    },
  };
});
afterEach(cleanup);

async function renderPage(d: GrowthPlanPayload = data, onChanged = vi.fn(async () => {})) {
  const utils = render(<GrowthCommandCenter data={d} onChanged={onChanged} />);
  await screen.findByText("Upcar");
  return { ...utils, onChanged };
}

const openKnow = () => fireEvent.click(screen.getByRole("button", { name: "What Zavi knows about you" }));

const regionNames = () =>
  screen
    .getAllByRole("region")
    .map((r) => r.getAttribute("aria-label") ?? document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent);

describe("Growth plan page, a story", () => {
  it("renders the header and the five steps, in order", async () => {
    await renderPage();
    await screen.findByRole("region", { name: "Rivals", hidden: true });
    expect(regionNames()).toEqual([
      "Growth brief",
      "Your goals",
      "What's in the way",
      "What Zavi is doing",
      "What happened",
      "What needs you",
    ]);
  });

  it("keeps what Zavi knows about you in a drawer, mounted but inert until opened", async () => {
    await renderPage();
    const drawer = screen.getByRole("dialog", { name: "What Zavi knows about you", hidden: true });
    expect(drawer.closest("[inert]")).toBeTruthy();
    expect(drawer.closest("[aria-hidden='true']")).toBeTruthy();
    expect(drawer.className).toContain("raised-surface");
    expect(within(screen.getByRole("region", { name: "Growth brief" })).getByText("Growth brief for Upcar · from Zavi")).toBeTruthy();
    openKnow();
    const open = screen.getByRole("dialog", { name: "What Zavi knows about you" });
    expect(open.getAttribute("aria-modal")).toBe("true");
    expect(open.closest("[inert]")).toBeNull();
    for (const name of ["Company", "Rivals", "Your data", "Brand voice"]) {
      expect(within(open).getByRole("region", { name })).toBeTruthy();
    }
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "What Zavi knows about you" })).toBeNull();
  });

  it("moves focus into the drawer and gives it back to the opener on close", async () => {
    await renderPage();
    const opener = screen.getByRole("button", { name: "What Zavi knows about you" });
    opener.focus();
    fireEvent.click(opener);
    const open = screen.getByRole("dialog", { name: "What Zavi knows about you" });
    await waitFor(() => expect(open.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(open).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("has no accept or draft step anywhere", async () => {
    await renderPage();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/accept/i);
    expect(text).not.toMatch(/draft/i);
    expect(text).not.toMatch(/not accepted/i);
  });

  it("never fabricates progress when the baseline or measurement is missing", () => {
    expect(goalProgress({ ...goal, current_value: null })).toBeNull();
    expect(goalProgress({ ...goal, baseline_value: null })).toBeNull();
    expect(goalProgress({ ...goal, current_value: 100 })).toBe(100);
    expect(goalProgress({ ...goal, current_value: 0 })).toBe(0);
  });

  it("shows unavailable sections as unknown rather than empty", async () => {
    await renderPage({ ...data, unreadable: ["goals", "channels"] });
    expect(screen.getByText("Goals could not be loaded.")).toBeTruthy();
    expect(screen.getByText("Channels could not be loaded.")).toBeTruthy();
  });
});

describe("the menu's Your CGO dot", () => {
  it("is held by the page only while it is on screen; hidden or closed, the menu takes it back", async () => {
    __resetNeedsYouStore();
    const { rerender, unmount } = await renderPage();
    await waitFor(() => expect(__needsYouOwner()).toBe("page"));
    rerender(<GrowthCommandCenter data={data} onChanged={vi.fn(async () => {})} onScreen={false} />);
    expect(__needsYouOwner()).toBe("nav");
    rerender(<GrowthCommandCenter data={data} onChanged={vi.fn(async () => {})} onScreen />);
    await waitFor(() => expect(__needsYouOwner()).toBe("page"));
    unmount();
    expect(__needsYouOwner()).toBe("nav");
  });
});

describe("Company and rivals", () => {
  it("reads name, description and competitors from company facts", async () => {
    await renderPage();
    openKnow();
    const card = screen.getByRole("region", { name: "Company" });
    expect(within(card).getByText(/P2P car rental/)).toBeTruthy();
    const rivals = screen.getByRole("region", { name: "Rivals" });
    expect(within(rivals).getByText("Turo")).toBeTruthy();
    expect(within(rivals).getByText("Getaround")).toBeTruthy();
    expect(within(card).queryByText(/to track/i)).toBeNull();
  });

  it("adds a competitor by rewriting the one competitors fact", async () => {
    await renderPage();
    openKnow();
    const rivals = screen.getByRole("region", { name: "Rivals" });
    fireEvent.click(within(rivals).getByRole("button", { name: "Add a rival" }));
    fireEvent.change(screen.getByLabelText("Add a competitor"), {
      target: { value: "Hertz" },
    });
    fireEvent.submit(screen.getByLabelText("Add a competitor").closest("form")!);
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/connectors/company-facts" && c.body)).toBe(true),
    );
    const write = calls.find((c) => c.path === "/api/connectors/company-facts" && c.body);
    expect(write!.body).toEqual({
      facts: [{ key: "competitors", value: "Turo, Getaround, Hertz" }],
    });
  });
});

describe("1. Goals", () => {
  it("counts against three on this page", async () => {
    await renderPage();
    expect(screen.getByText("1 active")).toBeTruthy();
  });

  it("opens the shared editor to edit, and pre-fills it from a suggestion", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit Activate more hosts" }));
    expect(screen.getByRole("dialog").textContent).toBe("Activate more hosts");
    cleanup();
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Improve host activation/ }));
    expect(screen.getByRole("dialog").textContent).toBe("New goal: Improve host activation");
  });

  it("derives the chips from the plan's own stored values", async () => {
    await renderPage();
    const section = screen.getByRole("region", { name: "Your goals" });
    expect(within(section).getByRole("button", { name: /Improve host activation/ })).toBeTruthy();
    expect(within(section).getByRole("button", { name: /Improve demand/ })).toBeTruthy();
    expect(within(section).queryByText(/Grow the email list/)).toBeNull();
    expect(within(section).queryByText(/Lower cost per acquisition/)).toBeNull();
  });

  it("renders NO chips when there is no plan to read them from", async () => {
    await renderPage({ ...data, plan: null });
    const section = screen.getByRole("region", { name: "Your goals" });
    expect(within(section).getByRole("button", { name: "Add a goal" })).toBeTruthy();
    expect(within(section).queryByRole("button", { name: /^Improve / })).toBeNull();
  });

  it("renders no chips when the plan read FAILED, same as no plan", async () => {
    await renderPage({ ...data, unreadable: ["plan"] });
    const section = screen.getByRole("region", { name: "Your goals" });
    expect(within(section).queryByRole("button", { name: /^Improve / })).toBeNull();
  });

  it("skips a blank lever family instead of rendering an empty chip", async () => {
    await renderPage({
      ...data,
      plan: { ...livePlan, constraint_lever_family: "  " },
    });
    const section = screen.getByRole("region", { name: "Your goals" });
    expect(
      within(section).getAllByRole("button", { name: /^Improve / }),
    ).toHaveLength(1);
  });

  it("still offers Add at three active goals: the page stops only at the server's limit", async () => {
    const three = [goal, { ...goal, id: "g2" }, { ...goal, id: "g3" }];
    await renderPage({ ...data, goals: { ...data.goals, max_active: 20, active_count: 3, items: three } });
    expect(screen.getByText("3 active")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Your goals" })).getByRole("button", { name: "Add a goal" })).toBeTruthy();
  });

  it("opens the goal editor from Add a goal", async () => {
    await renderPage();
    fireEvent.click(within(screen.getByRole("region", { name: "Your goals" })).getByRole("button", { name: "Add a goal" }));
    expect(screen.getByRole("dialog").textContent).toBe("New goal: ");
  });
});

const onAutopilot: GrowthPlanPayload = { ...data, head_of_growth: { autopilot: true, note: null, undoable: [] } };

describe("3. What Zavi is doing", () => {
  it("says what Zavi does on each channel, and marks the founder's own add", async () => {
    await renderPage();
    const section = screen.getByRole("region", { name: "What Zavi is doing" });
    expect(within(section).getByTitle("Work seo hard")).toBeTruthy();
    expect(await within(section).findByText("Added by you · runs by itself once Autopilot is on")).toBeTruthy();
    expect(within(section).getByText("Runs by itself once Autopilot is on")).toBeTruthy();
    expect(within(section).queryByRole("switch", { name: /Let CGO run|ask you first/ })).toBeNull();
    expect(within(section).queryByText("Not run yet")).toBeNull();
  });

  it("shows what the bet should move and when to call it failed, with the why", async () => {
    await renderPage({
      ...data,
      bets: [{ ...bet("seo"), expected_effect: "20 more signups a month", falsifier: "no lift by Dec 1" }],
    });
    expect(screen.queryByText("Expected: 20 more signups a month")).toBeNull();
    fireEvent.click(within(screen.getByRole("region", { name: "What Zavi is doing" })).getAllByRole("button", { name: "Why?" })[0]);
    expect(screen.getByText("Expected: 20 more signups a month")).toBeTruthy();
    expect(screen.getByText("Call it failed if: no lift by Dec 1")).toBeTruthy();
  });

  it("shows the constraint as block 2, with its evidence one visible Why? away", async () => {
    await renderPage({
      ...data,
      plan: {
        ...livePlan,
        basis_evidence: [
          { kind: "site", source: "Website", statement: "Most listings have no reviews" },
          { kind: "gap", source: "", statement: "Checkout conversion" },
        ],
      },
    });
    const block = screen.getByRole("region", { name: "What's in the way" });
    expect(within(block).getByText("Demand is not reaching hosts")).toBeTruthy();
    const chip = within(block).getByText("Fairly sure");
    expect(chip.className).toContain("text-inkMuted");
    expect(within(block).queryByText(/confidence/i)).toBeNull();
    expect(block.querySelector(".text-warn, .bg-marigold")).toBeNull();
    expect(within(block).queryByText(/Most listings have no reviews/)).toBeNull();
    fireEvent.click(within(block).getByRole("button", { name: "Why?" }));
    expect(within(block).getByText(/Most listings have no reviews/)).toBeTruthy();
    expect(within(block).getByText("Still unknown: Checkout conversion")).toBeTruthy();
  });

  it("keeps the why one click away", async () => {
    await renderPage();
    expect(screen.queryByText("Why: Because seo converts")).toBeNull();
    fireEvent.click(within(screen.getByRole("region", { name: "What Zavi is doing" })).getAllByRole("button", { name: "Why?" })[0]);
    expect(screen.getByText("Why: Because seo converts")).toBeTruthy();
  });

  it("adds a channel through the founder write, never touching autorun", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add a channel" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Google Ads" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/workspace/growth/channels/google_ads/plan")).toBe(true),
    );
    const write = calls.find((c) => c.path.endsWith("/google_ads/plan"))!;
    expect(write.body).toEqual({ in_plan: true });
    expect(calls.some((c) => c.path.includes("/autorun"))).toBe(false);
  });

  it("offers remove only on the founder's own add", async () => {
    await renderPage();
    expect(screen.getByRole("button", { name: /Remove SMS from the plan/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove SEO from the plan/ })).toBeNull();
  });

  it("stops offering remove once Zavi's plan also works the founder's add", async () => {
    await renderPage({
      ...data,
      channels: [channel("sms", { plan_selected: true, plan_selected_set_by: "founder" })],
      bets: [bet("sms")],
    });
    expect(screen.queryByRole("button", { name: /Remove SMS from the plan/ })).toBeNull();
  });

  it("does not promise the channel will start working on its own", async () => {
    await renderPage({ ...data, channels: [], bets: [] });
    expect(screen.getByText(/Add one to put it in your plan/)).toBeTruthy();
    expect(screen.queryByText(/Zavi starts there/)).toBeNull();
  });

  it("does not count a retired plan's picks as active", async () => {
    await renderPage({
      ...data,
      plan: null,
      bets: [],
      channels: [channel("seo", { plan_selected: true, plan_selected_set_by: "plan" })],
    });
    expect(within(screen.getByRole("region", { name: "What Zavi is doing" })).getByText(/No channels yet/)).toBeTruthy();
  });

  it("asks Zavi to pick channels when there is no plan, and starts watching for it", async () => {
    routes["/api/workspace/growth-strategy/draft"] = { status: "queued" };
    const onDraftStarted = vi.fn();
    render(
      <GrowthCommandCenter
        data={{ ...data, plan: null, bets: [], channels: [] }}
        onChanged={vi.fn(async () => {})}
        onDraftStarted={onDraftStarted}
      />,
    );
    await screen.findByText("Upcar");
    fireEvent.click(screen.getByRole("button", { name: "Or ask Zavi to pick them." }));
    await waitFor(() => expect(onDraftStarted).toHaveBeenCalledTimes(1));
    expect(calls.some((c) => c.path === "/api/workspace/growth-strategy/draft")).toBe(true);
  });

  it("says the strategy is being built while a draft is running", async () => {
    render(
      <GrowthCommandCenter
        data={{ ...data, plan: null, bets: [], channels: [] }}
        onChanged={vi.fn(async () => {})}
        drafting
      />,
    );
    await screen.findByText("Upcar");
    expect(
      screen.getByText(/Building your growth strategy\. This page updates automatically/),
    ).toBeTruthy();
  });

  it("the switch works before a plan is live: CGO reads it for every channel (2026-10-07)", async () => {
    await renderPage({ ...onAutopilot, plan: null, bets: [], channels: [channel("sms", { plan_selected: true, plan_selected_set_by: "founder" })] });
    const btn = screen.getByRole("switch", { name: "Let CGO run SMS" });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("lets CGO run a free channel in one click, through the autorun write", async () => {
    await renderPage(onAutopilot);
    fireEvent.click(screen.getByRole("switch", { name: "Let CGO run SEO" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/workspace/growth/channels/seo/autorun")).toBe(true),
    );
    expect(calls.find((c) => c.path.endsWith("/seo/autorun"))!.body).toEqual({ autorun: true });
  });

  it("asks before letting CGO run a sending channel, and says what Autopilot may send", async () => {
    await renderPage({
      ...onAutopilot,
      channels: [channel("email_marketing", { plan_selected: true, plan_selected_set_by: "founder" })],
    });
    const letRun = () => screen.getByRole("switch", { name: "Let CGO run Email campaigns" });
    fireEvent.click(letRun());
    const confirm = screen.getByRole("alertdialog", { name: "Let CGO run Email campaigns?" });
    expect(confirm.textContent).toContain(
      "CGO may run Email campaigns without asking you. Marketing email sends go out within Autopilot's limits (up to 1,000 people, one send per list a week); anything else it would send to your customers still waits for you.",
    );
    expect(calls.some((c) => c.path.includes("/autorun"))).toBe(false);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.path.includes("/autorun"))).toBe(false);
    fireEvent.click(letRun());
    fireEvent.click(screen.getByRole("button", { name: "Yes, let it run" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/email_marketing/autorun"))?.body).toEqual({ autorun: true }),
    );
  });

  it("does not claim SMS sends: it has no send tool, so no confirm", async () => {
    await renderPage(onAutopilot);
    fireEvent.click(screen.getByRole("switch", { name: "Let CGO run SMS" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/sms/autorun"))?.body).toEqual({ autorun: true }),
    );
  });

  it("sets a channel CGO may run back to asking first", async () => {
    await renderPage({ ...onAutopilot, channels: [channel("seo", { plan_selected: true, plan_selected_set_by: "plan", autorun: true })] });
    expect(await screen.findByText(/^CGO may run this/)).toBeTruthy();
    expect(screen.queryByText(/runs on its own/i)).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Make SEO ask you first" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/seo/autorun"))?.body).toEqual({ autorun: false }),
    );
  });
});

describe("Connectors", () => {
  it("leads with Google Analytics and counts every connected connector", async () => {
    await renderPage();
    openKnow();
    const section = screen.getByRole("region", { name: "Your data" });
    await within(section).findByText("2 sources connected");
    expect(within(section).getByRole("button", { name: /Connect Google Analytics/ })).toBeTruthy();
    expect(within(section).getByText("Google Search Console")).toBeTruthy();
  });
});

describe("Numbers the page must not contradict", () => {
  it("shows a goal's LIVE value, the same one its editor reads", async () => {
    const mrr: GrowthGoal = { ...goal, id: "g-mrr", objective: "Grow MRR", target_metric: "mrr", current_value: 895, target_value: 100000, baseline_value: null, measurement_mode: "auto" };
    routes["/api/workspace/autopilot/goals/current-value?metric=mrr"] = { measured: true, value: 994 };
    await renderPage({ ...data, goals: { ...data.goals, items: [mrr] } });
    await screen.findByText(/^MRR \$994 \/ \$100,000/);
    expect(document.body.textContent).not.toMatch(/\$895/);
  });

  it("paces over the exact time left, not whole weeks rounded down", () => {
    const hosts: GrowthGoal = { ...goal, current_value: 612, target_value: 800, baseline_value: 500, due_date: "2026-09-30" };
    const pace = goalPace(hosts, new Date("2026-09-11T00:00:00Z"))!;
    expect(Math.round(pace.perWeekExact)).toBe(69);
    expect(Math.round(pace.perWeek)).toBe(94);
  });

  it("does not suggest a connector that is already connected", async () => {
    routes["/api/connectors"] = { connectors: [{ slug: "slack" }, { slug: "posthog" }] };
    routes["/api/connectors/recommendations"] = {
      recommendations: [
        { slug: "posthog", name: "PostHog", connected: false, recommended: true },
        { slug: "google_search_console", name: "Google Search Console", connected: false, recommended: true },
      ],
    };
    await renderPage();
    openKnow();
    const section = screen.getByRole("region", { name: "Your data" });
    await within(section).findByText("Google Search Console");
    expect(within(section).queryByRole("button", { name: "Connect PostHog" })).toBeNull();
  });

  it("counts data sources, not chat apps", async () => {
    routes["/api/connectors"] = { connectors: [{ slug: "slack" }, { slug: "github" }, { slug: "telegram" }, { slug: "discord" }] };
    await renderPage();
    openKnow();
    await within(screen.getByRole("region", { name: "Your data" })).findByText("2 sources connected");
  });

  it("names Zavi's agents in plain words, never by internal slug", async () => {
    routes["/api/connectors/recommendations"] = {
      recommendations: [
        { slug: "google_search_console", name: "Google Search Console", connected: false, recommended: true, rationale: "seo-geo reads real clicks." },
      ],
    };
    await renderPage();
    await screen.findByTitle("Zavi's SEO agent reads real clicks.");
    expect(document.body.innerHTML).not.toMatch(/seo-geo/);
  });
});

describe("Errors and keyboard", () => {
  it("explains a failed channel add in plain words, inside Channels", async () => {
    routes["/api/workspace/growth/channels/google_ads/plan"] = {
      __status: 500,
      body: { error: { code: "write_failed", message: "Could not find the function public.set_channel_in_plan" } },
    };
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add a channel" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Google Ads" }));
    const section = screen.getByRole("region", { name: "What Zavi is doing" });
    const alert = await within(section).findByRole("alert");
    expect(alert.textContent).toMatch(/Could not add Google Ads/);
    expect(document.body.textContent).not.toMatch(/set_channel_in_plan|function public/);
  });

  it("uses a real letter for the initial when the name starts with an emoji", async () => {
    routes["/api/connectors/company-facts"] = { facts: [{ key: "company_name", value_text: "🚗 wheels" }] };
    render(<GrowthCommandCenter data={data} onChanged={vi.fn(async () => {})} />);
    await screen.findByText("🚗 wheels");
    openKnow();
    const card = screen.getByRole("region", { name: "Company" });
    expect(card.textContent).toContain("W");
    expect(card.textContent).not.toMatch(/\ud83d(?!\ude97)/);
  });
});

describe("The plan is always live", () => {
  it("applies a draft written before the rule, through /apply and never /accept", async () => {
    const onChanged = vi.fn(async () => {});
    await act(async () => {
      render(
        <GrowthCommandCenter
          data={{ ...data, plan: { ...livePlan, pending_acceptance: true } }}
          onChanged={onChanged}
        />,
      );
    });
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/api/workspace/growth-strategy/apply")).toHaveLength(1),
    );
    expect(calls.some((c) => c.path.endsWith("/accept"))).toBe(false);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("does not apply anything for a live plan", async () => {
    await renderPage();
    expect(calls.some((c) => c.path.endsWith("/apply"))).toBe(false);
  });

});

describe("Plan detail inside the sections", () => {
  const detail = {
    company_facts: [{ fact: "Pro plan is $49 a month", source_url: "https://www.acme.com/pricing" }],
    growth_moves: [
      {
        title: "Guided setup",
        lever: "activation",
        action: "Add a three-step setup checklist",
        rationale: "Most accounts stop at setup",
        expected_effect: "Setup completion 22% to 32% in 6 weeks",
        falsifier: "Below 26% six weeks after launch",
      },
    ],
    first_steps: [{ when: "Day 1-2", step: "Pull the last 8 weeks of signups" }],
    target_rationale: "Doubling setup completion is a stretch the moves can reach.",
    summary: "A project tool for small agencies with a 30-day trial.",
    also_fix: "Add a one-click import from the tools trials come from.",
  };

  it("shows the plan's detail inside the blocks, not as new ones", async () => {
    await renderPage({ ...data, detail });
    expect(regionNames()).toEqual([
      "Growth brief",
      "Your goals",
      "What's in the way",
      "What Zavi is doing",
      "What happened",
      "What needs you",
    ]);

    openKnow();
    const company = screen.getByRole("region", { name: "Company" });
    fireEvent.click(within(company).getByRole("button", { name: /What Zavi found/ }));
    expect(within(company).getByText(/Pro plan is \$49 a month/)).toBeTruthy();
    expect(within(company).getByRole("link", { name: "acme.com" }).getAttribute("href")).toBe("https://www.acme.com/pricing");

    expect(within(company).getByText("A project tool for small agencies with a 30-day trial.")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    const goals = screen.getByRole("region", { name: "Your goals" });
    expect(within(goals).queryByText("Pull the last 8 weeks of signups")).toBeNull();
    fireEvent.click(within(goals).getByRole("button", { name: "Why this target" }));
    expect(within(goals).getByText("Doubling setup completion is a stretch the moves can reach.")).toBeTruthy();
    expect(within(goals).getByText("Pull the last 8 weeks of signups")).toBeTruthy();

    const blocker = screen.getByRole("region", { name: "What's in the way" });
    fireEvent.click(within(blocker).getByRole("button", { name: "Why?" }));
    expect(within(blocker).getByText("Also fix: Add a one-click import from the tools trials come from.")).toBeTruthy();

    const channels = screen.getByRole("region", { name: "What Zavi is doing" });
    expect(within(channels).getByText("Guided setup")).toBeTruthy();
    expect(within(channels).queryByText("Expected: Setup completion 22% to 32% in 6 weeks")).toBeNull();
    fireEvent.click(within(channels).getByRole("button", { name: "Show more" }));
    expect(within(channels).getByText("Expected: Setup completion 22% to 32% in 6 weeks")).toBeTruthy();
    expect(within(channels).getByText("Call it failed if: Below 26% six weeks after launch")).toBeTruthy();
  });

  it("renders nothing extra for a plan with no detail (older plans)", async () => {
    await renderPage(data);
    expect(screen.queryByText("What Zavi found")).toBeNull();
    expect(screen.queryByText("Growth moves")).toBeNull();
    expect(screen.queryByText("First two weeks")).toBeNull();
  });
});

describe("while the strategy is building", () => {
  const empty: GrowthPlanPayload = {
    ...data,
    plan: null,
    goals: { active_count: 0, max_active: 3, over_cap: false, items: [] },
    channels: [channel("seo")],
    bets: [],
  };

  it("shows loaders, never the empty lines", async () => {
    render(<GrowthCommandCenter data={empty} onChanged={vi.fn(async () => {})} building />);
    await screen.findByText("Upcar");
    expect(screen.getByRole("status", { name: "Setting your goals" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Working out what's in the way" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Picking your channels" })).toBeTruthy();
    expect(screen.queryByText("No goal yet.")).toBeNull();
    expect(screen.queryByText("Not worked out yet.")).toBeNull();
  });

  it("keeps the goal set at onboarding on screen while the rest builds", async () => {
    render(
      <GrowthCommandCenter
        data={{ ...empty, goals: { active_count: 1, max_active: 3, over_cap: false, items: [goal] } }}
        onChanged={vi.fn(async () => {})}
        building
      />,
    );
    await screen.findByText("Upcar");
    expect(screen.queryByRole("status", { name: "Setting your goals" })).toBeNull();
    expect(await screen.findByRole("region", { name: "Your goals" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Working out what's in the way" })).toBeTruthy();
  });

  it("fills every section once the plan lands", async () => {
    const { rerender } = render(<GrowthCommandCenter data={empty} onChanged={vi.fn(async () => {})} building />);
    await screen.findByText("Upcar");
    rerender(<GrowthCommandCenter data={data} onChanged={vi.fn(async () => {})} building={false} />);
    expect(await screen.findByText("Demand is not reaching hosts")).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Your goals" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Picking your channels" })).toBeNull();
  });
});
