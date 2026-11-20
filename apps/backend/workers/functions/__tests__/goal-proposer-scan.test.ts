import { describe, it, expect } from "vitest";

import { vi } from "vitest";
vi.mock("../../client", () => ({
  inngest: { createFunction: (_c: unknown, _t: unknown, h: unknown) => ({ handler: h }) },
}));

import { runGoalProposer, gateFor, type Candidate, type GoalProposerDeps } from "../goal-proposer-scan";
import type { ProposedGoal } from "@/services/readiness/goal-proposer";

const GOAL: ProposedGoal = { objective: "Grow signups", target_metric: "signups", target_value: 100, rationale: "x" };

function deps(over: Partial<GoalProposerDeps> = {}): GoalProposerDeps & { wrote: string[]; recomputed: string[] } {
  const wrote: string[] = [];
  const recomputed: string[] = [];
  return {
    wrote,
    recomputed,
    propose: async () => GOAL,
    write: async (c: Candidate) => {
      wrote.push(c.tenant_id);
      return "goal-1";
    },
    recompute: async (t: string) => {
      recomputed.push(t);
    },
    log: (async () => {}) as unknown as GoalProposerDeps["log"],
    ...over,
  };
}

const cand = (id: string): Candidate => ({ tenant_id: id, company_brain: "We are a signup-led SaaS." });

describe("gateFor", () => {
  it("defaults ON; kills on explicit false; restricts on allowlist", () => {
    expect(gateFor({})).toEqual({ enabled: true, allowlist: [] });
    expect(gateFor({ goal_proposer_enabled: false }).enabled).toBe(false);
    expect(gateFor({ goal_proposer_tenants: ["t-1"] }).allowlist).toEqual(["t-1"]);
  });
});

describe("runGoalProposer", () => {
  it("proposes a goal, writes it, and recomputes the tenant", async () => {
    const d = deps();
    const res = await runGoalProposer([cand("t-1")], d);
    expect(res.proposed).toBe(1);
    expect(d.wrote).toEqual(["t-1"]);
    expect(d.recomputed).toEqual(["t-1"]);
  });

  it("skips (no error) when the RPC refuses because a founder goal exists (write→null)", async () => {
    const d = deps({ write: async () => null });
    const res = await runGoalProposer([cand("t-2")], d);
    expect(res.proposed).toBe(0);
    expect(res.skipped_no_proposal).toBe(1);
    expect(d.recomputed).toEqual([]);
  });

  it("skips when the model proposes nothing usable (propose→null) — no write, no recompute", async () => {
    const d = deps({ propose: async () => null });
    const res = await runGoalProposer([cand("t-3")], d);
    expect(res.proposed).toBe(0);
    expect(res.skipped_no_proposal).toBe(1);
    expect(d.wrote).toEqual([]);
  });

  it("isolates a throwing tenant — batch continues, error counted", async () => {
    let n = 0;
    const d = deps({
      propose: async () => {
        n++;
        if (n === 1) throw new Error("boom");
        return GOAL;
      },
    });
    const res = await runGoalProposer([cand("t-a"), cand("t-b")], d);
    expect(res.errors).toBe(1);
    expect(res.proposed).toBe(1);
    expect(d.recomputed).toEqual(["t-b"]);
  });
});
