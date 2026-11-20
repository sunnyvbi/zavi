import { describe, it, expect, vi, beforeEach } from "vitest";

const { reserveState, sbState, inngestState } = vi.hoisted(() => ({
  reserveState: {
    result: null as
      | { ok: true; reserved_usd: number; remaining_usd: number | null; idempotent_retry: boolean }
      | { ok: false; reason: string; detail: Record<string, unknown> }
      | null,
    shouldThrow: false,
    callCount: 0,
  },
  sbState: {
    childInsertReturn: null as
      | { data: Array<{ id: string; child_index: number }> | null; error: { message: string } | null }
      | null,
    batchUpdates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
    childInserts: [] as Array<Record<string, unknown>>,
  },
  inngestState: { sent: [] as Array<{ id: string; name: string; data: unknown }> },
}));

const { parentRuns, staffCap } = vi.hoisted(() => ({
  parentRuns: {} as Record<string, { tenant_id: string; payload: Record<string, unknown> }>,
  staffCap: { result: { ok: true } as { ok: true } | { ok: false; spent: number; cap: number } },
}));
vi.mock("@/services/auth/staff-model-access", () => ({
  checkStaffModelCap: vi.fn(async () => staffCap.result),
}));

const { unreserveSpy } = vi.hoisted(() => ({
  unreserveSpy: vi.fn(async (_input: Record<string, unknown>) => ({
    ok: true,
    refunded_usd: 0,
  })),
}));

vi.mock("@/services/agents/batch-fanout-reservation", () => ({
  reserveBatchFanoutBudgetOrReject: vi.fn(async () => {
    reserveState.callCount += 1;
    if (reserveState.shouldThrow) {
      throw new Error("RPC down");
    }
    return reserveState.result;
  }),
  unreserveBatchFanoutBudget: unreserveSpy,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from(table: string) {
      const builder = {
        select(_cols: string) {
          const f: Record<string, unknown> = {};
          const q = {
            eq(col: string, val: unknown) {
              f[col] = val;
              return q;
            },
            async maybeSingle() {
              const row = parentRuns[f.id as string];
              return { data: row && row.tenant_id === f.tenant_id ? { payload: row.payload } : null, error: null };
            },
          };
          return q;
        },
        update(patch: Record<string, unknown>) {
          const inner = {
            eq(_col: string, _val: unknown) {
              return inner;
            },
            then(resolve: (v: { error: null }) => void) {
              sbState.batchUpdates.push({ table, patch });
              resolve({ error: null });
            },
          };
          return inner;
        },
        insert(rows: Record<string, unknown> | Array<Record<string, unknown>>) {
          if (table === "agent_runs") {
            const list = Array.isArray(rows) ? rows : [rows];
            sbState.childInserts.push(...list);
            return {
              select(_cols: string) {
                return Promise.resolve(
                  sbState.childInsertReturn ?? {
                    data: list.map((r, i) => ({ id: `child-${i}`, child_index: r.child_index })),
                    error: null,
                  },
                );
              },
            };
          }
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  }),
}));

vi.mock("@/../workers/client", () => ({
  inngest: {
    send: vi.fn(async (evt: { id: string; name: string; data: unknown }) => {
      inngestState.sent.push(evt);
      return Promise.resolve();
    }),
  },
}));

import { dispatchBatchFanout } from "@/services/agents/batch-fanout-dispatcher";

const TENANT = "00000000-0000-0000-0000-000000000001";
const BATCH = "ba000000-0000-0000-0000-000000000001";
const THREAD = "11111111-1111-1111-1111-111111111111";

const baseInput = (overrides: Partial<Parameters<typeof dispatchBatchFanout>[0]> = {}) => ({
  batch_id: BATCH,
  tenant_id: TENANT,
  thread_id: THREAD,
  agent_slug: "engineer",
  agent_definition_hash: "abc123",
  cost_class: "expensive" as const,
  parent_message_id: "msg-1",
  approval_message_id: "yes-msg-1",
  approval_user_id: "operator-user-1",
  source_run_id: null as string | null,
  tasks: [
    { title: "Fix login redirect", task_description: "Login redirects to /; should go to /workspace" },
    { title: "Add dark mode toggle", task_description: "Add toggle in /settings/appearance" },
  ],
  ...overrides,
});

beforeEach(() => {
  reserveState.result = { ok: true, reserved_usd: 0.5, remaining_usd: null, idempotent_retry: false };
  reserveState.shouldThrow = false;
  reserveState.callCount = 0;
  sbState.childInsertReturn = null;
  sbState.batchUpdates = [];
  sbState.childInserts = [];
  inngestState.sent = [];
  unreserveSpy.mockClear();
  for (const k of Object.keys(parentRuns)) delete parentRuns[k];
  staffCap.result = { ok: true };
});

describe("dispatchBatchFanout — staff ?model= inheritance", () => {
  it("children carry the proposing run's staff_model and parent_run_id", async () => {
    parentRuns["run-p"] = { tenant_id: TENANT, payload: { staff_model: { key: "qwen" } } };
    const result = await dispatchBatchFanout(baseInput({ source_run_id: "run-p" }));
    expect(result.ok).toBe(true);
    expect(sbState.childInserts).toHaveLength(2);
    for (const row of sbState.childInserts) {
      expect(row.parent_run_id).toBe("run-p");
      expect((row.payload as Record<string, unknown>).staff_model).toEqual({ key: "qwen" });
    }
  });
  it("a parent in another tenant yields no staff_model", async () => {
    parentRuns["run-p"] = { tenant_id: "other-tenant", payload: { staff_model: { key: "qwen" } } };
    await dispatchBatchFanout(baseInput({ source_run_id: "run-p" }));
    for (const row of sbState.childInserts) {
      expect((row.payload as Record<string, unknown>).staff_model).toBeUndefined();
    }
  });
  it("no source run → children inherit nothing, parent_run_id null", async () => {
    await dispatchBatchFanout(baseInput());
    for (const row of sbState.childInserts) {
      expect(row.parent_run_id).toBeNull();
      expect((row.payload as Record<string, unknown>).staff_model).toBeUndefined();
    }
  });
  it("cap reached → staff_model_cap BEFORE the reservation; batch failed, no children", async () => {
    parentRuns["run-p"] = { tenant_id: TENANT, payload: { staff_model: { key: "qwen" } } };
    staffCap.result = { ok: false, spent: 200, cap: 200 };
    const result = await dispatchBatchFanout(baseInput({ source_run_id: "run-p" }));
    expect(result).toMatchObject({ ok: false, reason: "staff_model_cap" });
    expect(reserveState.callCount).toBe(0);
    expect(sbState.childInserts).toHaveLength(0);
    expect(inngestState.sent).toHaveLength(0);
    expect(sbState.batchUpdates.some((u) => u.table === "agent_run_batches" && u.patch.status === "failed")).toBe(true);
  });
});

describe("dispatchBatchFanout", () => {
  it("budget reject (daily_child_cap_exceeded) → batch 'failed', no children, no events", async () => {
    reserveState.result = {
      ok: false,
      reason: "daily_child_cap_exceeded",
      detail: { cap: 4, current: 4 },
    };

    const result = await dispatchBatchFanout(baseInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("daily_child_cap_exceeded");
    }
    expect(sbState.childInserts.length).toBe(0);
    expect(inngestState.sent.length).toBe(0);
    expect(sbState.batchUpdates.length).toBe(1);
    expect(sbState.batchUpdates[0].table).toBe("agent_run_batches");
    expect(sbState.batchUpdates[0].patch.status).toBe("failed");
  });

  it("budget RPC throws → returns budget_rpc_error, batch NOT marked failed (retry-safe)", async () => {
    reserveState.shouldThrow = true;

    const result = await dispatchBatchFanout(baseInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("budget_rpc_error");
    }
    expect(sbState.batchUpdates.length).toBe(0);
    expect(sbState.childInserts.length).toBe(0);
    expect(inngestState.sent.length).toBe(0);
  });

  it("happy path 2 children → 2 agent_runs rows + batch 'running' + 2 idempotency-keyed events", async () => {
    const result = await dispatchBatchFanout(baseInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.child_run_ids.length).toBe(2);
      expect(result.reserved_usd).toBe(0.5);
      expect(result.idempotent_retry).toBe(false);
    }

    expect(sbState.childInserts.length).toBe(2);
    sbState.childInserts.forEach((row, i) => {
      expect(row.tenant_id).toBe(TENANT);
      expect(row.batch_id).toBe(BATCH);
      expect(row.child_index).toBe(i);
      expect(row.status).toBe("queued");
      expect(row.trigger).toBe("chat");
      expect(row.agent_slug).toBe("engineer");
      expect(row.enqueued_by).toBe("operator-user-1");
      const payload = row.payload as Record<string, unknown>;
      expect(payload.thread_id).toBe(THREAD);
      expect(payload.batch_id).toBe(BATCH);
      expect(payload.child_index).toBe(i);
      expect(payload.source_agent).toBe("batch_fanout_child");
      expect(typeof payload.task_description).toBe("string");
      expect(payload.user_message_id).toBe("yes-msg-1");
    });

    const runningUpdate = sbState.batchUpdates.find(
      (u) => u.table === "agent_run_batches" && u.patch.status === "running",
    );
    expect(runningUpdate).toBeDefined();
    expect(
      sbState.batchUpdates.some(
        (u) => u.table === "agent_run_batches" && u.patch.status === "failed",
      ),
    ).toBe(false);

    expect(inngestState.sent.length).toBe(2);
    const ids = inngestState.sent.map((e) => e.id).sort();
    expect(ids).toEqual([
      `batch-fanout:${BATCH}:0`,
      `batch-fanout:${BATCH}:1`,
    ]);
    inngestState.sent.forEach((evt) => {
      expect(evt.name).toBe("agent.run.requested");
      const data = evt.data as Record<string, unknown>;
      expect(data.tenant_id).toBe(TENANT);
      expect(data.agent_slug).toBe("engineer");
      expect(typeof data.run_id).toBe("string");
    });
  });

  it("approval_user_id omitted (back-compat caller) → enqueued_by null on children", async () => {
    const result = await dispatchBatchFanout(baseInput({ approval_user_id: undefined }));

    expect(result.ok).toBe(true);
    expect(sbState.childInserts.length).toBe(2);
    sbState.childInserts.forEach((row) => {
      expect(row.enqueued_by).toBeNull();
    });
  });

  it("approval_message_id missing → REFUSES dispatch, inserts NO children", async () => {
    const result = await dispatchBatchFanout(baseInput({ approval_message_id: undefined }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_approval_message_id");
    expect(sbState.childInserts.length).toBe(0);
  });

  it("refusal happens BEFORE the budget reservation — no reservation is stranded", async () => {
    reserveState.callCount = 0;
    const result = await dispatchBatchFanout(baseInput({ approval_message_id: undefined }));

    expect(result.ok).toBe(false);
    expect(reserveState.callCount).toBe(0);
  });

  it("approval_message_id null → REFUSES dispatch (null is as fatal as undefined)", async () => {
    const result = await dispatchBatchFanout(baseInput({ approval_message_id: null }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_approval_message_id");
    expect(sbState.childInserts.length).toBe(0);
  });

  it("approval_message_id present → every child payload carries user_message_id", async () => {
    const result = await dispatchBatchFanout(
      baseInput({ approval_message_id: "msg-approve-1" }),
    );

    expect(result.ok).toBe(true);
    expect(sbState.childInserts.length).toBe(2);
    sbState.childInserts.forEach((row) => {
      const payload = row.payload as { user_message_id?: string };
      expect(payload.user_message_id).toBe("msg-approve-1");
    });
  });

  it("idempotent retry → result carries idempotent_retry:true through", async () => {
    reserveState.result = {
      ok: true,
      reserved_usd: 0.5,
      remaining_usd: null,
      idempotent_retry: true,
    };

    const result = await dispatchBatchFanout(baseInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.idempotent_retry).toBe(true);
    }
  });

  it("child insert count mismatch → batch 'failed', no events fired", async () => {
    sbState.childInsertReturn = {
      data: [{ id: "child-0", child_index: 0 }],
      error: null,
    };

    const result = await dispatchBatchFanout(baseInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("child_insert_count_mismatch");
    }
    expect(
      sbState.batchUpdates.some(
        (u) => u.table === "agent_run_batches" && u.patch.status === "failed",
      ),
    ).toBe(true);
    expect(inngestState.sent.length).toBe(0);
  });

  it("empty tasks list → reason 'child_insert_count_mismatch', no RPC call", async () => {
    const result = await dispatchBatchFanout(baseInput({ tasks: [] }));
    expect(result.ok).toBe(false);
    expect(reserveState.callCount).toBe(0);
    expect(sbState.childInserts.length).toBe(0);
    expect(inngestState.sent.length).toBe(0);
  });

  it("P1b.1: child_insert_failed → reservation refunded (the $1.6 ghost shape)", async () => {
    sbState.childInsertReturn = {
      data: null,
      error: { message: "insert exploded" },
    };
    const result = await dispatchBatchFanout(baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("child_insert_failed");
    expect(unreserveSpy).toHaveBeenCalledTimes(1);
    expect(unreserveSpy.mock.calls[0][0]).toMatchObject({
      batch_id: BATCH,
      refund_reason: "dispatcher_early_fail:child_insert_failed",
    });
  });

  it("P1b.1: child_insert_count_mismatch → reservation refunded", async () => {
    sbState.childInsertReturn = {
      data: [{ id: "child-0", child_index: 0 }],
      error: null,
    };
    const result = await dispatchBatchFanout(baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("child_insert_count_mismatch");
    expect(unreserveSpy).toHaveBeenCalledTimes(1);
    expect(unreserveSpy.mock.calls[0][0]).toMatchObject({
      refund_reason: "dispatcher_early_fail:child_insert_count_mismatch",
    });
  });

  it("P1b.1: cap-reject does NOT unreserve (no ledger row was written)", async () => {
    reserveState.result = {
      ok: false,
      reason: "daily_usd_cap_exceeded",
      detail: { cap: 1 },
    };
    await dispatchBatchFanout(baseInput());
    expect(unreserveSpy).not.toHaveBeenCalled();
  });

  it("per-task repo → each child's repo_hint is its OWN repo (multi-repo fan-out)", async () => {
    const result = await dispatchBatchFanout(
      baseInput({
        tasks: [
          {
            title: "backend trace header",
            task_description: "set X-Zavi-Trace in the backend",
            repo: "rravi149/upcar",
          },
          {
            title: "admin reads trace",
            task_description: "read X-Zavi-Trace in the admin app",
            repo: "rravi149/adminIosApp",
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    expect(sbState.childInserts.length).toBe(2);
    const hints = sbState.childInserts.map(
      (r) => (r.payload as Record<string, unknown>).repo_hint,
    );
    expect(hints).toEqual(["rravi149/upcar", "rravi149/adminIosApp"]);
  });

  it("per-task repo takes precedence over the batch-wide repo_hint fallback", async () => {
    const result = await dispatchBatchFanout(
      baseInput({
        repo_hint: "rravi149/fallback",
        tasks: [
          {
            title: "routed task",
            task_description: "work in the routed repo",
            repo: "rravi149/upcar",
          },
          { title: "unrouted task", task_description: "no repo on this one" },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    const hints = sbState.childInserts.map(
      (r) => (r.payload as Record<string, unknown>).repo_hint,
    );
    expect(hints).toEqual(["rravi149/upcar", "rravi149/fallback"]);
  });
});
