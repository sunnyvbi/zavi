// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { creditRefusalFrom } from "@/lib/workspace/creditRefusal";
import type { GrowthChannel, GrowthGoal, GrowthPlanPayload } from "@/lib/workspace/useGrowthPlan";
import { homeResponseFor } from "./testHomeFixture";

const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
let routes: Record<string, unknown> = {};
const apiFetchMock = vi.fn(async (path: string, opts?: { method?: string; body?: string }) => {
  calls.push({ path, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : undefined });
  if (!(path in routes) && path.startsWith("/api/approvals?home=")) {
    const base = routes["/api/approvals"] as { __status?: number; body?: unknown } | undefined;
    if (base?.__status) return { ok: false, status: base.__status, json: async () => base.body, clone() { return this; } } as unknown as Response;
    const body = homeResponseFor(path, base as never);
    return { ok: true, status: 200, json: async () => body, clone() { return this; } } as unknown as Response;
  }
  const route = routes[path];
  if (typeof route === "function") {
    const body = await (route as () => Promise<unknown>)();
    return { ok: true, status: 200, json: async () => body, clone() { return this; } } as unknown as Response;
  }
  const hit = route as { __status?: number; body?: unknown } | undefined;
  const status = hit?.__status ?? 200;
  return {
    ok: status < 400,
    status,
    json: async () => (hit?.__status ? hit.body : hit) ?? { ok: true },
    clone() {
      return this;
    },
  } as unknown as Response;
});
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts?: { method?: string; body?: string }) => apiFetchMock(path, opts),
}));

vi.mock("../AutopilotGoalsPanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../AutopilotGoalsPanel")>()),
  GoalEditor: ({
    goal,
    initialObjective,
    onPause,
  }: {
    goal: { objective: string } | null;
    initialObjective?: string;
    onPause?: () => Promise<void>;
  }) => (
    <>
      <div role="dialog">{goal?.objective ?? `New goal: ${initialObjective ?? ""}`}</div>
      {onPause && (
        <button type="button" onClick={() => void onPause()}>
          Pause goal
        </button>
      )}
    </>
  ),
}));

vi.mock("./GrowthReviewList", () => ({
  GrowthReviewList: ({ inChannels }: { inChannels: Record<string, number> }) => (
    <div data-testid="review-list">{JSON.stringify(inChannels)}</div>
  ),
}));

const connectFlow = vi.fn(async (_slug: string) => {});
vi.mock("../settings/reconnectFlows", () => ({ startReconnectFlow: (slug: string) => connectFlow(slug) }));

const runPressSpy = vi.fn();
vi.mock("../layout/useChannelRunPress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../layout/useChannelRunPress")>();
  return {
    ...actual,
    useChannelRunPress: (args: Parameters<typeof actual.useChannelRunPress>[0]) => {
      runPressSpy(args.slug);
      return actual.useChannelRunPress(args);
    },
  };
});

const setupFlag = vi.hoisted(() => ({ oneState: false }));
vi.mock("../setup/SetupProvider", () => ({
  useSetupOptional: () => (setupFlag.oneState ? { state: { enabled: true, one_state: true } } : null),
}));

import { GrowthCommandCenter } from "./GrowthCommandCenter";
import { requestQuestionsJump, takeQuestionsJump } from "../WaitingForYou";
import { resetChannelLocksCache } from "../layout/useChannelLocks";

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
  measurement_mode: "auto",
};

const channel = (slug: string, over: Partial<GrowthChannel> = {}): GrowthChannel => ({
  slug,
  last_run_at: null,
  last_run_status: null,
  metric_availability: "none",
  metric_keys: [],
  autorun: false,
  autorun_set_by: "",
  plan_selected: true,
  plan_selected_set_by: "plan",
  ...over,
});

const plan = {
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

const full: GrowthPlanPayload = {
  plan,
  goals: { active_count: 1, max_active: 20, over_cap: false, items: [goal] },
  channels: [channel("seo", { last_run_at: "2026-09-20T00:00:00Z" })],
  metrics: [],
  bets: [
    {
      id: "b1",
      channel_slug: "seo",
      intent: "Win local searches",
      rationale: null,
      expected_effect: null,
      falsifier: null,
      status: "accepted",
      rejected_reason: null,
      sort_order: 1,
    },
  ],
  changes: [],
  unreadable: [],
};

const empty: GrowthPlanPayload = {
  plan: null,
  goals: { active_count: 0, max_active: 20, over_cap: false, items: [] },
  channels: [],
  metrics: [],
  bets: [],
  changes: [],
  unreadable: [],
};

const voice = {
  brand_voice: "Plain and warm.",
  base_tone: "default",
  warm: false,
  enthusiastic: false,
  response_rules: "",
  updated_by: "u1",
  updated_at: "2026-09-20",
};

beforeEach(() => {
  calls.length = 0;
  runPressSpy.mockClear();
  connectFlow.mockClear();
  try {
    window.localStorage.clear();
  } catch {
  }
  routes = {
    "/api/connectors/company-facts": {
      facts: [
        { key: "company_name", value_text: "Upcar" },
        { key: "what_we_sell", value_text: "P2P car rental" },
        { key: "competitors", value_text: "Turo" },
      ],
    },
    "/api/connectors": { connectors: [{ slug: "google_analytics" }] },
    "/api/connectors/recommendations": { recommendations: [] },
    "/api/approvals": { channel_pending_counts: {}, decisions: [] },
    "/api/channels": { channels: [{ channel_slug: "seo", work_state: "idle", run_reserve_credits: 340 }] },
    "/api/personalization": { personalization: voice },
    "/api/workspace/autopilot/goals/current-value?metric=host_activation": { measured: true, value: 30 },
  };
});
afterEach(() => {
  cleanup();
  setupFlag.oneState = false;
});

async function renderPage(d: GrowthPlanPayload, onAsk?: (t: string) => void) {
  const onChanged = vi.fn(async () => {});
  const utils = render(<GrowthCommandCenter data={d} onChanged={onChanged} onAsk={onAsk} />);
  await screen.findByText("Upcar");
  return { ...utils, onChanged };
}

const headline = () => screen.getByRole("region", { name: "Growth brief" });
const needs = () => screen.getByRole("region", { name: "What needs you" });
const openKnow = () => fireEvent.click(screen.getByRole("button", { name: "What Zavi knows about you" }));

describe("the story renders every step, with and without data", () => {
  it("fills each block from a company with a plan", async () => {
    await renderPage(full);
    expect(await within(headline()).findByText("Growth brief for Upcar · from Zavi")).toBeTruthy();
    const goals = screen.getByRole("region", { name: "Your goals" });
    expect(within(goals).getByTitle("Activate more hosts")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "What's in the way" })).getByText("Demand is not reaching hosts")).toBeTruthy();
    const doing = screen.getByRole("region", { name: "What Zavi is doing" });
    expect(within(doing).getByTitle("Win local searches")).toBeTruthy();
    expect(within(doing).getByText("Runs by itself once Autopilot is on")).toBeTruthy();
    openKnow();
    expect(within(await screen.findByRole("region", { name: "Brand voice" })).getByText("Plain and warm.")).toBeTruthy();
  });

  it("keeps the same blocks for a new company, with honest empty slots", async () => {
    routes["/api/connectors/company-facts"] = { facts: [{ key: "company_name", value_text: "Upcar" }] };
    await renderPage(empty);
    expect(screen.getByText("No goal yet.")).toBeTruthy();
    expect(screen.getByText("Not worked out yet.")).toBeTruthy();
    expect(screen.getByText(/No channels yet/)).toBeTruthy();
    expect(await screen.findByText("None yet. I will not guess them.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d+%|a week/);
  });
});

describe("the headline", () => {
  it("counts what waits for an OK, and unfolds the list in the page", async () => {
    routes["/api/approvals"] = {
      channel_pending_counts: { seo: 2 },
      decisions: [
        { decision_class: "channel.recipe_step", channel_slug: null },
        { decision_class: "social.publish.v2", channel_slug: "seo" },
      ],
    };
    await renderPage(full);
    expect(await within(headline()).findByText("3 actions wait for your OK.")).toBeTruthy();
    expect(within(headline()).getByRole("button", { name: /3\s*need you/ })).toBeTruthy();
    expect(within(needs()).getByText("3 waiting · 2 to approve · 1 for you")).toBeTruthy();
    fireEvent.click(within(needs()).getByRole("button", { name: "Review all 3" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(needs()).getByTestId("review-list").textContent).toBe('{"seo":2}');
    fireEvent.click(within(needs()).getByRole("button", { name: "Hide list" }));
    expect(within(needs()).queryByTestId("review-list")).toBeNull();
  });

  it("asks for a goal first when there is none, through the goal editor", async () => {
    await renderPage({ ...full, goals: empty.goals });
    expect(await within(headline()).findByText("I have no goal to work toward yet.")).toBeTruthy();
    fireEvent.click(within(headline()).getByRole("button", { name: "Add a goal" }));
    expect(screen.getByRole("dialog").textContent).toBe("New goal: ");
  });

  it("asks to connect the goal's OWN source, not Google Analytics", async () => {
    const mrr = { ...goal, id: "g-mrr", objective: "Grow MRR", target_metric: "mrr", current_value: 900 };
    routes["/api/workspace/autopilot/goals/current-value?metric=mrr"] = { measured: false };
    await renderPage({ ...full, goals: { ...full.goals, items: [mrr] } });
    expect(await within(headline()).findByText("I can't measure your goal yet.")).toBeTruthy();
    const link = within(headline()).getByRole("link", { name: "Connect Stripe" });
    expect(link.getAttribute("href")).toBe("/workspace?tab=brain#connector-stripe");
    expect(connectFlow).not.toHaveBeenCalled();
  });

  it("sends a missing Operator DB to its Toolkit form too", async () => {
    const trips = { ...goal, id: "g-trips", objective: "More trips", target_metric: "trips", current_value: null };
    routes["/api/workspace/autopilot/goals/current-value?metric=trips"] = { measured: false };
    await renderPage({ ...full, goals: { ...full.goals, items: [trips] } });
    const link = await within(headline()).findByRole("link", { name: "Connect Your database" });
    expect(link.getAttribute("href")).toBe("/workspace?tab=brain#connector-operator_db");
  });

  it("retries a failed goal read on Check again, and leaves the unknown line", async () => {
    routes["/api/workspace/autopilot/goals/current-value?metric=host_activation"] = { __status: 500, body: {} };
    await renderPage(full);
    fireEvent.click(await within(headline()).findByRole("button", { name: "Check again" }));
    routes["/api/workspace/autopilot/goals/current-value?metric=host_activation"] = { measured: true, value: 31 };
    fireEvent.click(within(headline()).getByRole("button", { name: "Check again" }));
    expect(await within(headline()).findByText("Nothing needs you right now.")).toBeTruthy();
  });

  it("does not re-read a settled goal on a plan refresh, but retries a failed one", async () => {
    const reads = (metric: string) =>
      calls.filter((c) => c.path === `/api/workspace/autopilot/goals/current-value?metric=${metric}`).length;
    const failing = { ...goal, id: "g-mrr", objective: "Grow MRR", target_metric: "mrr", priority: 0 };
    routes["/api/workspace/autopilot/goals/current-value?metric=mrr"] = { __status: 500, body: {} };
    const items = [goal, failing];
    const { rerender } = await renderPage({ ...full, goals: { ...full.goals, items } });
    await waitFor(() => expect(reads("mrr")).toBe(1));
    expect(reads("host_activation")).toBe(1);
    const approvalsBefore = calls.filter((c) => c.path === "/api/approvals").length;
    rerender(<GrowthCommandCenter data={{ ...full, goals: { ...full.goals, items } }} onChanged={vi.fn(async () => {})} />);
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/approvals").length).toBeGreaterThan(approvalsBefore));
    await waitFor(() => expect(reads("mrr")).toBe(2));
    expect(reads("host_activation")).toBe(1);
  });

  it("re-reads every goal on Check again", async () => {
    routes["/api/approvals"] = { __status: 500, body: {} };
    await renderPage(full);
    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith("current-value?metric=host_activation"))).toHaveLength(1),
    );
    fireEvent.click(await within(headline()).findByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith("current-value?metric=host_activation"))).toHaveLength(2),
    );
  });

  it("keeps a Check again read that a plan refresh interrupted, and shows the new value", async () => {
    routes["/api/personalization"] = { __status: 500, body: {} };
    const { rerender } = await renderPage(full);
    const goals = () => screen.getByRole("region", { name: "Your goals" });
    await waitFor(() => expect(within(goals()).getByText(/^Host Activation 30 \/ 40/)).toBeTruthy());
    let release: (body: unknown) => void = () => {};
    const answer = new Promise((resolve) => {
      release = resolve;
    });
    routes["/api/workspace/autopilot/goals/current-value?metric=host_activation"] = () => answer;
    fireEvent.click(await within(headline()).findByRole("button", { name: "Check again" }));
    rerender(<GrowthCommandCenter data={{ ...full }} onChanged={vi.fn(async () => {})} />);
    release({ measured: true, value: 35 });
    await waitFor(() => expect(within(goals()).getByText(/^Host Activation 35 \/ 40/)).toBeTruthy());
  });

  it("retries a failed goal read on the next plan refresh", async () => {
    routes["/api/workspace/autopilot/goals/current-value?metric=host_activation"] = { __status: 500, body: {} };
    const { rerender } = await renderPage(full);
    expect(await within(headline()).findByText("I couldn't check everything just now.")).toBeTruthy();
    routes["/api/workspace/autopilot/goals/current-value?metric=host_activation"] = { measured: true, value: 31 };
    rerender(<GrowthCommandCenter data={{ ...full }} onChanged={vi.fn(async () => {})} />);
    expect(await within(headline()).findByText("Nothing needs you right now.")).toBeTruthy();
  });

  it("asks for this week's number on a manual goal, in the goal editor", async () => {
    const manual = { ...goal, id: "g-man", objective: "Book parent tours", target_metric: "parent_tours", current_value: null };
    await renderPage({ ...full, goals: { ...full.goals, items: [manual] } });
    fireEvent.click(await within(headline()).findByRole("button", { name: "Enter this week's number" }));
    expect(screen.getByRole("dialog").textContent).toBe("Book parent tours");
  });

  it("treats a goal read that failed as unknown, never as measured", async () => {
    routes["/api/workspace/autopilot/goals/current-value?metric=host_activation"] = { __status: 500, body: {} };
    await renderPage(full);
    expect(await within(headline()).findByText("I couldn't check everything just now.")).toBeTruthy();
    expect(within(headline()).queryByText(/Nothing needs you/)).toBeNull();
  });

  it("asks rather than claims when a connected source still reads nothing", async () => {
    routes["/api/workspace/autopilot/goals/current-value?metric=host_activation"] = { measured: false };
    const onAsk = vi.fn();
    await renderPage(full, onAsk);
    expect(await within(headline()).findByText("I can't measure your goal yet.")).toBeTruthy();
    fireEvent.click(within(headline()).getByRole("button", { name: "Ask how to measure it" }));
    expect(onAsk).toHaveBeenCalledWith("How can you start measuring my goal?");
  });

  it("starts the first channel through the shared Run press", async () => {
    await renderPage({ ...full, channels: [channel("seo")] });
    expect(await within(headline()).findByText("Nothing has run yet. Start SEO?")).toBeTruthy();
    expect(within(headline()).getByText("About 340 credits")).toBeTruthy();
    routes["/api/channels/seo/run"] = { run_id: "run-12345678" };
    fireEvent.click(within(headline()).getByRole("button", { name: "Start SEO" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/channels/seo/run")).toBe(true));
    expect(runPressSpy).toHaveBeenCalledWith("seo");
    const post = calls.find((c) => c.path === "/api/channels/seo/run")!;
    expect(typeof (post.body as { request_id?: unknown }).request_id).toBe("string");
    expect(await within(headline()).findByText("Waiting for the first run. Nothing else needs you.")).toBeTruthy();
  });

  it("never offers Start on a channel the plan does not include", async () => {
    resetChannelLocksCache();
    routes["/api/channels"] = { channels: [], channel_locks: { seo: "starter" } };
    await renderPage({ ...full, channels: [channel("seo")] });
    expect(await within(headline()).findByText("Your plan's channels need a higher plan.")).toBeTruthy();
    expect(within(headline()).queryByRole("button", { name: "Start SEO" })).toBeNull();
    resetChannelLocksCache();
  });

  it("shows a credit refusal with the shared refusal notice, and starts nothing", async () => {
    const refusal = { error: { code: "insufficient_credits", message: "Out of credits" } };
    routes["/api/channels/seo/run"] = { __status: 402, body: refusal };
    await renderPage({ ...full, channels: [channel("seo")] });
    fireEvent.click(await within(headline()).findByRole("button", { name: "Start SEO" }));
    const expected = creditRefusalFrom(refusal, "channel")!;
    expect(await within(headline()).findByText(expected.headline, { exact: false })).toBeTruthy();
    expect(within(headline()).getByText("Nothing has run yet. Start SEO?")).toBeTruthy();
  });

  it("asks for rivals, and opens the drawer on the rival box", async () => {
    routes["/api/connectors/company-facts"] = { facts: [{ key: "company_name", value_text: "Upcar" }] };
    await renderPage(full);
    expect(screen.queryByRole("dialog", { name: "What Zavi knows about you" })).toBeNull();
    fireEvent.click(await within(headline()).findByRole("button", { name: "Add rivals" }));
    const drawer = screen.getByRole("dialog", { name: "What Zavi knows about you" });
    expect(within(drawer).getByLabelText("Add a competitor")).toBeTruthy();
  });

  it("asks for a brand voice, and opens the drawer on its editor", async () => {
    routes["/api/personalization"] = { personalization: { ...voice, brand_voice: "" } };
    await renderPage(full);
    fireEvent.click(await within(headline()).findByRole("button", { name: "Set brand voice" }));
    const drawer = screen.getByRole("dialog", { name: "What Zavi knows about you" });
    expect(within(drawer).getByLabelText("How we sound")).toBeTruthy();
  });

  it("says nothing needs you only once everything is read and done", async () => {
    const onAsk = vi.fn();
    await renderPage(full, onAsk);
    expect(await within(headline()).findByText("Nothing needs you right now.")).toBeTruthy();
    expect(within(headline()).queryByRole("button", { name: /need you|Ask what happens next/ })).toBeNull();
    expect(within(needs()).getByText("Nothing needs you right now.")).toBeTruthy();
  });

  it("never says nothing needs you when the approvals read failed", async () => {
    routes["/api/approvals"] = { __status: 500, body: {} };
    await renderPage(full);
    expect(await within(headline()).findByText("I couldn't check everything just now.")).toBeTruthy();
    expect(within(headline()).queryByText(/Nothing needs you/)).toBeNull();
    expect(within(needs()).getByText(/Couldn.t check what needs you/)).toBeTruthy();
    expect(within(needs()).queryByText(/Nothing needs you/)).toBeNull();
    expect(within(headline()).queryByRole("button", { name: /need you/ })).toBeNull();
  });
});

describe("goal rows", () => {
  it("pauses a goal from the goal editor, through the goals panel's own PATCH", async () => {
    const { onChanged } = await renderPage(full);
    const block = screen.getByRole("region", { name: "Your goals" });
    expect(within(block).queryByRole("button", { name: /^Pause/ })).toBeNull();
    fireEvent.click(within(block).getByRole("button", { name: "Edit Activate more hosts" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause goal" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/workspace/autopilot/goals/goal-1")).toBe(true));
    const write = calls.find((c) => c.path === "/api/workspace/autopilot/goals/goal-1")!;
    expect(write.method).toBe("PATCH");
    expect(write.body).toEqual({ status: "paused" });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("leads with the highest-priority goal and lists the rest small", async () => {
    const second = { ...goal, id: "g2", objective: "Grow repeat visits", target_metric: "repeat_visits", priority: 0 };
    await renderPage({ ...full, goals: { ...full.goals, items: [second, goal] } });
    const block = screen.getByRole("region", { name: "Your goals" });
    const text = block.textContent ?? "";
    expect(text.indexOf("Host Activation")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Host Activation")).toBeLessThan(text.indexOf("Repeat Visits"));
  });

  it("shows every active goal as one compact row", async () => {
    const others = [2, 3, 4, 5].map((n) => ({
      ...goal,
      id: `g${n}`,
      objective: `Goal ${n}`,
      target_metric: `metric_${n}`,
      priority: 0,
    }));
    await renderPage({ ...full, goals: { ...full.goals, items: [goal, ...others] } });
    const block = screen.getByRole("region", { name: "Your goals" });
    for (const n of [2, 3, 4, 5]) expect(within(block).getByTitle(`Goal ${n}`)).toBeTruthy();
    expect(within(block).queryByRole("button", { name: /Show \d+ more/ })).toBeNull();
  });

  it("shows goals as plain rows: short title and date, Edit buttons, no links", async () => {
    const other = { ...goal, id: "g2", objective: "Grow repeat visits", target_metric: "repeat_visits", priority: 0, due_date: "2026-12-23" };
    await renderPage({ ...full, goals: { ...full.goals, items: [goal, other] } }, vi.fn());
    const block = screen.getByRole("region", { name: "Your goals" });
    const lead = within(block).getByRole("button", { name: "Edit Activate more hosts" });
    await waitFor(() => expect(lead.textContent).toBe("Host Activation 30 / 40" + "by Dec 31"));
    const row = within(block).getByRole("button", { name: "Edit Grow repeat visits" });
    expect(row.textContent).toBe("Repeat Visits 30 / 40" + "by Dec 23");
    expect(within(block).queryByRole("button", { name: /^(Ask|Pause)/ })).toBeNull();
    expect(within(block).queryByRole("link")).toBeNull();
    expect(within(block).queryByText("Not counted yet")).toBeNull();
    expect(within(block).queryByText(/On pace|Behind/)).toBeNull();
  });

  it("opens the goal editor when a row is clicked", async () => {
    const other = { ...goal, id: "g2", objective: "Grow repeat visits", target_metric: "repeat_visits", priority: 0 };
    await renderPage({ ...full, goals: { ...full.goals, items: [goal, other] } });
    fireEvent.click(screen.getByRole("button", { name: "Edit Grow repeat visits" }));
    expect(screen.getByRole("dialog").textContent).toBe("Grow repeat visits");
  });

  it("marks each goal with no number, and offers today's number in the editor", async () => {
    const manual = { ...goal, id: "g-man", objective: "Book parent tours", target_metric: "parent_tours", current_value: null };
    const mrr = { ...goal, id: "g-mrr", objective: "Grow MRR", target_metric: "mrr", current_value: 900, priority: 0 };
    routes["/api/workspace/autopilot/goals/current-value?metric=mrr"] = { measured: false };
    await renderPage({ ...full, goals: { ...full.goals, items: [goal, manual, mrr] } }, vi.fn());
    const block = screen.getByRole("region", { name: "Your goals" });
    await waitFor(() => expect(within(block).getAllByText("Not counted yet")).toHaveLength(2));
    const enter = within(block).getAllByRole("button", { name: "Enter today's number" });
    expect(enter).toHaveLength(2);
    fireEvent.click(enter[0]);
    expect(screen.getByRole("dialog").textContent).toBe("Book parent tours");
  });

  it("has no Not-counted pill when every goal has a number", async () => {
    await renderPage(full);
    const block = screen.getByRole("region", { name: "Your goals" });
    expect(await within(block).findByText(/^Host Activation 30 \/ 40/)).toBeTruthy();
    expect(within(block).queryByText(/not counted yet/i)).toBeNull();
  });

  it("keeps Add open past three goals, up to the server's limit", async () => {
    const five = [1, 2, 3, 4, 5].map((n) => ({ ...goal, id: `g${n}`, target_metric: `metric_${n}` }));
    await renderPage({ ...full, goals: { ...full.goals, items: five } });
    const block = screen.getByRole("region", { name: "Your goals" });
    expect(within(block).getByRole("button", { name: "Add a goal" })).toBeTruthy();
    expect(within(block).queryByText(/is the most this plan chases/)).toBeNull();
  });

  it("says how to make room only at the limit, with the real number", async () => {
    const twenty = Array.from({ length: 20 }, (_, n) => ({ ...goal, id: `g${n}`, target_metric: `metric_${n}` }));
    await renderPage({ ...full, goals: { ...full.goals, items: twenty } });
    const block = screen.getByRole("region", { name: "Your goals" });
    expect(within(block).queryByRole("button", { name: "Add a goal" })).toBeNull();
    expect(
      within(block).getByText("20 goals is the most this plan chases at once. Pause one to add another."),
    ).toBeTruthy();
  });
});

describe("the headline stays current and honest", () => {
  it("re-reads approvals on every plan refresh", async () => {
    const { rerender } = await renderPage(full);
    expect(await within(headline()).findByText("Nothing needs you right now.")).toBeTruthy();
    routes["/api/approvals"] = { channel_pending_counts: { seo: 1 }, decisions: [] };
    rerender(<GrowthCommandCenter data={{ ...full }} onChanged={vi.fn(async () => {})} />);
    expect(await within(headline()).findByText("1 action waits for your OK.")).toBeTruthy();
  });

  it("drops back to unknown when a refresh read throws", async () => {
    const { rerender } = await renderPage(full);
    expect(await within(headline()).findByText("Nothing needs you right now.")).toBeTruthy();
    apiFetchMock.mockImplementationOnce(async () => {
      throw new Error("network down");
    });
    rerender(<GrowthCommandCenter data={{ ...full }} onChanged={vi.fn(async () => {})} />);
    expect(await within(headline()).findByText("I couldn't check everything just now.")).toBeTruthy();
  });

  it("counts every growth item past one page exactly, from the home list's true total", async () => {
    routes["/api/approvals"] = { channel_pending_counts: {}, decisions: [] };
    routes["/api/approvals?home=growth&count=1&limit=100"] = {
      decisions: [],
      next_cursor: "more",
      totals: { growth: 212, channel: 0, needs_you: 40 },
    };
    await renderPage(full);
    expect(await within(headline()).findByText("212 actions wait for your OK.")).toBeTruthy();
    expect(within(needs()).getByRole("button", { name: "Review all 212" })).toBeTruthy();
    expect(within(headline()).getByRole("button", { name: /212\s*need you/ })).toBeTruthy();
  });

  it("says block 2 could not load when the plan read failed", async () => {
    await renderPage({ ...full, unreadable: ["plan"] });
    const block = screen.getByRole("region", { name: "What's in the way" });
    expect(within(block).getByText(/Couldn.t load this/)).toBeTruthy();
    expect(within(block).queryByText("Not worked out yet.")).toBeNull();
  });
});

describe("the line under the header", () => {
  it("says when Zavi checks in next, and opens the full note in a drawer", async () => {
    const hog = {
      autopilot: false,
      note: {
        saw: ["Signups held at 40 a week."],
        changed: [],
        would_change: [],
        need: ["Add the Meta pixel to checkout."],
        questions: [],
        created_at: "2026-09-28T00:00:00Z",
        next_review_at: "2026-10-04T12:00:00Z",
      },
      undoable: [],
    };
    await renderPage({ ...full, head_of_growth: hog });
    expect(within(headline()).getByText(/Next check-in Oct 4/)).toBeTruthy();
    fireEvent.click(within(headline()).getByRole("button", { name: "Read the full note" }));
    const drawer = screen.getByRole("dialog", { name: "Latest note from Zavi" });
    expect(within(drawer).getByText("Signups held at 40 a week.")).toBeTruthy();
    expect(within(drawer).queryByRole("button", { name: "Read the full note" })).toBeNull();
  });

  it("has no check-in line and no note link before the first note", async () => {
    await renderPage(full);
    expect(within(headline()).queryByText(/Next check-in/)).toBeNull();
    expect(within(headline()).queryByRole("button", { name: "Read the full note" })).toBeNull();
  });
});

describe("each goal has its own Edit", () => {
  it("every goal row shows an Edit button that opens that goal", async () => {
    const other = { ...goal, id: "g2", objective: "Grow repeat visits", target_metric: "repeat_visits", priority: 0 };
    await renderPage({ ...full, goals: { ...full.goals, items: [goal, other] } }, vi.fn());
    const goals = screen.getByRole("region", { name: "Your goals" });
    expect(within(goals).queryByRole("button", { name: "Change this" })).toBeNull();
    const edits = within(goals).getAllByRole("button", { name: "Edit" });
    expect(edits).toHaveLength(2);
    fireEvent.click(edits[1]);
    expect(screen.getByRole("dialog").textContent).toBe("Grow repeat visits");
  });
});

describe("each goal can be deleted", () => {
  it("asks once inline, then deletes that goal and refreshes", async () => {
    const other = { ...goal, id: "g2", objective: "Grow repeat visits", target_metric: "repeat_visits", priority: 0 };
    const { onChanged } = await renderPage({ ...full, goals: { ...full.goals, items: [goal, other] } }, vi.fn());
    const goals = screen.getByRole("region", { name: "Your goals" });
    fireEvent.click(within(goals).getByRole("button", { name: "Delete Grow repeat visits" }));
    const confirm = within(goals).getByRole("alertdialog", { name: "Delete this goal?" });
    expect(apiFetchMock.mock.calls.some(([, o]) => o?.method === "DELETE")).toBe(false);
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(within(goals).queryByRole("button", { name: "Edit Grow repeat visits" })).toBeNull();
    expect(within(goals).queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/workspace/autopilot/goals/g2", { method: "DELETE" });
  });

  it("puts the goal back with the error when the delete fails", async () => {
    const other = { ...goal, id: "g2", objective: "Grow repeat visits", target_metric: "repeat_visits", priority: 0 };
    routes["/api/workspace/autopilot/goals/g2"] = { __status: 500, body: { error: { message: "Database is not answering." } } };
    await renderPage({ ...full, goals: { ...full.goals, items: [goal, other] } }, vi.fn());
    const goals = screen.getByRole("region", { name: "Your goals" });
    fireEvent.click(within(goals).getByRole("button", { name: "Delete Grow repeat visits" }));
    fireEvent.click(within(within(goals).getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    expect(await within(goals).findByText("Database is not answering.")).toBeTruthy();
    expect(within(goals).getByRole("button", { name: "Edit Grow repeat visits" })).toBeTruthy();
    delete routes["/api/workspace/autopilot/goals/g2"];
  });

  it("the headline stops counting a deleted goal at once, before any refresh", async () => {
    await renderPage(full, vi.fn());
    const before = (await screen.findByTestId("headline-text")).textContent;
    const goals = screen.getByRole("region", { name: "Your goals" });
    fireEvent.click(within(goals).getByRole("button", { name: "Delete Activate more hosts" }));
    fireEvent.click(within(within(goals).getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    expect(within(goals).queryByRole("button", { name: "Edit Activate more hosts" })).toBeNull();
    expect(screen.getByTestId("headline-text").textContent).not.toBe(before);
  });

  it("Cancel closes the question without deleting", async () => {
    apiFetchMock.mockClear();
    await renderPage(full, vi.fn());
    const goals = screen.getByRole("region", { name: "Your goals" });
    fireEvent.click(within(goals).getByRole("button", { name: "Delete Activate more hosts" }));
    fireEvent.click(within(goals).getByRole("button", { name: "Cancel" }));
    expect(within(goals).queryByRole("alertdialog")).toBeNull();
    expect(apiFetchMock.mock.calls.some(([, o]) => o?.method === "DELETE")).toBe(false);
  });
});

describe("each block has one Change this", () => {
  it("block 3 opens the channel menu from Add a channel", async () => {
    await renderPage(full, vi.fn());
    const doing = screen.getByRole("region", { name: "What Zavi is doing" });
    fireEvent.click(within(doing).getByRole("button", { name: "Add a channel" }));
    expect(screen.getByRole("menu", { name: "Channels you can add" })).toBeTruthy();
  });

  it("block 2 opens a conversation about the constraint", async () => {
    const onAsk = vi.fn();
    await renderPage(full, onAsk);
    const block = screen.getByRole("region", { name: "What's in the way" });
    fireEvent.click(within(block).getByRole("button", { name: "Change this" }));
    expect(onAsk).toHaveBeenCalledWith(`I'm not sure "Demand is not reaching hosts" is what's in the way. Let's talk.`);
  });
});

describe("the headline never shows a lower line on its way to the right one", () => {
  function recordHeadlines() {
    const seen: string[] = [];
    const take = () => {
      const text = document.querySelector('[data-testid="headline-text"]')?.textContent;
      const t = text ?? (document.querySelector('[aria-label="Checking what needs you"]') ? "<skeleton>" : "");
      if (t && seen[seen.length - 1] !== t) seen.push(t);
    };
    const obs = new MutationObserver(take);
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
    return { seen, take, stop: () => obs.disconnect() };
  }
  const deferred = () => {
    let release: (body: unknown) => void = () => {};
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };

  it("approvals landing last: skeleton, then the goals line, nothing between", async () => {
    const late = deferred();
    routes["/api/approvals"] = () => late.promise;
    const manual = { ...goal, target_metric: "parent_tours", current_value: null };
    const rec = recordHeadlines();
    await renderPage({ ...full, goals: { ...full.goals, items: [manual] } });
    expect(within(headline()).getByRole("status", { name: "Checking what needs you" })).toBeTruthy();
    late.release({ channel_pending_counts: { seo: 145 }, decisions: [] });
    expect(await within(headline()).findByText("1 goal is not counted yet.")).toBeTruthy();
    expect(within(headline()).getByRole("button", { name: /145\s*need you/ })).toBeTruthy();
    rec.take();
    rec.stop();
    expect(rec.seen).toEqual(["<skeleton>", "1 goal is not counted yet."]);
  });

  it("run state landing last: no 'Add rivals' before 'Start SEO'", async () => {
    const late = deferred();
    routes["/api/channels"] = () => late.promise;
    routes["/api/connectors/company-facts"] = { facts: [{ key: "company_name", value_text: "Upcar" }] };
    const rec = recordHeadlines();
    await renderPage({ ...full, channels: [channel("seo")] });
    await screen.findByText("None yet. I will not guess them.");
    expect(within(headline()).queryByText(/rivals/)).toBeNull();
    late.release({ channels: [{ channel_slug: "seo", work_state: "idle" }] });
    expect(await within(headline()).findByText("Nothing has run yet. Start SEO?")).toBeTruthy();
    rec.take();
    rec.stop();
    expect(rec.seen).toEqual(["<skeleton>", "Nothing has run yet. Start SEO?"]);
  });

  it("a failed read still gives the unknown line", async () => {
    routes["/api/approvals"] = { __status: 500, body: {} };
    await renderPage(full);
    expect(await within(headline()).findByText("I couldn't check everything just now.")).toBeTruthy();
  });

  it("a background refresh keeps the last line until the new one is settled", async () => {
    const { rerender } = await renderPage(full);
    expect(await within(headline()).findByText("Nothing needs you right now.")).toBeTruthy();
    const late = deferred();
    routes["/api/approvals"] = () => late.promise;
    const rec = recordHeadlines();
    rec.take();
    rerender(<GrowthCommandCenter data={{ ...full }} onChanged={vi.fn(async () => {})} />);
    expect(within(headline()).getByText("Nothing needs you right now.")).toBeTruthy();
    expect(within(headline()).queryByRole("status", { name: "Checking what needs you" })).toBeNull();
    late.release({ channel_pending_counts: { seo: 1 }, decisions: [] });
    expect(await within(headline()).findByText("1 action waits for your OK.")).toBeTruthy();
    rec.take();
    rec.stop();
    expect(rec.seen).toEqual(["Nothing needs you right now.", "1 action waits for your OK."]);
  });
});

describe("every section waits for its own reads, then renders once", () => {
  const deferred = () => {
    let release: (body: unknown) => void = () => {};
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };
  function record(region: string, loaderLabel: string, hidden = false) {
    const seen: string[] = [];
    const take = () => {
      const loader = screen.queryByRole("status", { name: loaderLabel, hidden });
      const el = screen.queryByRole("region", { name: region, hidden });
      const t = loader ? "<loader>" : el ? el.textContent ?? "" : "";
      if (t && seen[seen.length - 1] !== t) seen.push(t);
    };
    const obs = new MutationObserver(take);
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
    return { seen, take, stop: () => obs.disconnect() };
  }

  it("block 1 waits for the live goal number: never the stored one first", async () => {
    const late = deferred();
    routes["/api/workspace/autopilot/goals/current-value?metric=host_activation"] = () => late.promise;
    const rec = record("Your goals", "Loading your goals");
    await renderPage(full);
    late.release({ measured: true, value: 35 });
    await screen.findByText(/^Host Activation 35 \/ 40/);
    rec.take();
    rec.stop();
    expect(rec.seen[0]).toBe("<loader>");
    expect(rec.seen.every((t) => !t.includes("30 / 40"))).toBe(true);
    expect(rec.seen[rec.seen.length - 1]).toContain("35 / 40");
  });

  it("block 3 waits for what is waiting and running, then renders once", async () => {
    const late = deferred();
    routes["/api/approvals"] = () => late.promise;
    const rec = record("What Zavi is doing", "Loading your channels");
    await renderPage(full);
    late.release({ channel_pending_counts: { seo: 2 }, decisions: [] });
    await within(await screen.findByRole("region", { name: "What Zavi is doing" })).findByTitle("Win local searches");
    rec.take();
    rec.stop();
    expect(rec.seen[0]).toBe("<loader>");
    expect(rec.seen[rec.seen.length - 1]).toContain("SEO");
  });

  it("step 5 waits for every source, then renders its count once", async () => {
    const late = deferred();
    routes["/api/approvals"] = () => late.promise;
    const rec = record("What needs you", "Loading what needs you");
    await renderPage(full);
    expect(within(needs()).getByRole("status", { name: "Loading what needs you" })).toBeTruthy();
    late.release({ channel_pending_counts: { seo: 2 }, decisions: [] });
    await within(needs()).findByText("2 waiting · 2 for you");
    rec.take();
    rec.stop();
    expect(rec.seen.some((t) => /Nothing needs you/.test(t))).toBe(false);
  });

  it("the data row waits for the connected list: never '0 sources' first", async () => {
    const late = deferred();
    routes["/api/connectors"] = () => late.promise;
    const rec = record("Your data", "Loading your data", true);
    await renderPage(full);
    late.release({ connectors: [{ slug: "google_analytics" }] });
    await within(await screen.findByRole("region", { name: "Your data", hidden: true })).findByText("1 source connected");
    rec.take();
    rec.stop();
    expect(rec.seen[0]).toBe("<loader>");
    expect(rec.seen.some((t) => /0 sources/.test(t))).toBe(false);
  });

  it("the company row waits for the drafted description: no 'Add a line' first", async () => {
    const late = deferred();
    routes["/api/connectors/company-facts"] = { facts: [{ key: "company_name", value_text: "Upcar" }] };
    routes["/api/connectors/company-facts/suggestions"] = { suggestions: {} };
    routes["/api/connectors/company-facts/description-draft"] = () => late.promise;
    const rec = record("Company", "Loading your company", true);
    render(<GrowthCommandCenter data={full} onChanged={vi.fn(async () => {})} />);
    late.release({ draft: { value: "Rent cars from local owners.", from: "your homepage" } });
    await screen.findByText("Rent cars from local owners.");
    rec.take();
    rec.stop();
    expect(rec.seen[0]).toBe("<loader>");
    expect(rec.seen.some((t) => /Add a line|reading your site/.test(t))).toBe(false);
  });

  it("the brand voice row waits for its colours", async () => {
    const late = deferred();
    routes["/api/workspace/brand-kit"] = () => late.promise;
    const rec = record("Brand voice", "Loading brand voice", true);
    await renderPage(full);
    late.release({ brand_kit: { primary: "#1a73ff", accent: null, bg: null, text: null, source: "manual", source_url: null } });
    await within(await screen.findByRole("region", { name: "Brand voice", hidden: true })).findByText("Colours");
    rec.take();
    rec.stop();
    expect(rec.seen[0]).toBe("<loader>");
    expect(rec.seen.slice(1).every((t) => t.includes("Colours"))).toBe(true);
  });

  it("a refresh keeps a settled block on screen, then swaps once", async () => {
    routes["/api/approvals"] = { channel_pending_counts: { seo: 2 }, decisions: [] };
    const { rerender } = await renderPage(full);
    await within(await screen.findByRole("region", { name: "What needs you" })).findByText("2 waiting · 2 for you");
    const late = deferred();
    routes["/api/approvals"] = () => late.promise;
    const rec = record("What needs you", "Loading what needs you");
    rec.take();
    rerender(<GrowthCommandCenter data={{ ...full }} onChanged={vi.fn(async () => {})} />);
    expect(screen.queryByRole("status", { name: "Loading what needs you" })).toBeNull();
    late.release({ channel_pending_counts: { seo: 3 }, decisions: [] });
    await within(screen.getByRole("region", { name: "What needs you" })).findByText("3 waiting · 3 for you");
    rec.take();
    rec.stop();
    expect(rec.seen.some((t) => t === "<loader>")).toBe(false);
    expect(rec.seen.length).toBe(2);
  });
});

describe("the loading state is a quiet skeleton", () => {
  it("shows word-free bars, no spinner and no Loading text, then fades the content in", async () => {
    let release: (b: unknown) => void = () => {};
    routes["/api/approvals"] = () => new Promise((r) => (release = r));
    render(<GrowthCommandCenter data={full} onChanged={vi.fn(async () => {})} />);
    const bars = screen.getByRole("status", { name: "Loading your channels" });
    expect(bars.textContent).toBe("");
    expect(bars.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    expect(bars.querySelector(".motion-reduce\\:animate-none")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Loading/);
    expect(document.querySelector(".animate-spin, .motion-safe\\:animate-spin")).toBeNull();
    release({ channel_pending_counts: {}, decisions: [] });
    const region = await screen.findByRole("region", { name: "What Zavi is doing" });
    await within(region).findByTitle("Win local searches");
    expect(within(region).getByTitle("Win local searches").closest(".transition-opacity")).toBeTruthy();
  });
});

describe("growth work only", () => {
  it("counts growth decisions and channel actions, never PM, QA or chief-of-staff work", async () => {
    routes["/api/approvals"] = {
      channel_pending_counts: { seo: 3 },
      decisions: [
        { decision_class: "pm.needs_action", channel_slug: null },
        { decision_class: "qa.weekly-digest", channel_slug: null },
        { decision_class: "chief-of-staff.dispatch-specialist", channel_slug: null },
        { decision_class: "growth-lead.lifecycle-draft", channel_slug: null },
        { decision_class: "engineer.ship-pr", channel_slug: null },
        { decision_class: "channel.recipe_step", channel_slug: null },
        { decision_class: "social.publish.v2", channel_slug: "seo" },
      ],
    };
    await renderPage(full);
    expect(await within(headline()).findByText("5 actions wait for your OK.")).toBeTruthy();
    expect(within(needs()).getByText("5 waiting · 3 to approve · 2 for you")).toBeTruthy();
  });

  it("counts the true total when other work fills the old 100-row page (no capped floor)", async () => {
    routes["/api/approvals"] = {
      channel_pending_counts: {},
      decisions: [
        ...Array.from({ length: 90 }, () => ({ decision_class: "pm.needs_action", channel_slug: null })),
        ...Array.from({ length: 10 }, () => ({ decision_class: "social.publish.v2", channel_slug: null })),
      ],
    };
    await renderPage(full);
    expect(await within(headline()).findByText("10 actions wait for your OK.")).toBeTruthy();
    expect(within(needs()).getByText("10 waiting · 10 to approve")).toBeTruthy();
  });
});

describe("a growth count that could not be read", () => {
  it("is unknown, never 'Nothing needs you'", async () => {
    routes["/api/approvals"] = { channel_pending_counts: {}, decisions: [] };
    routes["/api/approvals?home=growth&count=1&limit=100"] = { __status: 500, body: {} };
    await renderPage(full);
    expect(await within(headline()).findByText("I couldn't check everything just now.")).toBeTruthy();
    expect(within(headline()).queryByText(/Nothing needs you/)).toBeNull();
  });
});

describe("live values only for goals measured by their source", () => {
  it("a manual MRR goal shows the founder's number and never reads Stripe", async () => {
    const manual = {
      ...goal,
      id: "g-mrr",
      objective: "Grow MRR",
      target_metric: "mrr",
      current_value: 900,
      target_value: 100000,
      measurement_mode: "manual_reported",
    };
    routes["/api/workspace/autopilot/goals/current-value?metric=mrr"] = { measured: true, value: 994 };
    await renderPage({ ...full, goals: { ...full.goals, items: [manual] } });
    expect(await screen.findByText(/^MRR \$900 \/ \$100,000/)).toBeTruthy();
    expect(screen.queryByText(/\$994/)).toBeNull();
    expect(calls.some((c) => c.path.includes("current-value?metric=mrr"))).toBe(false);
  });

  it("the same goal measured by its source shows the live number", async () => {
    const auto = {
      ...goal,
      id: "g-mrr",
      objective: "Grow MRR",
      target_metric: "mrr",
      current_value: 900,
      target_value: 100000,
      measurement_mode: "auto",
    };
    routes["/api/workspace/autopilot/goals/current-value?metric=mrr"] = { measured: true, value: 994 };
    await renderPage({ ...full, goals: { ...full.goals, items: [auto] } });
    expect(await screen.findByText(/^MRR \$994 \/ \$100,000/)).toBeTruthy();
  });
});

describe("B12: one state after Skip setup", () => {
  const noGoal = () => ({ ...full, goals: empty.goals });
  const approvalsWaiting = () => {
    routes["/api/approvals"] = { channel_pending_counts: { seo: 6 }, decisions: [] };
  };

  it("never counts actions waiting for an OK beside 'No goal yet.'", async () => {
    setupFlag.oneState = true;
    approvalsWaiting();
    await renderPage(noGoal());
    expect(screen.getByText("No goal yet.")).toBeTruthy();
    expect(await within(needs()).findByText("Nothing runs until you OK it.")).toBeTruthy();
    expect(within(needs()).queryByText(/actions? waits? for your OK/)).toBeNull();
    expect(within(needs()).queryByRole("button", { name: /Review all/ })).toBeNull();
    fireEvent.click(within(needs()).getByRole("button", { name: "Review" }));
    expect(within(needs()).getByTestId("review-list")).toBeTruthy();
  });

  it("keeps the count once a goal exists", async () => {
    setupFlag.oneState = true;
    approvalsWaiting();
    await renderPage(full);
    expect(await within(needs()).findByText("6 actions wait for your OK.")).toBeTruthy();
    expect(within(needs()).queryByText("Nothing runs until you OK it.")).toBeNull();
  });

  it("with the setting off, the count shows as before even with no goal", async () => {
    approvalsWaiting();
    await renderPage(noGoal());
    expect(await within(needs()).findByText("6 actions wait for your OK.")).toBeTruthy();
    expect(within(needs()).getByRole("button", { name: "Review all 6" })).toBeTruthy();
  });

  it("with no goal, the header has no 'need you' jump and the summary carries no count", async () => {
    setupFlag.oneState = true;
    approvalsWaiting();
    await renderPage(noGoal());
    await within(needs()).findByText("Nothing runs until you OK it.");
    expect(screen.getByText("No goal yet.")).toBeTruthy();
    expect(within(headline()).queryByRole("button", { name: /need you/ })).toBeNull();
    expect(within(needs()).getByText("Waiting for you")).toBeTruthy();
    expect(within(needs()).queryByText(/\d+\+? waiting|to approve|\d+ for you/)).toBeNull();
  });

  it("with a goal, the jump and the counted summary come back", async () => {
    setupFlag.oneState = true;
    approvalsWaiting();
    await renderPage(full);
    await within(needs()).findByText("6 actions wait for your OK.");
    expect(within(headline()).getByRole("button", { name: /\d+\s*need you/ })).toBeTruthy();
    expect(within(needs()).getByText(/^\d+\+? waiting/)).toBeTruthy();
    expect(within(needs()).queryByText("Waiting for you")).toBeNull();
  });

  it("with the setting off and no goal, the jump and the counted summary show as before", async () => {
    approvalsWaiting();
    await renderPage(noGoal());
    await within(needs()).findByText("6 actions wait for your OK.");
    expect(within(headline()).getByRole("button", { name: /6\s*need you/ })).toBeTruthy();
    expect(within(needs()).getByText(/^6 waiting/)).toBeTruthy();
    expect(within(needs()).queryByText("Waiting for you")).toBeNull();
  });

  it("with no goal, the big headline leads with the missing goal, never the waiting count", async () => {
    setupFlag.oneState = true;
    approvalsWaiting();
    await renderPage(noGoal());
    await within(needs()).findByText("Nothing runs until you OK it.");
    const line = await within(headline()).findByTestId("headline-text");
    expect(line.textContent).toBe("I have no goal to work toward yet.");
    expect(within(headline()).queryByText(/actions? waits? for your OK/)).toBeNull();
    expect(within(headline()).getByRole("button", { name: "Add a goal" })).toBeTruthy();
    expect(screen.getByText("No goal yet.")).toBeTruthy();
  });

  it("with the setting off and no goal, the big headline keeps the waiting count", async () => {
    approvalsWaiting();
    await renderPage(noGoal());
    await within(needs()).findByText("6 actions wait for your OK.");
    expect((await within(headline()).findByTestId("headline-text")).textContent).toBe("6 actions wait for your OK.");
  });
});

describe("what needs you, from a note built from items", () => {
  it("lists the Needs you card rows with their card link and the N more row, never the question rows", async () => {
    const hog = {
      autopilot: true,
      note: {
        saw: [],
        changed: [],
        would_change: [],
        need: ["Left for you: legacy line, because never drawn."],
        questions: [],
        created_at: "2026-09-28T00:00:00Z",
        next_review_at: "2026-10-04T12:00:00Z",
        headline: "Google spent $468 and counted 0 sign-ups.",
        sections: [
          {
            key: "needs_you" as const,
            title: "Needs you",
            rows: [
              { line: "Keep Reddit? Reply by Oct 3.", url: null, question_ordinal: 1 },
              { line: "Count sign-ups. $468 spent with 0 counted sign-ups.", url: "/workspace?tab=channels&channel=google_ads&action=a1" },
            ],
            more: { count: 2, url: "/workspace?tab=growth-strategy", line: "2 more on your Growth page." },
          },
        ],
      },
      undoable: [],
    };
    await renderPage({ ...full, head_of_growth: hog });
    const region = needs();
    expect(await within(region).findByText(/Count sign-ups\. \$468 spent/)).toBeTruthy();
    expect(within(region).getByText("Needs you")).toBeTruthy();
    expect(within(region).queryByText("Left for you")).toBeNull();
    expect(within(region).queryByText(/legacy line/)).toBeNull();
    expect(within(region).queryByText(/Keep Reddit/)).toBeNull();
    const links = within(region).getAllByRole("link", { name: "Open" }).map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/workspace?tab=channels&channel=google_ads&action=a1", "/workspace?tab=growth-strategy"]);
    expect(within(region).getByText(/2 more on your Growth page\./)).toBeTruthy();
    expect(await within(headline()).findByRole("button", { name: /3\s*need you/ })).toBeTruthy();
  });
});

describe("home's question line lands on the questions", () => {
  const ask = (id: string, ordinal: number) => ({ id, ordinal, ask: `Question ${ordinal}?`, recommended: null, why: null, yes_no: true });
  let scrolled: string[] = [];
  const realScroll = Element.prototype.scrollIntoView;
  beforeEach(() => {
    scrolled = [];
    takeQuestionsJump();
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    } as typeof Element.prototype.scrollIntoView;
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = realScroll;
  });

  it("scrolls to the first question when the page opens from the line", async () => {
    routes["/api/workspace/growth/questions"] = { can_answer: true, questions: [ask("q1", 1), ask("q2", 2), ask("q3", 3)] };
    requestQuestionsJump();
    await renderPage(full);
    await waitFor(() => expect(scrolled).toContain("growth-questions"));
    expect(document.getElementById("growth-questions")?.textContent).toContain("Question 1?");
  });

  it("scrolls an already-open page when the line is clicked again", async () => {
    routes["/api/workspace/growth/questions"] = { can_answer: true, questions: [ask("q1", 1)] };
    await renderPage(full);
    await within(needs()).findByText(/Question 1\?/);
    await new Promise((r) => setTimeout(r, 1300));
    expect(scrolled).not.toContain("growth-questions");
    requestQuestionsJump();
    await waitFor(() => expect(scrolled).toContain("growth-questions"));
  });

  it("does not scroll on a plain open", async () => {
    routes["/api/workspace/growth/questions"] = { can_answer: true, questions: [ask("q1", 1)] };
    await renderPage(full);
    await within(needs()).findByText(/Question 1\?/);
    await new Promise((r) => setTimeout(r, 1300));
    expect(scrolled).toEqual([]);
  });
});

describe("the headline Run quotes no credits on a channel whose spec hides the run cost", () => {
  it("email_marketing: Start Email campaigns with the server answering 120 prints no credit text", async () => {
    routes["/api/channels"] = { channels: [{ channel_slug: "email_marketing", work_state: "idle", run_reserve_credits: 120 }] };
    await renderPage({ ...full, channels: [channel("email_marketing")] });
    const start = await within(headline()).findByRole("button", { name: "Start Email campaigns" });
    expect(start).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/channels")).toBe(true);
    expect(headline().textContent).not.toMatch(/credit|120/i);
  });

  it("google_ads, same 120 answer: the headline still says About 120 credits", async () => {
    routes["/api/channels"] = { channels: [{ channel_slug: "google_ads", work_state: "idle", run_reserve_credits: 120 }] };
    await renderPage({ ...full, channels: [channel("google_ads")] });
    expect(await within(headline()).findByRole("button", { name: "Start Google Ads" })).toBeTruthy();
    expect(within(headline()).getByText("About 120 credits")).toBeTruthy();
  });
});
