// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GrowthChannel, GrowthGoal, GrowthPlanPayload } from "@/lib/workspace/useGrowthPlan";

const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
let routes: Record<string, unknown> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, opts?: { method?: string; body?: string }) => {
    calls.push({ path, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : undefined });
    if (!(path in routes) && path.startsWith("/api/approvals?home=")) {
      const { homeResponseFor } = await import("./testHomeFixture");
      const base = routes["/api/approvals"] as { __status?: number; body?: unknown } | undefined;
      if (base?.__status) return { ok: false, status: base.__status, json: async () => base.body, clone() { return this; } } as unknown as Response;
      const body = homeResponseFor(path, (base ?? { decisions: [] }) as never);
      return { ok: true, status: 200, json: async () => body, clone() { return this; } } as unknown as Response;
    }
    const hit = routes[path] as { __status?: number; body?: unknown } | undefined;
    const status = hit?.__status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => (hit?.__status ? hit.body : hit) ?? { ok: true },
      clone() {
        return this;
      },
    } as unknown as Response;
  },
}));
vi.mock("../AutopilotGoalsPanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../AutopilotGoalsPanel")>()),
  GoalEditor: ({ goal, history }: { goal: { objective: string } | null; history?: unknown }) => (
    <div role="dialog">
      {goal?.objective ?? "New goal"}
      {history ? <span data-testid="editor-history" /> : null}
    </div>
  ),
}));

import { GrowthCommandCenter } from "./GrowthCommandCenter";
import { goalPill, goalStatusLine } from "./StoryGoals";
import { keepConstraintKey, replacementGuess, updatePlanMessage } from "./StoryWay";
import { LOADING } from "./growthHeadline";
import { AdBudgetSection } from "./AdBudgetSection";
import { CHANNELS } from "@zavi/shared";
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
};

const channel = (slug: string, over: Partial<GrowthChannel> = {}): GrowthChannel => ({
  slug,
  last_run_at: "2026-09-20T00:00:00Z",
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
  constraint_statement: "renter demand is binding",
  constraint_confidence: "medium" as const,
  basis_evidence: [],
  version: 3,
  updated_at: "2026-09-07",
};

const hyps = [
  { id: "h1", claim: "Most booking attempts die before payment", status: "testing" as const, evidence: [] },
  { id: "h2", claim: "Not enough renter demand is arriving", status: "ruled_out" as const, restates_plan_constraint: true, evidence: [] },
];

const data: GrowthPlanPayload = {
  plan,
  goals: { active_count: 1, max_active: 20, over_cap: false, items: [goal] },
  channels: [channel("seo")],
  metrics: [],
  bets: [],
  changes: [],
  unreadable: [],
  goal_work: { "goal-1": { status_line: null, status_at: null, moves: [], hypotheses: hyps } },
  constraint_conflicts: [{ goal_id: "goal-1", hypothesis_id: "h2", claim: "Not enough renter demand is arriving" }],
};

beforeEach(() => {
  resetChannelLocksCache();
  calls.length = 0;
  try {
    window.localStorage.clear();
  } catch {
  }
  routes = {
    "/api/connectors/company-facts": {
      facts: [
        { key: "company_name", value_text: "Upcar" },
        { key: "competitors", value_text: "Turo" },
      ],
    },
    "/api/connectors": { connectors: [] },
    "/api/connectors/recommendations": { recommendations: [] },
    "/api/approvals": { channel_pending_counts: {}, decisions: [] },
    "/api/channels": { channels: [], channel_locks: Object.fromEntries(CHANNELS.map((c) => [c.slug, null])) },
    "/api/personalization": { personalization: { brand_voice: "Plain.", base_tone: "default", warm: false, enthusiastic: false, response_rules: "", updated_by: "u", updated_at: "" } },
    "/api/workspace/growth/questions": { can_answer: true, questions: [] },
    "/api/workspace/growth/you-asked": { asked: null },
  };
});
afterEach(cleanup);

async function renderPage(d: GrowthPlanPayload = data, onAsk?: (t: string) => void) {
  const onChanged = vi.fn(async () => {});
  render(<GrowthCommandCenter data={d} onChanged={onChanged} onAsk={onAsk} />);
  await screen.findByText("Growth brief for Upcar · from Zavi");
  return { onChanged };
}
const step = (name: string) => screen.getByRole("region", { name });

describe("goal pills and the header line", () => {
  const NOW = Date.parse("2026-10-01T00:00:00Z");
  const measured = { kind: "none" } as const;

  it("waits for the number, then says Not counted yet, in neutral grey, for a goal without one", () => {
    expect(goalPill(goal, LOADING, undefined, NOW)).toBe(LOADING);
    expect(goalPill({ ...goal, current_value: null }, { kind: "manual", goalId: "goal-1" }, undefined, NOW)).toEqual({ label: "Not counted yet", tone: "quiet" });
    expect(goalPill({ ...goal, current_value: 4 }, { kind: "manual", goalId: "goal-1" }, undefined, NOW)).not.toEqual({ label: "Not counted yet", tone: "quiet" });
  });

  it("says Met from the baseline, in either direction", () => {
    expect(goalPill({ ...goal, current_value: 40 }, measured, [], NOW)).toEqual({ label: "Met", tone: "good" });
    const down = { ...goal, baseline_value: 50, target_value: 20, current_value: 18 };
    expect(goalPill(down, measured, [], NOW)).toEqual({ label: "Met", tone: "good" });
  });

  it("paces from the goal's own history, and says nothing without one", () => {
    const points = [{ at: "2026-07-01T00:00:00Z", value: 20 }];
    expect(goalPill({ ...goal, current_value: 35 }, measured, points, NOW)).toEqual({ label: "On pace", tone: "good" });
    expect(goalPill({ ...goal, current_value: 21 }, measured, points, NOW)).toEqual({ label: "Behind", tone: "bad" });
    expect(goalPill(goal, measured, "loading", NOW)).toBe(LOADING);
    expect(goalPill(goal, measured, "failed", NOW)).toBeNull();
    expect(goalPill(goal, measured, [], NOW)).toBeNull();
    expect(goalPill({ ...goal, due_date: null }, measured, points, NOW)).toBeNull();
    expect(goalPill(goal, null, points, NOW)).toBeNull();
  });

  it("says Past due once the date has gone", () => {
    expect(goalPill({ ...goal, due_date: "2026-09-01" }, measured, [], NOW)).toEqual({ label: "Past due", tone: "quiet" });
  });

  it("builds the header line only from the pills", () => {
    const onPace = { label: "On pace", tone: "good" } as const;
    const none = { label: "Not counted yet", tone: "quiet" } as const;
    expect(goalStatusLine([onPace, none, none])).toBe("1 goal on pace. 2 are not counted yet.");
    expect(goalStatusLine([none])).toBe("1 goal is not counted yet.");
    expect(goalStatusLine([onPace, onPace])).toBe("2 goals on pace.");
    expect(goalStatusLine([null])).toBeNull();
    expect(goalStatusLine([])).toBeNull();
  });

  it("shows On pace on the row and in the header when the history says so", async () => {
    routes["/api/workspace/autopilot/goals/current-value?metric=host_activation"] = { measured: true, value: 39 };
    routes["/api/workspace/autopilot/goals/goal-1/history"] = { goal_id: "goal-1", metric_key: null, points: [{ at: "2026-07-01T00:00:00Z", value: 20 }], last_measured_at: null };
    await renderPage({ ...data, goals: { ...data.goals, items: [{ ...goal, measurement_mode: "auto" }] } });
    expect(await within(step("Your goals")).findByText("On pace")).toBeTruthy();
    expect(await within(step("Growth brief")).findByText("1 goal on pace.")).toBeTruthy();
  });

  it("review F1: shows the founder's signup estimate on an uncounted goal's row", async () => {
    const est = { ...goal, current_value: null, founder_estimate: "You told me 6-20 new customers last month" };
    await renderPage({ ...data, goals: { ...data.goals, items: [est] } });
    expect(await within(step("Your goals")).findByText("You told me 6-20 new customers last month.")).toBeTruthy();
  });
});

describe("the plan's blocker, ruled out", () => {
  it("shows the contradiction on the goal's row, and Update the plan prefills the chat from the conflict", async () => {
    const onAsk = vi.fn();
    await renderPage(data, onAsk);
    const way = step("What's in the way");
    expect(within(way).getByText(/no longer backs your plan/)).toBeTruthy();
    expect(within(way).getByText("Your plan says:")).toBeTruthy();
    expect(within(way).getByText("Ruled out for this goal:")).toBeTruthy();
    expect(within(way).getByText("Not enough renter demand is arriving")).toBeTruthy();
    expect(within(way).getByText("Best guess now:")).toBeTruthy();
    expect(within(way).getAllByText(/Most booking attempts die before payment/).length).toBe(2);
    expect(within(way).queryByText("Plan says:")).toBeNull();
    fireEvent.click(within(way).getByRole("button", { name: "Update the plan" }));
    expect(onAsk.mock.calls[0][0]).toBe(
      `Your plan's blocker is "renter demand is binding", but you ruled out "Not enough renter demand is arriving" for Activate more hosts. Your best guess now is "Most booking attempts die before payment". Update the plan's blocker to what the evidence shows.`,
    );
  });

  it("says when there is no best guess yet, and the prefill does not invent one", async () => {
    const onAsk = vi.fn();
    const allOut = { "goal-1": { status_line: null, status_at: null, moves: [], hypotheses: hyps.map((h) => ({ ...h, status: "ruled_out" as const })) } };
    await renderPage({ ...data, goal_work: allOut }, onAsk);
    const way = step("What's in the way");
    expect(within(way).getByText(/not found yet/)).toBeTruthy();
    fireEvent.click(within(way).getByRole("button", { name: "Update the plan" }));
    expect(onAsk.mock.calls[0][0]).not.toMatch(/best guess/);
  });

  it("drops a quoted sentence's own full stop and skips a best guess that is the ruled-out idea", () => {
    const c = { goal_id: "g", hypothesis_id: "x", claim: "Too few visitors." };
    expect(updatePlanMessage("Demand is binding.", c, { objective: "Grow" })).toBe(
      `Your plan's blocker is "Demand is binding", but you ruled out "Too few visitors" for Grow. Update the plan's blocker to what the evidence shows.`,
    );
    expect(updatePlanMessage("Is demand binding?", c, { objective: "Grow" })).toMatch(/"Is demand binding\?"/);
    expect(replacementGuess([{ id: "x", status: "testing", claim: "Other" }], c)).toBeNull();
    expect(replacementGuess([{ id: "z", status: "testing", claim: "too few visitors" }], c)).toBeNull();
    expect(replacementGuess([{ id: "y", status: "listed", claim: "Hosts cancel" }], c)?.id).toBe("y");
  });

  const KEEP = "/api/workspace/growth/conflicts/h2/keep";

  it("Keep saves on the server, then shows the quiet kept line with Undo", async () => {
    routes[KEEP] = { ok: true, kept_at: "2026-10-14T17:00:00Z" };
    const { onChanged } = await renderPage();
    const way = step("What's in the way");
    fireEvent.click(within(way).getByRole("button", { name: "Keep my plan" }));
    await waitFor(() => expect(within(way).queryByText(/no longer backs your plan/)).toBeNull());
    expect(calls.find((c) => c.path === KEEP)).toMatchObject({ method: "POST", body: { kept: true } });
    expect(within(way).getByText(/You kept your plan on Oct 14\. Zavi ruled out: Not enough renter demand is arriving\./)).toBeTruthy();
    expect(within(way).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(way).getByText("renter demand is binding")).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it("another device (no browser storage) reads the keep from the server: kept line, no box", async () => {
    window.localStorage.clear();
    await renderPage({ ...data, constraint_conflicts: [{ goal_id: "goal-1", hypothesis_id: "h2", claim: "Not enough renter demand is arriving", kept_at: "2026-10-14T17:00:00Z" }] });
    const way = step("What's in the way");
    expect(within(way).queryByText(/no longer backs your plan/)).toBeNull();
    expect(within(way).getByText(/You kept your plan on Oct 14/)).toBeTruthy();
  });

  it("Undo clears it on the server and brings the box back", async () => {
    routes[KEEP] = { ok: true, kept_at: null };
    await renderPage({ ...data, constraint_conflicts: [{ goal_id: "goal-1", hypothesis_id: "h2", claim: "Not enough renter demand is arriving", kept_at: "2026-10-14T17:00:00Z" }] });
    const way = step("What's in the way");
    fireEvent.click(within(way).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(within(way).getByText(/no longer backs your plan/)).toBeTruthy());
    expect(calls.find((c) => c.path === KEEP)).toMatchObject({ body: { kept: false } });
    expect(within(way).getByRole("button", { name: "Keep my plan" })).toBeTruthy();
  });

  it("after the read shows the save, the server wins again (Undo on another device shows the box here)", async () => {
    routes[KEEP] = { ok: true, kept_at: "2026-10-14T17:00:00Z" };
    const kept = { goal_id: "goal-1", hypothesis_id: "h2", claim: "Not enough renter demand is arriving", kept_at: "2026-10-14T17:00:00Z" };
    const view = render(<GrowthCommandCenter data={data} onChanged={async () => {}} />);
    await screen.findByText("Growth brief for Upcar · from Zavi");
    fireEvent.click(within(step("What's in the way")).getByRole("button", { name: "Keep my plan" }));
    await waitFor(() => expect(within(step("What's in the way")).getByText(/You kept your plan/)).toBeTruthy());
    view.rerender(<GrowthCommandCenter data={{ ...data, constraint_conflicts: [kept] }} onChanged={async () => {}} />);
    view.rerender(<GrowthCommandCenter data={{ ...data, constraint_conflicts: [{ ...kept, kept_at: null }] }} onChanged={async () => {}} />);
    await waitFor(() => expect(within(step("What's in the way")).getByText(/no longer backs your plan/)).toBeTruthy());
  });

  it("a failed save leaves the box and says so", async () => {
    routes[KEEP] = { __status: 500, body: { error: { code: "keep_failed" } } };
    await renderPage();
    const way = step("What's in the way");
    fireEvent.click(within(way).getByRole("button", { name: "Keep my plan" }));
    expect(await within(way).findByText("Couldn't save. Try again.")).toBeTruthy();
    expect(within(way).getByText(/no longer backs your plan/)).toBeTruthy();
  });

  it("carries an old browser-only keep to the server once, and drops the local mark only after it saved", async () => {
    window.localStorage.setItem(keepConstraintKey(plan, "h2"), "1");
    routes[KEEP] = { __status: 503, body: {} };
    await renderPage();
    await waitFor(() => expect(calls.filter((c) => c.path === KEEP).length).toBe(1));
    expect(window.localStorage.getItem(keepConstraintKey(plan, "h2"))).toBe("1");
    cleanup();
    calls.length = 0;
    routes[KEEP] = { ok: true, kept_at: "2026-10-14T17:00:00Z" };
    await renderPage();
    await waitFor(() => expect(window.localStorage.getItem(keepConstraintKey(plan, "h2"))).toBeNull());
    expect(calls.filter((c) => c.path === KEEP)).toHaveLength(1);
    expect(within(step("What's in the way")).getByText(/You kept your plan on Oct 14/)).toBeTruthy();
  });

  it("shows no contradiction without the server's link, whatever the text says", async () => {
    await renderPage({ ...data, constraint_conflicts: [] });
    const way = step("What's in the way");
    expect(within(way).queryByText(/no longer backs your plan/)).toBeNull();
    expect(within(way).getByText("renter demand is binding")).toBeTruthy();
    expect(within(way).getByText(/1 idea, 0 with a check open · ruled out 1/)).toBeTruthy();
  });

  it("keeps working when storage is blocked", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    routes[KEEP] = { ok: true, kept_at: "2026-10-14T17:00:00Z" };
    await renderPage();
    const way = step("What's in the way");
    fireEvent.click(within(way).getByRole("button", { name: "Keep my plan" }));
    await waitFor(() => expect(within(way).queryByText(/no longer backs your plan/)).toBeNull());
    spy.mockRestore();
  });
});

describe("You asked", () => {
  it("shows the founder's emailed question and the first line of Zavi's reply, the rest behind Breakdown", async () => {
    routes["/api/workspace/growth/you-asked"] = {
      asked: { question: "what's our CPA this week?", at: "2026-09-28T00:00:00Z", answer: "$52.52 per booking, Sep 21 to 28.\nMeta $1,572.92 for 35 purchases." },
    };
    await renderPage();
    const happened = step("What happened");
    const asked = await within(happened).findByRole("group", { name: "You asked" });
    expect(within(asked).getByText(`You asked by email: "what's our CPA this week?"`)).toBeTruthy();
    expect(within(asked).getByText("$52.52 per booking, Sep 21 to 28.")).toBeTruthy();
    expect(within(asked).queryByText(/Meta \$1,572.92/)).toBeNull();
    fireEvent.click(within(asked).getByRole("button", { name: "Breakdown" }));
    expect(within(asked).getByText(/Meta \$1,572.92/)).toBeTruthy();
  });

  it("is hidden when there is nothing asked, and when the read fails", async () => {
    await renderPage();
    await waitFor(() => expect(calls.some((c) => c.path === "/api/workspace/growth/you-asked")).toBe(true));
    expect(within(step("What happened")).queryByRole("group", { name: "You asked" })).toBeNull();
    cleanup();
    routes["/api/workspace/growth/you-asked"] = { __status: 404, body: {} };
    await renderPage();
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/workspace/growth/you-asked").length).toBeGreaterThan(1));
    expect(within(step("What happened")).queryByRole("group", { name: "You asked" })).toBeNull();
  });

  it("lists Zavi's moves across goals once each, newest first, without the ones waiting for you", async () => {
    const move = (id: string, state: "done" | "failed" | "waiting", at: string, agent = "meta_ads") => ({
      decision_id: id,
      agent,
      intent: `Move ${id}`,
      why: null,
      aims_to_move: null,
      state,
      run_id: null,
      emitted_at: at,
      hypothesis_id: null,
    });
    const work = {
      "goal-1": { status_line: null, status_at: null, moves: [move("d1", "done", "2026-09-27T00:00:00Z"), move("d2", "waiting", "2026-09-28T00:00:00Z")] },
      g2: { status_line: null, status_at: null, moves: [move("d1", "done", "2026-09-27T00:00:00Z"), move("d3", "failed", "2026-09-28T00:00:00Z", "research")] },
    };
    await renderPage({ ...data, goal_work: work, constraint_conflicts: [] });
    const list = within(step("What happened")).getAllByRole("listitem");
    expect(list.map((li) => li.textContent)).toEqual(["ResearchMove d3Didn't finish", "Meta AdsMove d1Done"]);
  });
});

describe("What needs you", () => {
  const q = { id: "q1", ordinal: null, ask: "Keep only the Dec 23 goal?", recommended: null, why: "Three goals track the same rate.", yes_no: true };

  it("lists the questions, the note's Left for you lines and moves to approve, and counts them once", async () => {
    routes["/api/workspace/growth/questions"] = { can_answer: true, questions: [q] };
    const waitingMove = {
      decision_id: "d9",
      agent: "meta_ads",
      intent: "Rebuild the Turo campaign",
      why: null,
      aims_to_move: null,
      state: "waiting" as const,
      run_id: null,
      emitted_at: "2026-09-28T00:00:00Z",
      hypothesis_id: "h1",
    };
    await renderPage({
      ...data,
      goal_work: { "goal-1": { status_line: null, status_at: null, moves: [waitingMove], hypotheses: hyps } },
      head_of_growth: {
        autopilot: false,
        note: { saw: [], changed: [], would_change: [], need: ["Add hashed email to CAPI events."], questions: ["Keep only the Dec 23 goal?"], created_at: "", next_review_at: "" },
        undoable: [],
      },
    });
    const needs = step("What needs you");
    expect(await within(needs).findByText("Keep only the Dec 23 goal?")).toBeTruthy();
    expect(within(needs).getByText("Add hashed email to CAPI events.")).toBeTruthy();
    expect(within(needs).getByText("Rebuild the Turo campaign")).toBeTruthy();
    expect(within(needs).getByText("Acts on: Most booking attempts die before payment")).toBeTruthy();
    expect(within(step("Growth brief")).getByRole("button", { name: /3\s*need you/ })).toBeTruthy();
    expect(within(needs).getByText("Three goals track the same rate.")).toBeTruthy();
  });

  it("shows no Left for you lines from an older note (no questions stored apart)", async () => {
    await renderPage({
      ...data,
      head_of_growth: {
        autopilot: false,
        note: { saw: [], changed: [], would_change: [], need: ["Keep only the Dec 23 goal?"], created_at: "", next_review_at: "" },
        undoable: [],
      },
    });
    const needs = step("What needs you");
    expect(await within(needs).findByText("Nothing needs you right now.")).toBeTruthy();
    expect(within(needs).queryByText("Left for you")).toBeNull();
  });

  it("answers in the founder's own words, posting { text }, and drops the count", async () => {
    routes["/api/workspace/growth/questions"] = { can_answer: true, questions: [q] };
    routes["/api/workspace/growth/questions/q1/answer"] = { outcome: "answered", answer: "text", applied: null };
    await renderPage();
    const needs = step("What needs you");
    await within(needs).findByText("Keep only the Dec 23 goal?");
    expect(within(step("Growth brief")).getByRole("button", { name: /1\s*need you/ })).toBeTruthy();
    fireEvent.click(within(needs).getByRole("button", { name: "Type an answer" }));
    fireEvent.change(within(needs).getByLabelText("Your answer"), { target: { value: "Keep Dec 23, retire the rest" } });
    fireEvent.click(within(needs).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/workspace/growth/questions/q1/answer")).toBe(true));
    expect(calls.find((c) => c.path === "/api/workspace/growth/questions/q1/answer")!.body).toEqual({
      answer: { text: "Keep Dec 23, retire the rest" },
    });
    expect(await within(needs).findByText(/^Answered/)).toBeTruthy();
    expect(within(step("Growth brief")).queryByRole("button", { name: /need you/ })).toBeNull();
  });

  it("offers Ask Zavi from the typed box: fills the chat, never answers", async () => {
    routes["/api/workspace/growth/questions"] = { can_answer: true, questions: [q] };
    const onAsk = vi.fn();
    await renderPage(data, onAsk);
    const needs = step("What needs you");
    await within(needs).findByText("Keep only the Dec 23 goal?");
    expect(within(needs).queryByRole("button", { name: "Ask Zavi" })).toBeNull();
    fireEvent.click(within(needs).getByRole("button", { name: "Type an answer" }));
    fireEvent.click(within(needs).getByRole("button", { name: "Ask Zavi" }));
    expect(onAsk).toHaveBeenCalledWith(`About your question "Keep only the Dec 23 goal?": `);
    expect(calls.some((c) => c.path === "/api/workspace/growth/questions/q1/answer")).toBe(false);
  });

  it("keeps the typed box open on a question that is not a yes/no", async () => {
    routes["/api/workspace/growth/questions"] = { can_answer: true, questions: [{ ...q, yes_no: false }] };
    await renderPage();
    const needs = step("What needs you");
    await within(needs).findByText("Keep only the Dec 23 goal?");
    expect(within(needs).queryByRole("button", { name: /^(Yes|No|Type an answer)$/ })).toBeNull();
    expect(within(needs).getByLabelText("Your answer")).toBeTruthy();
  });

  it("shows a member the questions without controls", async () => {
    routes["/api/workspace/growth/questions"] = { can_answer: false, questions: [q] };
    await renderPage();
    const needs = step("What needs you");
    await within(needs).findByText("Keep only the Dec 23 goal?");
    expect(within(needs).queryByRole("button", { name: /^(Yes|No|Type an answer)$/ })).toBeNull();
  });

  it("says it could not check, never nothing, when the questions read fails, and retries", async () => {
    routes["/api/workspace/growth/questions"] = { __status: 500, body: {} };
    await renderPage();
    const needs = step("What needs you");
    expect(await within(needs).findByText(/Couldn.t check what needs you/)).toBeTruthy();
    expect(within(needs).queryByText(/Nothing needs you/)).toBeNull();
    expect(within(step("Growth brief")).queryByRole("button", { name: /need you/ })).toBeNull();
    routes["/api/workspace/growth/questions"] = { can_answer: true, questions: [] };
    fireEvent.click(within(needs).getByRole("button", { name: "Try again" }));
    expect(await within(needs).findByText("Nothing needs you right now.")).toBeTruthy();
  });
});

describe("a new founder's first run", () => {
  it("leads with Add a goal and keeps every step on the page", async () => {
    await renderPage({ ...data, plan: null, goals: { ...data.goals, active_count: 0, items: [] }, channels: [], goal_work: {}, constraint_conflicts: [] });
    const header = step("Growth brief");
    expect(await within(header).findByText("I have no goal to work toward yet.")).toBeTruthy();
    fireEvent.click(within(header).getByRole("button", { name: "Add a goal" }));
    expect(screen.getByRole("dialog").textContent).toBe("New goal");
    for (const name of ["Your goals", "What's in the way", "What Zavi is doing", "What happened", "What needs you"]) {
      expect(step(name)).toBeTruthy();
    }
  });
});

describe("the goal editor", () => {
  it("gets the goal's history in its slot when editing a goal", async () => {
    await renderPage({ ...data, constraint_conflicts: [] });
    fireEvent.click(within(step("Your goals")).getByRole("button", { name: "Edit Activate more hosts" }));
    expect(within(screen.getByRole("dialog")).getByTestId("editor-history")).toBeTruthy();
  });
});

describe("goal order", () => {
  const second: GrowthGoal = { ...goal, id: "goal-2", objective: "Grow weekly bookings", priority: 50 };
  const third: GrowthGoal = { ...goal, id: "goal-3", objective: "Lift renter repeat rate", priority: 50 };
  const three = {
    ...data,
    constraint_conflicts: [],
    goals: { active_count: 3, max_active: 20, over_cap: false, items: [second, third, goal] },
  };
  const titles = () =>
    within(step("Your goals"))
      .getAllByRole("button", { name: /^Edit / })
      .map((b) => b.getAttribute("title"));

  it("moves a goal to the top, renumbering only the goals whose priority changed", async () => {
    const { onChanged } = await renderPage(three);
    expect(titles()).toEqual(["Grow weekly bookings", "Lift renter repeat rate", "Activate more hosts"]);
    const box = within(step("Your goals"));
    expect((box.getByRole("button", { name: "Move Grow weekly bookings up" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box.getByRole("button", { name: "Move Lift renter repeat rate up" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toEqual([
      { path: "/api/workspace/autopilot/goals/goal-3", method: "PATCH", body: { priority: 100 } },
      { path: "/api/workspace/autopilot/goals/goal-2", method: "PATCH", body: { priority: 99 } },
      { path: "/api/workspace/autopilot/goals/goal-1", method: "PATCH", body: { priority: 98 } },
    ]);
  });

  it("says so in red when the new order could not be saved", async () => {
    routes["/api/workspace/autopilot/goals/goal-3"] = { __status: 500, body: { error: { message: "nope" } } };
    await renderPage(three);
    fireEvent.click(within(step("Your goals")).getByRole("button", { name: "Move Lift renter repeat rate up" }));
    const alert = await screen.findByText("Could not save the new goal order. Try again.");
    expect(alert.className).toContain("text-danger");
  });

  it("shows no arrows with a single goal", async () => {
    await renderPage({ ...data, constraint_conflicts: [] });
    expect(within(step("Your goals")).queryByRole("button", { name: /^Move / })).toBeNull();
  });
});

describe("the ad budget, as one line", () => {
  it("says the monthly amount and state, with the spend bar and Edit, Stop, Ledger", () => {
    const budget = {
      id: "b1",
      status: "active" as const,
      monthly_usd: 9500,
      daily_limit_usd: null,
      started_on: "2026-09-01",
      month_cap_usd: 950,
      spent_usd: 519.77,
      held_usd: 0,
      left_usd: 430.23,
      month_start: "2026-09-01",
      next_month_start: "2026-10-01",
      days_left: 1,
      days_in_month: 30,
      stopped_at: null,
      still_running: [],
    };
    render(<AdBudgetSection variant="story" initial={{ budget, can_manage: true, pro: true }} />);
    expect(screen.getByText(/Ads: \$9,500 a month/)).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Spent this month" }).getAttribute("aria-valuenow")).toBe("55");
    for (const name of ["Edit", "Stop", "Ledger"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  });
});
