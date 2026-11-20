
import { beforeEach, describe, expect, it, vi } from "vitest";

type Meta = Record<string, unknown>;
let note: { id: string; title: string; body_markdown: string; tags: string[]; metadata: Meta } | null;
const writes: Array<{ metadata: Meta; source: string }> = [];
const commits: Array<{ bets: Array<{ autorun: boolean; channel_slug: string }> }> = [];
const goals: Array<{ objective: string }> = [];
let commitOk = true;

vi.mock("../strategy-note", () => ({
  readStrategyNote: vi.fn(async () => note),
}));

vi.mock("@/services/memory", () => ({
  writeNote: vi.fn(async (_t: string, input: { metadata: Meta; source: string }) => {
    writes.push(input);
    if (note) note = { ...note, metadata: input.metadata };
  }),
}));

vi.mock("@/services/memory/upsert-anchor", () => ({ upsertAnchor: vi.fn(async () => {}) }));
vi.mock("@/services/memory/brain-slots", () => ({ sanitizeGapAnswer: (s: string) => s }));

vi.mock("@/routes/workspace/autopilot", () => ({
  createFounderGoalServiceRole: vi.fn(async (g: { objective: string }) => {
    goals.push(g);
    return { ok: true, id: `goal-${goals.length}` };
  }),
  commitGrowthPlanServiceRole: vi.fn(async (p: { bets: Array<{ autorun: boolean; channel_slug: string }> }) => {
    commits.push(p);
    return commitOk ? { ok: true } : { ok: false, message: "no valid bets" };
  }),
}));

vi.mock("@/routes/workspace/growth-strategy", () => ({
  projectStrategy: (raw: unknown) => raw ?? null,
}));

import { applyGrowthStrategy } from "../apply-strategy";

const strategy = (over: Partial<Record<string, unknown>> = {}) => ({
  north_star: { metric: "signups", why: "it is the funnel" },
  constraint: { statement: "too few visitors", confidence: "medium", lever_family: "acquisition" },
  goal: { objective: "Grow signups to 500", target_metric: "signups", target_value: 500, due_date: null },
  channel_bets: [
    { channel_slug: "seo", intent: "publish pages", rationale: "cheap", expected_effect: "+", falsifier: "no lift" },
    { channel_slug: "meta_ads", intent: "retarget", rationale: "warm", expected_effect: "+", falsifier: "no lift" },
  ],
  basis_evidence: [],
  ...over,
});

const setNote = (s: unknown, meta: Meta = {}) => {
  note = {
    id: "note-1",
    title: "Growth strategy",
    body_markdown: "",
    tags: ["current-growth-strategy"],
    metadata: { kind: "growth_strategy", strategy: s, ...meta },
  };
};

beforeEach(() => {
  writes.length = 0;
  commits.length = 0;
  goals.length = 0;
  commitOk = true;
  setNote(strategy());
});

describe("applyGrowthStrategy", () => {
  it("commits every bet with autorun OFF", async () => {
    const r = await applyGrowthStrategy("t1", { by: "agent", run_id: "run-1" });
    expect(r.applied).toBe(true);
    expect(commits).toHaveLength(1);
    expect(commits[0].bets.map((b) => b.autorun)).toEqual([false, false]);
  });

  it("the goal names who applied it: cgo with its run, or the founder on the page (autopilot tracking T1)", async () => {
    await applyGrowthStrategy("t1", { by: "agent", run_id: "run-1" });
    expect((goals.at(-1) as { actor?: unknown }).actor).toMatchObject({ source: "cgo", run_id: "run-1" });
  });

  it("marks the strategy accepted and records what it applied", async () => {
    await applyGrowthStrategy("t1", { by: "agent", run_id: "run-1" });
    const meta = writes.at(-1)!.metadata;
    expect(meta.accepted).toBe(true);
    expect(typeof meta.applied_fingerprint).toBe("string");
    expect(meta.applied_goal_id).toBe("goal-1");
  });

  it("is a no-op when the same strategy is applied again", async () => {
    await applyGrowthStrategy("t1", { by: "agent", run_id: "run-1" });
    const second = await applyGrowthStrategy("t1", { by: "agent", run_id: "run-1" });
    expect(second).toMatchObject({ applied: true, skipped: "unchanged" });
    expect(commits).toHaveLength(1);
    expect(goals).toHaveLength(1);
  });

  it("re-commits when a bet changes, without adding a second goal", async () => {
    await applyGrowthStrategy("t1", { by: "agent", run_id: "run-1" });
    const meta = note!.metadata;
    setNote(
      strategy({
        goal: { objective: "Grow signups to 500 this quarter", target_metric: "signups", target_value: 500, due_date: null },
        channel_bets: [{ channel_slug: "seo", intent: "publish more pages", rationale: "cheap", expected_effect: "+", falsifier: "no lift" }],
      }),
      { accepted: true, applied_fingerprint: meta.applied_fingerprint, applied_spine: meta.applied_spine, applied_goal_id: meta.applied_goal_id },
    );
    await applyGrowthStrategy("t1", { by: "agent", run_id: "run-1" });
    expect(commits).toHaveLength(2);
    expect(goals).toHaveLength(1);
  });

  it("writes a new goal when the plan now chases a different number", async () => {
    await applyGrowthStrategy("t1", { by: "agent", run_id: "run-1" });
    const meta = note!.metadata;
    setNote(
      strategy({
        north_star: { metric: "bookings", why: "revenue" },
        goal: { objective: "Grow bookings to 200", target_metric: "bookings", target_value: 200, due_date: null },
      }),
      { accepted: true, applied_fingerprint: meta.applied_fingerprint, applied_spine: meta.applied_spine },
    );
    await applyGrowthStrategy("t1", { by: "agent", run_id: "run-1" });
    expect(goals).toHaveLength(2);
  });

  it("does not record the strategy as applied when its plan did not land", async () => {
    commitOk = false;
    const r = await applyGrowthStrategy("t1", { by: "agent", run_id: "run-1" });
    expect(r.applied).toBe(false);
    expect(r.problems.join(" ")).toMatch(/plan not committed/);
    expect(writes).toHaveLength(0);
  });

  it("reports no_strategy when there is nothing to apply", async () => {
    note = null;
    const r = await applyGrowthStrategy("t1", { by: "page", user_id: "u-1" });
    expect(r).toMatchObject({ applied: false, skipped: "no_strategy" });
    expect(commits).toHaveLength(0);
  });

  it("labels the note by who applied it", async () => {
    await applyGrowthStrategy("t1", { by: "page", user_id: "u-1" });
    expect(writes.at(-1)!.source).toBe("human");
    setNote(strategy({ channel_bets: [{ channel_slug: "sms", intent: "x", rationale: null, expected_effect: null, falsifier: "y" }] }));
    await applyGrowthStrategy("t1", { by: "agent", run_id: "r" });
    expect(writes.at(-1)!.source).toBe("agent_run");
  });
});
