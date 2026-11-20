import { describe, it, expect, vi, beforeEach } from "vitest";

const rows: Record<string, Record<string, { tenant_id: string; payload?: Record<string, unknown> }>> = {};
const reads: Array<[string, string]> = [];

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          maybeSingle: async () => {
            reads.push([table, id]);
            return { data: rows[table]?.[id] ?? null, error: null };
          },
        }),
      }),
    }),
  }),
}));
const enqueueGoalOwnerRun = vi.fn(async () => ({ enqueued: true, run_id: "r-1" }));
vi.mock("@/services/growth/goal-owner", () => ({ enqueueGoalOwnerRun: (...a: unknown[]) => enqueueGoalOwnerRun(...(a as [])) }));
const sendGoalAttention = vi.fn(async () => {});
vi.mock("@/services/growth/goal-attention", () => ({ sendGoalAttention: (...a: unknown[]) => sendGoalAttention(...(a as [])) }));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));

import { handleGoalAttention } from "../cgo-goal-owner";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  for (const k of Object.keys(rows)) delete rows[k];
  rows.autopilot_goals = { g1: { tenant_id: A } };
  rows.agent_runs = {
    step: { tenant_id: A, payload: { dispatched_by: "cgo", goal_id: "g1" } },
    other: { tenant_id: A, payload: { dispatched_by: "chief-of-staff" } },
  };
  rows.decisions = { d1: { tenant_id: A } };
  reads.length = 0;
  enqueueGoalOwnerRun.mockClear();
  sendGoalAttention.mockClear();
});

describe("handleGoalAttention", () => {
  it("enqueues a review for the tenant read from the goal row", async () => {
    await handleGoalAttention({ tenant_id: A, reason: "goal_set", goal_id: "g1" });
    expect(reads).toEqual([["autopilot_goals", "g1"]]);
    expect(enqueueGoalOwnerRun).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: A, reason: "goal_set", goal_id: "g1" }),
    );
  });

  it("does nothing when the event's tenant is not the row's tenant", async () => {
    const r = await handleGoalAttention({ tenant_id: B, reason: "goal_set", goal_id: "g1" });
    expect(r).toEqual({ skipped: "tenant_mismatch" });
    expect(enqueueGoalOwnerRun).not.toHaveBeenCalled();
  });

  it("does nothing when the row is gone", async () => {
    const r = await handleGoalAttention({ tenant_id: A, reason: "card_rejected", decision_id: "missing" });
    expect(r).toEqual({ skipped: "row_not_found" });
    expect(enqueueGoalOwnerRun).not.toHaveBeenCalled();
  });

  it("resolves a rejected card through its decision row", async () => {
    await handleGoalAttention({ tenant_id: A, reason: "card_rejected", decision_id: "d1" });
    expect(reads).toEqual([["decisions", "d1"]]);
    expect(enqueueGoalOwnerRun).toHaveBeenCalledTimes(1);
  });
});

describe("review F2: a batched held ask keeps its one-tap answers", () => {
  it("bindNeedOrdinals gives a needs_you item with no ordinal its question's ordinal by exact words, and leaves the rest", async () => {
    const { bindNeedOrdinals } = await import("../cgo-goal-owner");
    const ask = "I did not raise “Rent a car at $35 per day” from $178.80 to $214.56 a day on my own. Should I apply it?";
    const q = { id: "q1", ordinal: 4, ask, recommended: null, why: null, yesNo: true, noteLine: ask, asked_at: "2026-10-29T01:41:59Z" };
    const items = [
      { section: "needs_you", text: ask },
      { section: "needs_you", text: "Something else entirely" },
      { section: "changed", text: ask },
      { section: "needs_you", text: ask, question_ordinal: 2 },
    ];
    const out = bindNeedOrdinals(items, [q])!;
    expect(out.map((i) => (i as { question_ordinal?: number | null }).question_ordinal ?? null)).toEqual([4, null, null, 2]);
    expect(bindNeedOrdinals(null, [q])).toBeNull();
    const twin = { ...q, id: "q2", ordinal: 5 };
    expect((bindNeedOrdinals([{ section: "needs_you", text: ask }], [q, twin])![0] as { question_ordinal?: number | null }).question_ordinal ?? null).toBeNull();
  });
});
