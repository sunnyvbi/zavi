import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => ({ result: { data: [] as unknown, error: null as unknown } as { data: unknown; error: unknown }, throws: false, calls: [] as unknown[][] }));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantClient: () => ({
    from: (table: string) => {
      read.calls.push(["from", table]);
      const chain: Record<string, (...a: unknown[]) => unknown> = {};
      for (const m of ["select", "eq", "not", "order"]) chain[m] = (...a: unknown[]) => { read.calls.push([m, ...a]); return chain; };
      chain.limit = async () => {
        if (read.throws) throw new Error("boom");
        return read.result;
      };
      return chain;
    },
  }),
}));

import { noteGoalViews, planModelQuestions, statusLineFor, type GoalRow } from "../goal-owner";
import { asksFounderForNumber } from "../cgo-questions";
import { founderEstimateFor, founderEstimateLine, isNewCustomersGoal, readFounderCustomersAnswer } from "../founder-estimate";

const TODAY = "2026-10-29";
const goal = (over: Partial<GoalRow> = {}) =>
  ({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    objective: "Reach 10 new paying customers a month by Jan 27, 2027",
    target_metric: "new_customers",
    target_value: 10,
    baseline_value: null,
    current_value: null,
    current_value_at: null,
    due_date: "2027-01-27",
    status: "active",
    priority: 50,
    measurement_mode: "unmapped",
    created_at: "2026-10-28T00:00:00Z",
    ...over,
  }) as GoalRow;

beforeEach(() => {
  read.result = { data: [], error: null };
  read.throws = false;
  read.calls = [];
});

describe("a goal with no number reads 'Not counted yet', never an alarm", () => {
  it("noteGoalViews: neutral wording, and the founder's range on a customers goal", () => {
    const [v] = noteGoalViews([goal()], TODAY, "6-20");
    expect(v.current).toBeNull();
    expect(v.not_counted).toBe("Not counted yet");
    expect(v.founder_estimate).toBe("You told me 6-20 new customers last month");
    expect(v.progress).toBeNull();
    expect(v.pace).toBeNull();
  });
  it("noteGoalViews: a goal with a real number shows it as before, with no estimate", () => {
    const [v] = noteGoalViews([goal({ current_value: 4, current_value_at: "2026-10-28T00:00:00Z", measurement_mode: "manual_reported" })], TODAY, "6-20");
    expect(v.current).toBe("4 of 10 new customers");
    expect(v.not_counted).toBeNull();
    expect(v.founder_estimate).toBeNull();
  });
  it("noteGoalViews: no estimate for a signups goal, nor for 'Not sure'", () => {
    expect(noteGoalViews([goal({ target_metric: "signups", objective: "Reach 60 signups a month" })], TODAY, "6-20")[0].founder_estimate).toBeNull();
    expect(noteGoalViews([goal()], TODAY, "Not sure")[0].founder_estimate).toBeNull();
    expect(noteGoalViews([goal()], TODAY)[0].founder_estimate).toBeNull();
  });
  it("statusLineFor: the aim and 'Not counted yet', no 'No number yet'", () => {
    expect(statusLineFor(goal(), TODAY)).toBe("Not counted yet (aiming for 10 new customers), 90 days left");
    expect(statusLineFor(goal({ current_value: 4, current_value_at: "2026-10-28T00:00:00Z", measurement_mode: "manual_reported" }), TODAY)).toMatch(/^4 of 10 new customers/);
  });
});

describe("founder estimate", () => {
  it("is only for new-customers goals", () => {
    expect(isNewCustomersGoal({ target_metric: "new_customers", objective: "x" })).toBe(true);
    expect(isNewCustomersGoal({ target_metric: "paying_customers", objective: "x" })).toBe(true);
    expect(isNewCustomersGoal({ target_metric: "weekly_active_customers", objective: "Reach 15 weekly active customers" })).toBe(false);
    expect(isNewCustomersGoal({ target_metric: "signups", objective: "Reach 60 new customers" })).toBe(false);
    expect(isNewCustomersGoal({ target_metric: "", objective: "Win 6 new paying customers by Jan" })).toBe(true);
    expect(founderEstimateFor({ target_metric: "signups", objective: "x" }, "6-20")).toBeNull();
  });
  it("words the range, and says nothing for 'Not sure' or no answer", () => {
    expect(founderEstimateLine("1")).toBe("You told me 1 new customer last month");
    expect(founderEstimateLine("100+")).toBe("You told me 100+ new customers last month");
    expect(founderEstimateLine("Not sure")).toBeNull();
    expect(founderEstimateLine("  ")).toBeNull();
    expect(founderEstimateLine(null)).toBeNull();
  });
  it("reads the answer in one query from the strategy note; a failed read is null", async () => {
    read.result = { data: [{ customers: "6-20" }], error: null };
    expect(await readFounderCustomersAnswer("t1")).toBe("6-20");
    expect(read.calls.filter((c) => c[0] === "from")).toEqual([["from", "memory_note"]]);
    expect(read.calls).toContainEqual(["eq", "note_type", "growth_strategy"]);
    read.result = { data: null, error: { message: "denied" } };
    expect(await readFounderCustomersAnswer("t1")).toBeNull();
    read.throws = true;
    expect(await readFounderCustomersAnswer("t1")).toBeNull();
    read.throws = false;
    read.result = { data: [], error: null };
    expect(await readFounderCustomersAnswer("t1")).toBeNull();
  });
});

describe("cgo never asks the founder for a number or to connect a tool", () => {
  it("recognises number and connect asks, and leaves other questions alone", () => {
    expect(asksFounderForNumber("Can you connect Stripe so I can count your new customers?")).toBe(true);
    expect(asksFounderForNumber("Should I wait until you link your database so I can measure the goal?")).toBe(true);
    expect(asksFounderForNumber("How many new customers did you get last week?")).toBe(true);
    expect(asksFounderForNumber("What is your revenue today?")).toBe(true);
    expect(asksFounderForNumber("Should I pause Reddit?")).toBe(false);
    expect(asksFounderForNumber("How much should I spend on Meta this week?")).toBe(false);
    expect(asksFounderForNumber("Your goal shows $900; Stripe shows $40,000 in 30 days. Which should it track?")).toBe(false);
    expect(asksFounderForNumber("Should I set up Stripe so I can measure new customers?")).toBe(true);
    expect(asksFounderForNumber("Have your developer install the Reddit pixel so I can track signups.")).toBe(true);
    expect(asksFounderForNumber("Should I set up a Reddit test so I can track signups?")).toBe(false);
  });
  it("review F2: a legacy note.need line asking to connect a tool is dropped too", () => {
    const moves = { note: { need: ["Connect Stripe so I can count customers?", "Pick where your Google Ads show."] } } as never;
    const r = planModelQuestions({ moves, goals: [goal()], today: TODAY, acts: false });
    expect(r.asks.map((a) => a.ask)).toEqual(["Pick where your Google Ads show."]);
    expect(r.refused.join(" ")).toMatch(/asks the founder for a number or a connection/);
  });
  it("planModelQuestions drops a 'connect Stripe so I can count' question and keeps the rest", () => {
    const moves = { note: { questions: [
      { topic: "stripe", about: "x", ask: "Should I wait for you to connect Stripe so I can count customers?" },
      { topic: "reddit", about: "reddit_organic", ask: "Should I pause Reddit?" },
    ] } } as never;
    const r = planModelQuestions({ moves, goals: [goal()], today: TODAY, acts: false });
    expect(r.asks.map((a) => a.ask)).toEqual(["Should I pause Reddit?"]);
    expect(r.refused.join(" ")).toMatch(/never ask the founder for a number/);
  });
});
