import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import { runScenario } from "../loop";
import { SCENARIOS } from "../scenarios";
import { scoreRun } from "../score";
import { SIM_GOAL_ID, createCgoAdapter, simNow, watchStateOf, type CgoModelCall } from "../cgo-adapter";
import { channelViews } from "@/services/growth/cgo-watch";
import { createStubAdapter } from "../stub-adapter";
import type { Scenario } from "../types";

const byId = (id: string): Scenario => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s;
};

type Ctx = { payload: { alarm_keys: string[]; memory: { cgo_goals: { channels: Array<{ channel_slug: string; oldest_waiting_days: number | null; last_14_days: { acted: number; rejected: number } }>; wake: { check_reasons: string[] } } } } };
const contextOf = (user: string): Ctx => JSON.parse(user.slice(user.indexOf("```json") + 7, user.lastIndexOf("```")));

function scripted(seen: Ctx[]): CgoModelCall {
  return async (_system, user) => {
    const ctx = contextOf(user);
    seen.push(ctx);
    const ignored = ctx.payload.memory.cgo_goals.channels.filter(
      (c) => (c.oldest_waiting_days ?? 0) >= 5 && c.last_14_days.acted + c.last_14_days.rejected === 0,
    );
    const moves = {
      goals: [{ goal_id: SIM_GOAL_ID, status_line: "On it.", moves: [] }],
      note: { saw: ignored.map((c) => `${c.channel_slug}: every card sat untouched`), need: [] },
      channel_changes: ignored.map((c) => ({ channel_slug: c.channel_slug, action: "pause", why: "No card was ever acted on." })),
      next_review_in_days: 7,
    };
    return { text: `<goal_moves>${JSON.stringify(moves)}</goal_moves>`, tokens: 100 };
  };
}

const run = (id: string, arm: "with" | "blind", call: CgoModelCall) => {
  const s = byId(id);
  return runScenario(s, { seed: 1, arm, adapter: createCgoAdapter({ outcomeLabel: s.outcomeLabel, systemPrompt: "sys", callModel: call, arm }) });
};

describe("cgo adapter (cgo's own check, context and apply rules on a simulated company)", () => {
  it("a plan-picked channel cgo pauses is paused, through cgo's apply rules", async () => {
    const seen: Ctx[] = [];
    const log = await run("1-saas-reddit-ignored", "with", scripted(seen));
    expect(scoreRun(byId("1-saas-reddit-ignored"), log).pass).toBe(true);
    expect(log.final.channels.find((c) => c.slug === "reddit_organic")?.pausedDay).not.toBeNull();
    expect(log.days[0].reasons).toContain("review_due");
  });

  it("a question with a pause default is asked once; on silence the daily check pauses the channel (no model)", async () => {
    let asks = 0;
    const ask: CgoModelCall = async () => {
      asks++;
      const moves = {
        goals: [{ goal_id: SIM_GOAL_ID, moves: [] }],
        note: { questions: [{ topic: "reddit", ask: "Reddit cards sit untouched. Keep it?", if_no_answer: { action: "pause_channel", channel_slug: "reddit_organic" }, by_days: 2 }] },
        next_review_in_days: 2,
      };
      return { text: `<goal_moves>${JSON.stringify(moves)}</goal_moves>`, tokens: 100 };
    };
    const log = await run("1-saas-reddit-ignored", "with", ask);
    const needs = log.days.flatMap((d) => d.applied?.note.need ?? []);
    expect(asks).toBeGreaterThan(1);
    expect(needs.filter((n) => n.includes("Keep it?"))).toHaveLength(1);
    expect(needs[0]).toContain("I'll pause Reddit.");
    expect(log.final.channels.find((c) => c.slug === "reddit_organic")?.pausedDay).not.toBeNull();
    expect(log.final.notes.some((n) => n.changed.some((l) => l.includes("so I paused Reddit as I said I would")))).toBe(true);
  });

  it("a founder-added, never-approved channel becomes a question, and its silence default is refused (the RPC rule)", async () => {
    const log = await run("1b-saas-reddit-founder-added", "with", scripted([]));
    expect(log.final.channels.find((c) => c.slug === "reddit_organic")?.pausedDay).toBeNull();
    const needs = log.days.flatMap((d) => d.applied?.note.need ?? []);
    expect(needs.some((n) => n.includes("Reddit") && n.includes("approved"))).toBe(true);
    expect(scoreRun(byId("1b-saas-reddit-founder-added"), log).pass).toBe(true);
  });

  it("autopilot off: advice only, nothing applied", async () => {
    const log = await run("1c-saas-reddit-autopilot-off", "with", scripted([]));
    for (const d of log.days) expect((d.applied?.channelPauses.length ?? 0) + (d.applied?.goalChanges.length ?? 0)).toBe(0);
    const needs = log.days.flatMap((d) => d.applied?.note.need ?? []);
    expect(needs.some((n) => n.includes("Reddit") && !n.includes("I'll pause"))).toBe(true);
  });

  it("the blind arm shows cgo neither the wake reasons nor the alarm keys", async () => {
    const seen: Ctx[] = [];
    await run("1-saas-reddit-ignored", "blind", scripted(seen));
    expect(seen.length).toBeGreaterThan(0);
    for (const c of seen) {
      expect(c.payload.memory.cgo_goals.wake.check_reasons).toEqual([]);
      expect(c.payload.alarm_keys).toEqual([]);
    }
  });

  it("an unparseable reply applies nothing, and the check waits a week (cgo's rule) instead of retrying daily", async () => {
    const log = await run("C-healthy-control", "with", async () => ({ text: "I think things look fine.", tokens: 10 }));
    const reviewed = log.days.filter((d) => d.applied);
    expect(reviewed.map((d) => d.day)).toEqual([1, 8]);
    for (const d of reviewed) expect(d.applied?.note.saw).toEqual([]);
  });

  it("the sim's 'opened but not acted' is cgo's own number, every day", async () => {
    const stub = createStubAdapter();
    let compared = 0;
    const probe = {
      ...stub,
      dailyCheck: (signals: Parameters<typeof stub.dailyCheck>[0], state: Parameters<typeof stub.dailyCheck>[1]) => {
        const views = channelViews(watchStateOf(state, "trials", [], null), simNow(state.day));
        for (const c of signals.channels) {
          const v = views.find((x) => x.channel_slug === c.slug);
          if (!v) continue;
          expect({ day: state.day, slug: c.slug, n: c.cards14d.seenNotActed }).toEqual({ day: state.day, slug: c.slug, n: v.opened_but_not_acted });
          compared++;
        }
        return stub.dailyCheck(signals, state);
      },
    };
    for (const seed of [1, 2, 3]) await runScenario(byId("1-saas-reddit-ignored"), { seed, arm: "with", adapter: probe });
    expect(compared).toBeGreaterThan(30);
  });

  it("an active founder approves cgo's cards and the work comes back as a finished step", async () => {
    const finished: number[] = [];
    let first = true;
    const call: CgoModelCall = async (_sys, user) => {
      const ctx = JSON.parse(user.slice(user.indexOf("```json") + 7, user.lastIndexOf("```")));
      finished.push(ctx.payload.memory.cgo_goals.finished_steps.length);
      const moves = first ? [{ target_agent_slug: "research", intent: "Find where clinic managers look for tools.", why: "" }] : [];
      first = false;
      const out = { goals: [{ goal_id: SIM_GOAL_ID, status_line: "ok", moves }], note: { saw: [], need: [] }, next_review_in_days: 3 };
      return { text: `<goal_moves>${JSON.stringify(out)}</goal_moves>`, tokens: 1 };
    };
    await run("C-healthy-control", "with", call);
    expect(finished[0]).toBe(0);
    expect(finished.slice(1).some((n) => n === 1)).toBe(true);
  });
});

describe("simulatedStepResult", () => {
  it("reports only the sim's own numbers, labelled as simulated", async () => {
    const { simulatedStepResult } = await import("../cgo-adapter");
    const s = byId("1-saas-reddit-ignored");
    const log = await runScenario(s, { seed: 1, arm: "with", adapter: createStubAdapter() });
    const out = simulatedStepResult(log.final, "find what converts");
    expect(out.startsWith("Simulated result.")).toBe(true);
    expect(out).toContain("reddit_organic 0 visits (0 posts approved)");
    expect(out).toContain("Task was: find what converts");
  });
});

describe("cgo adapter in a causal world (PLAN-cgo-benchmark-v2)", () => {
  it("cgo's tagged research runs at once, and the sheet's finding reaches its next review", async () => {
    const { CAUSAL_DENTAL } = await import("../causal-scenarios");
    const users: string[] = [];
    let n = 0;
    const call: CgoModelCall = async (_system, user) => {
      users.push(user);
      const moves =
        n++ === 0
          ? [{ target_agent_slug: "research", intent: "Find where visitors drop off on the booking page", why: "0.8% converts", problem: "conversion" }]
          : [];
      return { text: `<goal_moves>${JSON.stringify({ goals: [{ goal_id: SIM_GOAL_ID, moves }], next_review_in_days: 2 })}</goal_moves>`, tokens: 1 };
    };
    const log = await runScenario(CAUSAL_DENTAL, {
      seed: 1,
      arm: "with",
      adapter: createCgoAdapter({ outcomeLabel: "bookings", systemPrompt: "sys", callModel: call, arm: "with", causal: true }),
    });
    const job = log.final.jobs[0];
    expect(job).toMatchObject({ target_agent: "research", problem: "conversion", status: "done" });
    const later = users.slice(1).join("\n");
    expect(later).toContain("insurance-member-ID");
  });
});

describe("cgo adapter with the hypothesis tracker (PLAN-cgo-hypothesis-tracker)", () => {
  it("a move naming no hypothesis starts nothing; research on a listed one runs; its finding, confirmed by the checker, unlocks copy work", async () => {
    const { CAUSAL_DENTAL } = await import("../causal-scenarios");
    const contexts: string[] = [];
    let n = 0;
    const call: CgoModelCall = async (_system, user) => {
      contexts.push(user);
      const i = n++;
      const hyp = /"id": ?"(00000000-0000-4000-a000-[0-9]+)"/.exec(user)?.[1];
      const confirmed = /"status": ?"confirmed"/.test(user);
      const body =
        i === 0
          ? {
              hypotheses: [{ goal_id: SIM_GOAL_ID, ref: "h1", problem: "conversion", claim: "Visitors drop off in the booking form", refute_if: "Most visitors finish the form", rank: 1 }],
              goals: [{ goal_id: SIM_GOAL_ID, moves: [
                { target_agent_slug: "content-design", intent: "Rewrite the page", why: "", problem: "conversion" },
                { target_agent_slug: "research", intent: "Find where visitors leave the booking form", why: "", problem: "conversion", hypothesis: "h1" },
              ] }],
              next_review_in_days: 2,
            }
          : confirmed
            ? { goals: [{ goal_id: SIM_GOAL_ID, moves: [{ target_agent_slug: "content-design", intent: "Make the insurance field optional in the form copy", why: "", problem: "conversion", hypothesis: hyp }] }], next_review_in_days: 2 }
            : { next_review_in_days: 2 };
      return { text: `<goal_moves>${JSON.stringify(body)}</goal_moves>`, tokens: 1 };
    };
    const checker = async (_s: string, user: string) => {
      const id = /id: (\S+)/.exec(user)?.[1] ?? "";
      const quote = "insurance-member-ID step";
      return JSON.stringify({ verdicts: [{ id, verdict: user.includes(quote) ? "confirmed" : "testing", quote: user.includes(quote) ? quote : "", why: "report", gain_plausible: null }] });
    };
    const log = await runScenario(CAUSAL_DENTAL, {
      seed: 1,
      arm: "with",
      adapter: createCgoAdapter({ outcomeLabel: "bookings", systemPrompt: "sys", callModel: call, arm: "with", causal: true, hypotheses: { checker } }),
    });
    const moves = log.days.flatMap((d) => d.applied?.moves ?? []);
    expect(moves[0]).toMatchObject({ target_agent: "research", problem: "conversion" });
    expect(moves.some((m) => m.target_agent === "content-design" && m.hypothesis_id)).toBe(true);
    expect(moves.filter((m) => m.target_agent === "content-design").every((m) => m.hypothesis_id)).toBe(true);
    expect(contexts.some((c) => /"status": ?"confirmed"/.test(c) && c.includes("insurance-member-ID step"))).toBe(true);
  });
});

describe("cgo adapter: the note as items", () => {
  it("a question is a Needs you item by its ordinal, and applied.note.sections is the shared section model", async () => {
    const log = await run("1-saas-reddit-ignored", "with", scripted([]));
    const asked = log.days.find((d) => (d.applied?.note.need.length ?? 0) > 0)!.applied!;
    expect(asked.note.items).toEqual([expect.objectContaining({ section: "needs_you", question_ordinal: 1 })]);
    expect(asked.note.sections).toEqual([
      { key: "needs_you", title: "Needs you", rows: [{ line: asked.note.need[0], url: null, question_ordinal: 1 }], more: null },
    ]);
    expect(asked.note.headline).toBe("1 question for you.");
    const quiet = log.days.find((d) => d.applied && d.applied.note.sent === false)!.applied!;
    expect(quiet.note.items).toEqual([]);
    expect(quiet.note.sections).toEqual([]);
  });

  it("a goal change is an undoable change; an auto-run is Working on, in cgo's words", async () => {
    let n = 0;
    const call: CgoModelCall = async () => {
      n++;
      const moves =
        n === 1
          ? { goals: [{ goal_id: SIM_GOAL_ID, moves: [] }], goal_changes: [{ goal_id: SIM_GOAL_ID, objective: "Reach 40 paid trials", why: "Paid is the real goal." }], next_review_in_days: 2 }
          : n === 2
            ? { goals: [{ goal_id: SIM_GOAL_ID, moves: [{ target_agent_slug: "research", intent: "count cancelled trials", why: "because churn is the gap", action: "Counting cancelled trials", problem: "retention" }] }], next_review_in_days: 7 }
            : { goals: [{ goal_id: SIM_GOAL_ID, moves: [] }], next_review_in_days: 7 };
      return { text: `<goal_moves>${JSON.stringify(moves)}</goal_moves>`, tokens: 10 };
    };
    const log = await run("C-healthy-control", "with", call);
    const [first, second] = log.days.filter((d) => d.applied).map((d) => d.applied!);
    expect(first.note.items?.find((i) => i.goal_id === SIM_GOAL_ID)).toMatchObject({ section: "changed", undoable: true });
    expect(first.note.sections?.map((s) => s.key)).toEqual(["changed"]);
    expect(second.note.items?.find((i) => i.section === "working_on")).toMatchObject({ text: "Research: Counting cancelled trials", reason: "Churn is the gap", channel_slug: "research" });
  });
});
