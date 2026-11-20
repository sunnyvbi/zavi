import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  reads: {} as Record<string, Array<Array<Record<string, unknown>>>>,
  updates: [] as Array<{ table: string; payload: unknown; ids: unknown }>,
  sends: [] as unknown[],
  reviews: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../client", () => ({
  inngest: { createFunction: () => ({}), send: vi.fn(async (e: unknown) => void H.sends.push(e)) },
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      let upd: unknown = null;
      const b: Record<string, unknown> = {};
      for (const f of ["select", "eq", "neq", "lt", "lte", "gte", "is", "or", "order", "limit"]) b[f] = () => b;
      b.update = (p: unknown) => ((upd = p), b);
      b.in = (_c: string, ids: unknown) => {
        if (upd) H.updates.push({ table, payload: upd, ids });
        return b;
      };
      b.then = (res: (v: unknown) => unknown) => {
        if (upd) return res({ error: null });
        return res({ data: (H.reads[table] ?? []).shift() ?? [], error: null });
      };
      return b;
    },
  }),
}));
vi.mock("@/services/memory", () => ({ finishPendingNote: vi.fn(), searchMemory: vi.fn() }));
vi.mock("@/services/memory/remembered", () => ({ purgeForgetRequest: vi.fn() }));
vi.mock("@/services/logging/log-review", () => ({ logReview: (r: Record<string, unknown>) => H.reviews.push(r) }));

import { sweepPendingProposals } from "../memory-write-maintenance";

beforeEach(() => {
  H.reads = {};
  H.updates = [];
  H.sends = [];
  H.reviews = [];
});

describe("sweepPendingProposals", () => {
  it("expires proposals older than 24h and re-queues each younger run's distill once", async () => {
    H.reads.memory_write_log = [
      [{ id: "old-1", tenant_id: "t1" }],
      [
        { id: "p1", tenant_id: "t1", run_id: "run-chat" },
        { id: "p2", tenant_id: "t1", run_id: "run-chat" },
        { id: "p3", tenant_id: "t2", run_id: "run-cron" },
        { id: "p4", tenant_id: "t3", run_id: "run-elsewhere" },
      ],
    ];
    H.reads.agent_runs = [
      [
        { id: "run-chat", tenant_id: "t1", agent_slug: "operator", trigger: "chat", status: "success" },
        { id: "run-cron", tenant_id: "t2", agent_slug: "cgo", trigger: "cron", status: "success" },
        { id: "run-elsewhere", tenant_id: "t9", agent_slug: "cgo", trigger: "cron", status: "success" },
      ],
    ];
    const out = await sweepPendingProposals();
    expect(out).toEqual({ expired: 1, requeued_runs: 2 });
    expect(H.updates).toEqual([
      { table: "memory_write_log", payload: { action: "proposal_expired" }, ids: ["old-1"] },
      { table: "memory_write_log", payload: { reason: "requeued" }, ids: ["p1", "p2", "p3", "p4"] },
    ]);
    expect(H.sends).toEqual([
      { name: "chat.turn_complete", data: { run_id: "run-chat", tenant_id: "t1", agent_slug: "operator" } },
      { name: "agent.run.distillable", data: { run_id: "run-cron", tenant_id: "t2", agent_slug: "cgo" } },
    ]);
    expect(H.reviews).toEqual([expect.objectContaining({ feature: "memory_write", event: "proposal_expired", meta: { expired: 1 } })]);
  });

  it("a failed run is not re-queued (its proposals expire)", async () => {
    H.reads.memory_write_log = [[], [{ id: "p1", tenant_id: "t1", run_id: "run-x" }]];
    H.reads.agent_runs = [[{ id: "run-x", tenant_id: "t1", agent_slug: "cgo", trigger: "cron", status: "failed" }]];
    expect(await sweepPendingProposals()).toEqual({ expired: 0, requeued_runs: 0 });
    expect(H.sends).toHaveLength(0);
    expect(H.updates).toEqual([{ table: "memory_write_log", payload: { reason: "requeued" }, ids: ["p1"] }]);
  });

  it("a run still paused for approval keeps its proposals unmarked for a later sweep", async () => {
    H.reads.memory_write_log = [[], [{ id: "p1", tenant_id: "t1", run_id: "run-p" }]];
    H.reads.agent_runs = [[{ id: "run-p", tenant_id: "t1", agent_slug: "cgo", trigger: "cron", status: "paused_awaiting_approval" }]];
    expect(await sweepPendingProposals()).toEqual({ expired: 0, requeued_runs: 0 });
    expect(H.sends).toHaveLength(0);
    expect(H.updates).toHaveLength(0);
  });

  it("nothing pending = no writes, no sends", async () => {
    expect(await sweepPendingProposals()).toEqual({ expired: 0, requeued_runs: 0 });
    expect(H.updates).toHaveLength(0);
    expect(H.sends).toHaveLength(0);
  });
});
