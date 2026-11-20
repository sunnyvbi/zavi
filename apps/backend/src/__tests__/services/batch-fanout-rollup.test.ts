import { describe, it, expect, vi, beforeEach } from "vitest";

const { sbState } = vi.hoisted(() => ({
  sbState: {
    batchRow: null as
      | {
          id: string;
          status: string;
          task_specs: Array<{ title: string; task_description: string }>;
          rollup: Record<string, unknown>;
          thread_id: string | null;
          tenant_id: string;
        }
      | null,
    siblings: [] as Array<{
      id: string;
      child_index: number;
      status: string;
      cost_usd?: number;
    }>,
    rollupUpdates: [] as Array<Record<string, unknown>>,
    statusFlipUpdates: [] as Array<Record<string, unknown>>,
    statusFlipReturnRows: null as
      | Array<{ id: string; thread_id: string | null }>
      | null,
    summaryInserts: [] as Array<Record<string, unknown>>,
  },
}));

const { unreserveSpy } = vi.hoisted(() => ({
  unreserveSpy: vi.fn(
    async (_input: Record<string, unknown>) => ({
      ok: true,
      refunded_usd: 0,
      refunded_children: 0,
    }),
  ),
}));
vi.mock("@/services/agents/batch-fanout-reservation", () => ({
  unreserveBatchFanoutBudget: unreserveSpy,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from(table: string) {
      const builder = {
        select(_cols: string) {
          const inner = {
            eq(_col: string, _val: unknown) {
              return inner;
            },
            async maybeSingle() {
              if (table === "agent_run_batches") {
                return { data: sbState.batchRow, error: null };
              }
              return { data: null, error: null };
            },
            then(resolve: (v: { data: unknown[]; error: null }) => void) {
              if (table === "agent_runs") {
                resolve({ data: sbState.siblings, error: null });
              } else {
                resolve({ data: [], error: null });
              }
            },
          };
          return inner;
        },
        update(patch: Record<string, unknown>) {
          const inner = {
            eq(_col: string, _val: unknown) {
              return inner;
            },
            in(_col: string, _vals: unknown[]) {
              const innerCas = {
                select(_cols: string) {
                  return Promise.resolve({
                    data: sbState.statusFlipReturnRows ?? [
                      {
                        id: sbState.batchRow?.id ?? "",
                        thread_id: sbState.batchRow?.thread_id ?? null,
                      },
                    ],
                    error: null,
                  });
                },
              };
              sbState.statusFlipUpdates.push(patch);
              return innerCas;
            },
            then(resolve: (v: { error: null }) => void) {
              if (table === "agent_run_batches") {
                sbState.rollupUpdates.push(patch);
              }
              resolve({ error: null });
            },
          };
          return inner;
        },
        insert(row: Record<string, unknown>) {
          if (table === "agent_thread_messages") {
            sbState.summaryInserts.push(row);
          }
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  }),
}));

import { recordChildTerminalAndCheckBatch } from "@/services/agents/batch-fanout-rollup";

const TENANT = "00000000-0000-0000-0000-000000000001";
const BATCH = "ba000000-0000-0000-0000-000000000001";
const THREAD = "11111111-1111-1111-1111-111111111111";

const baseTasks = [
  { title: "Fix login redirect", task_description: "Login redirects to /; goes to /workspace" },
  { title: "Add dark mode toggle", task_description: "Toggle in /settings/appearance" },
];

beforeEach(() => {
  sbState.batchRow = {
    id: BATCH,
    status: "running",
    task_specs: baseTasks,
    rollup: {},
    thread_id: THREAD,
    tenant_id: TENANT,
  };
  sbState.siblings = [];
  sbState.rollupUpdates = [];
  sbState.statusFlipUpdates = [];
  sbState.statusFlipReturnRows = null;
  sbState.summaryInserts = [];
  unreserveSpy.mockClear();
});

describe("recordChildTerminalAndCheckBatch", () => {
  it("siblings still live → rollup write, batch_complete:false, no summary, no flip", async () => {
    sbState.siblings = [
      { id: "child-0", child_index: 0, status: "done" },
      { id: "child-1", child_index: 1, status: "running" },
    ];

    const result = await recordChildTerminalAndCheckBatch({
      run_id: "child-0",
      tenant_id: TENANT,
      batch_id: BATCH,
      child_index: 0,
      status: "done",
      pr_url: "https://github.com/x/y/pull/1",
    });

    expect(result.batch_complete).toBe(false);
    expect(result.final_batch_status).toBeUndefined();
    expect(sbState.rollupUpdates.length).toBe(1);
    const slot0 = (sbState.rollupUpdates[0].rollup as Record<string, unknown>)[
      "0"
    ] as { status: string; pr_url: string };
    expect(slot0.status).toBe("done");
    expect(slot0.pr_url).toBe("https://github.com/x/y/pull/1");
    expect(sbState.statusFlipUpdates.length).toBe(0);
    expect(sbState.summaryInserts.length).toBe(0);
  });

  it("all children done → batch flipped to 'done', summary lists PR URLs", async () => {
    sbState.siblings = [
      { id: "child-0", child_index: 0, status: "done" },
      { id: "child-1", child_index: 1, status: "done" },
    ];

    const result = await recordChildTerminalAndCheckBatch({
      run_id: "child-1",
      tenant_id: TENANT,
      batch_id: BATCH,
      child_index: 1,
      status: "done",
      pr_url: "https://github.com/x/y/pull/2",
    });

    expect(result.batch_complete).toBe(true);
    expect(result.final_batch_status).toBe("done");
    expect(sbState.statusFlipUpdates.length).toBe(1);
    expect(sbState.statusFlipUpdates[0].status).toBe("done");
    expect(sbState.summaryInserts.length).toBe(1);
    const summary = sbState.summaryInserts[0];
    expect(summary.thread_id).toBe(THREAD);
    expect(summary.sender_role).toBe("assistant");
    const body = summary.body as string;
    expect(body).toContain("Done — 2 tasks finished");
    expect(body).not.toContain(BATCH.slice(0, 8));
    expect(body).toContain("Fix login redirect");
    expect(body).toContain("Add dark mode toggle");
  });

  it("mixed outcomes → batch flipped to 'failed', summary lists per-child reasons", async () => {
    sbState.siblings = [
      { id: "child-0", child_index: 0, status: "done" },
      { id: "child-1", child_index: 1, status: "dispatch_error" },
    ];
    sbState.batchRow!.rollup = {
      "0": {
        run_id: "child-0",
        status: "done",
        finished_at: "x",
        pr_url: "https://github.com/x/y/pull/1",
      },
    };

    const result = await recordChildTerminalAndCheckBatch({
      run_id: "child-1",
      tenant_id: TENANT,
      batch_id: BATCH,
      child_index: 1,
      status: "dispatch_error",
      reason: "sandbox boot timeout",
    });

    expect(result.batch_complete).toBe(true);
    expect(result.final_batch_status).toBe("failed");
    expect(sbState.statusFlipUpdates[0].status).toBe("failed");
    const body = sbState.summaryInserts[0].body as string;
    expect(body).toContain("finished with failures");
    expect(body).toContain("dispatch_error");
    expect(body).toContain("sandbox boot timeout");
  });

  it("CAS-loss race → no summary write, batch_complete:false (degrade safe)", async () => {
    sbState.siblings = [
      { id: "child-0", child_index: 0, status: "done" },
      { id: "child-1", child_index: 1, status: "done" },
    ];
    sbState.statusFlipReturnRows = [];

    const result = await recordChildTerminalAndCheckBatch({
      run_id: "child-0",
      tenant_id: TENANT,
      batch_id: BATCH,
      child_index: 0,
      status: "done",
    });

    expect(result.batch_complete).toBe(false);
    expect(sbState.rollupUpdates.length).toBe(1);
    expect(sbState.summaryInserts.length).toBe(0);
  });

  it("missing siblings (count < task_specs.length) → not complete (degrade safe)", async () => {
    sbState.siblings = [
      { id: "child-0", child_index: 0, status: "done" },
    ];

    const result = await recordChildTerminalAndCheckBatch({
      run_id: "child-0",
      tenant_id: TENANT,
      batch_id: BATCH,
      child_index: 0,
      status: "done",
    });

    expect(result.batch_complete).toBe(false);
    expect(sbState.statusFlipUpdates.length).toBe(0);
    expect(sbState.summaryInserts.length).toBe(0);
  });

  it("empty task_specs → not complete (no division-by-zero false-positive)", async () => {
    sbState.batchRow!.task_specs = [];
    sbState.siblings = [];

    const result = await recordChildTerminalAndCheckBatch({
      run_id: "child-x",
      tenant_id: TENANT,
      batch_id: BATCH,
      child_index: 0,
      status: "done",
    });

    expect(result.batch_complete).toBe(false);
  });

  it("P0e: all children 'success' → batch flipped to 'done' (was the latent happy-path bug)", async () => {
    sbState.siblings = [
      { id: "child-0", child_index: 0, status: "success", cost_usd: 0.2 },
      { id: "child-1", child_index: 1, status: "success", cost_usd: 0.3 },
    ];
    const result = await recordChildTerminalAndCheckBatch({
      run_id: "child-1",
      tenant_id: TENANT,
      batch_id: BATCH,
      child_index: 1,
      status: "success",
      pr_url: "https://github.com/x/y/pull/9",
    });
    expect(result.batch_complete).toBe(true);
    expect(result.final_batch_status).toBe("done");
    expect(sbState.statusFlipUpdates[0].status).toBe("done");
    expect(sbState.summaryInserts[0].body as string).toContain(
      "https://github.com/x/y/pull/9",
    );
  });

  it("P0e: mixed 'success' + 'parse_failed' → batch flipped to 'failed'", async () => {
    sbState.siblings = [
      { id: "child-0", child_index: 0, status: "success", cost_usd: 0.4 },
      { id: "child-1", child_index: 1, status: "parse_failed", cost_usd: 0.5 },
    ];
    const result = await recordChildTerminalAndCheckBatch({
      run_id: "child-1",
      tenant_id: TENANT,
      batch_id: BATCH,
      child_index: 1,
      status: "parse_failed",
      reason: "envelope did not parse",
    });
    expect(result.batch_complete).toBe(true);
    expect(result.final_batch_status).toBe("failed");
  });

  it("P1b.2: failed batch → unreserve called with actual_spend = sum(cost_usd)", async () => {
    sbState.siblings = [
      { id: "child-0", child_index: 0, status: "dispatch_error", cost_usd: 0 },
      { id: "child-1", child_index: 1, status: "dispatch_error", cost_usd: 0 },
    ];
    await recordChildTerminalAndCheckBatch({
      run_id: "child-1",
      tenant_id: TENANT,
      batch_id: BATCH,
      child_index: 1,
      status: "dispatch_error",
    });
    expect(unreserveSpy).toHaveBeenCalledTimes(1);
    expect(unreserveSpy.mock.calls[0][0]).toMatchObject({
      batch_id: BATCH,
      actual_spend_usd: 0,
      refund_reason: "rollup_failed",
    });
  });

  it("P1b.2: done-underspent batch → unreserve called with the partial actual_spend", async () => {
    sbState.siblings = [
      { id: "child-0", child_index: 0, status: "success", cost_usd: 0.15 },
      { id: "child-1", child_index: 1, status: "success", cost_usd: 0.25 },
    ];
    await recordChildTerminalAndCheckBatch({
      run_id: "child-1",
      tenant_id: TENANT,
      batch_id: BATCH,
      child_index: 1,
      status: "success",
    });
    expect(unreserveSpy).toHaveBeenCalledTimes(1);
    expect(unreserveSpy.mock.calls[0][0]).toMatchObject({
      actual_spend_usd: 0.4,
      refund_reason: "rollup_done_underspent",
    });
  });

  it("P1b.2: refund throw is swallowed — rollup still returns batch_complete", async () => {
    unreserveSpy.mockRejectedValueOnce(new Error("rpc down"));
    sbState.siblings = [
      { id: "child-0", child_index: 0, status: "success", cost_usd: 0.1 },
      { id: "child-1", child_index: 1, status: "success", cost_usd: 0.1 },
    ];
    const result = await recordChildTerminalAndCheckBatch({
      run_id: "child-1",
      tenant_id: TENANT,
      batch_id: BATCH,
      child_index: 1,
      status: "success",
    });
    expect(result.batch_complete).toBe(true);
    expect(result.final_batch_status).toBe("done");
  });
});
