import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient() must not be called when svc is injected");
  },
}));

import {
  reapStaleRuns,
  staleRunReapHours,
  STALE_RUN_REAP_HOURS_DEFAULT,
  conductorProvisionStuckMinutes,
  conductorActiveStuckMinutes,
  CONDUCTOR_PROVISION_STUCK_MIN_DEFAULT,
  CONDUCTOR_ACTIVE_STUCK_MIN_DEFAULT,
} from "@/services/agents/stale-run-reaper";
import { isInfraRetryable, willBeInfraRetried } from "@/services/agents/infra-retry";

const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const CUTOFF_2H = new Date(NOW - 2 * 3600_000).toISOString();

type Resp = { data: unknown; error: { message: string } | null };

interface Trace {
  table: string;
  select: string | null;
  update: Record<string, unknown> | null;
  eq: Array<[string, unknown]>;
  lt: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  in: [string, unknown[]] | null;
  filter: Array<[string, string, unknown]>;
  limit: number | null;
  single: boolean;
}

function makeSvc(router: (t: Trace) => Resp, rpcResults?: Record<string, Resp>) {
  const traces: Trace[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  function from(table: string) {
    const trace: Trace = {
      table,
      select: null,
      update: null,
      eq: [],
      lt: [],
      is: [],
      in: null,
      filter: [],
      limit: null,
      single: false,
    };
    traces.push(trace);
    const b: Record<string, unknown> = {
      select(c: string) {
        trace.select = c;
        return b;
      },
      update(p: Record<string, unknown>) {
        trace.update = p;
        return b;
      },
      eq(c: string, v: unknown) {
        trace.eq.push([c, v]);
        return b;
      },
      lt(c: string, v: unknown) {
        trace.lt.push([c, v]);
        return b;
      },
      is(c: string, v: unknown) {
        trace.is.push([c, v]);
        return b;
      },
      in(c: string, v: unknown[]) {
        trace.in = [c, v];
        return b;
      },
      filter(c: string, op: string, v: unknown) {
        trace.filter.push([c, op, v]);
        return b;
      },
      limit(n: number) {
        trace.limit = n;
        return b;
      },
      single() {
        trace.single = true;
        return b;
      },
      maybeSingle() {
        trace.single = true;
        return b;
      },
      then(resolve: (r: Resp) => void) {
        resolve(router(trace));
      },
    };
    return b;
  }
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn !== "expire_parked_look_runs") rpcCalls.push({ fn, args });
    return rpcResults?.[fn] ?? { data: null, error: null };
  });
  return { svc: { from, rpc } as never, traces, rpcCalls };
}

const isBlockedSweepSelect = (t: Trace) =>
  t.update === null &&
  t.eq.some(([c, v]) => c === "status" && v === "blocked") &&
  t.in === null;
const isQueuedSweepSelect = (t: Trace) =>
  t.update === null &&
  t.eq.some(([c, v]) => c === "status" && v === "queued") &&
  t.in === null;
const isBlockerStatusSelect = (t: Trace) =>
  t.update === null && t.in !== null && t.in[0] === "id";
const isInflightCheck = (t: Trace) =>
  t.update === null && t.filter.length > 0 && t.in?.[0] === "status";
const isSlugFetch = (t: Trace) => t.update === null && t.select === "agent_slug";
const isCasUpdate = (t: Trace) => t.update !== null;

const EMPTY: Resp = { data: [], error: null };

const blockedRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "b1",
  tenant_id: "t1",
  agent_slug: "operator",
  blocked_by_run_id: "r0",
  payload: { thread_id: "th1" },
  ...over,
});

const queuedRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "q1",
  tenant_id: "t1",
  agent_slug: "advisor",
  payload: { thread_id: "th2" },
  ...over,
});

afterEach(() => {
  delete process.env.STALE_RUN_REAP_HOURS;
});

describe("staleRunReapHours", () => {
  it("defaults to 2 and honors STALE_RUN_REAP_HOURS", () => {
    expect(STALE_RUN_REAP_HOURS_DEFAULT).toBe(2);
    expect(staleRunReapHours()).toBe(2);
    process.env.STALE_RUN_REAP_HOURS = "4";
    expect(staleRunReapHours()).toBe(4);
    process.env.STALE_RUN_REAP_HOURS = "garbage";
    expect(staleRunReapHours()).toBe(2);
    process.env.STALE_RUN_REAP_HOURS = "-1";
    expect(staleRunReapHours()).toBe(2);
  });
});

describe("reapStaleRuns — blocked sweep", () => {
  it("blocked >2h whose blocker is terminal → failed with stale_reap error (CAS on status='blocked')", async () => {
    const { svc, traces } = makeSvc((t) => {
      if (isBlockedSweepSelect(t)) return { data: [blockedRow()], error: null };
      if (isBlockerStatusSelect(t))
        return { data: [{ id: "r0", status: "failed" }], error: null };
      if (isCasUpdate(t)) return { data: [{ id: "b1" }], error: null };
      return EMPTY;
    });
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.blocked_reaped).toBe(1);
    const cas = traces.find(isCasUpdate)!;
    expect(cas.update!.status).toBe("failed");
    expect(cas.update!.error).toBe("stale_reap: blocked >2h, blocker terminal");
    expect(cas.update!.needs_run_end_emit).toBe(true);
    expect(cas.update!.finished_at).toBe(new Date(NOW).toISOString());
    expect(cas.eq).toContainEqual(["id", "b1"]);
    expect(cas.eq).toContainEqual(["status", "blocked"]);
  });

  it("blocked >2h with a NULL blocked_by_run_id → reaped (nothing will ever unblock it)", async () => {
    const { svc, traces } = makeSvc((t) => {
      if (isBlockedSweepSelect(t))
        return { data: [blockedRow({ blocked_by_run_id: null })], error: null };
      if (isCasUpdate(t)) return { data: [{ id: "b1" }], error: null };
      return EMPTY;
    });
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.blocked_reaped).toBe(1);
    expect(traces.some(isBlockerStatusSelect)).toBe(false);
  });

  it("blocked >2h with a MISSING blocker row → reaped (blocker hard-deleted)", async () => {
    const { svc } = makeSvc((t) => {
      if (isBlockedSweepSelect(t)) return { data: [blockedRow()], error: null };
      if (isBlockerStatusSelect(t)) return { data: [], error: null };
      if (isCasUpdate(t)) return { data: [{ id: "b1" }], error: null };
      return EMPTY;
    });
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.blocked_reaped).toBe(1);
  });

  it("blocked >2h whose blocker is still LIVE (running) → untouched", async () => {
    const { svc, traces } = makeSvc((t) => {
      if (isBlockedSweepSelect(t)) return { data: [blockedRow()], error: null };
      if (isBlockerStatusSelect(t))
        return { data: [{ id: "r0", status: "running" }], error: null };
      return EMPTY;
    });
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.blocked_reaped).toBe(0);
    expect(traces.some(isCasUpdate)).toBe(false);
  });

  it("blocked 10min old is untouched — the sweep SELECT excludes rows newer than the cutoff (predicate pin)", async () => {
    const { svc, traces } = makeSvc(() => EMPTY);
    await reapStaleRuns(svc, undefined, NOW);
    const sel = traces.find(isBlockedSweepSelect)!;
    expect(sel.table).toBe("agent_runs");
    expect(sel.lt).toContainEqual(["enqueued_at", CUTOFF_2H]);
    expect(sel.is).toContainEqual(["batch_id", null]);
  });

  it("blocker-status read error → fail-safe: blocked sweep skipped (cannot tell live from dead), queued sweep still runs", async () => {
    const { svc, traces } = makeSvc((t) => {
      if (isBlockedSweepSelect(t)) return { data: [blockedRow()], error: null };
      if (isBlockerStatusSelect(t)) return { data: null, error: { message: "boom" } };
      if (isQueuedSweepSelect(t)) return { data: [queuedRow()], error: null };
      if (isCasUpdate(t)) return { data: [{ id: "q1" }], error: null };
      return EMPTY;
    });
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.blocked_reaped).toBe(0);
    expect(res.queued_reaped).toBe(1);
    const casUpdates = traces.filter(isCasUpdate);
    expect(casUpdates).toHaveLength(1);
    expect(casUpdates[0].eq).toContainEqual(["id", "q1"]);
  });
});

describe("reapStaleRuns — queued sweep", () => {
  it("queued >2h never claimed → failed with stale_reap error (CAS on status='queued')", async () => {
    const { svc, traces } = makeSvc((t) => {
      if (isQueuedSweepSelect(t)) return { data: [queuedRow()], error: null };
      if (isCasUpdate(t)) return { data: [{ id: "q1" }], error: null };
      return EMPTY;
    });
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.queued_reaped).toBe(1);
    const cas = traces.find(isCasUpdate)!;
    expect(cas.update!.status).toBe("failed");
    expect(cas.update!.error).toBe("stale_reap: queued >2h, never claimed");
    expect(cas.update!.needs_run_end_emit).toBe(true);
    expect(cas.eq).toContainEqual(["status", "queued"]);
  });

  it("queued recently is untouched — SELECT pins enqueued_at < cutoff AND started_at IS NULL (never claimed)", async () => {
    const { svc, traces } = makeSvc(() => EMPTY);
    await reapStaleRuns(svc, undefined, NOW);
    const sel = traces.find(isQueuedSweepSelect)!;
    expect(sel.lt).toContainEqual(["enqueued_at", CUTOFF_2H]);
    expect(sel.is).toContainEqual(["started_at", null]);
    expect(sel.is).toContainEqual(["batch_id", null]);
  });

  it("CAS loss (row claimed between select and update) → not counted", async () => {
    const { svc } = makeSvc((t) => {
      if (isQueuedSweepSelect(t)) return { data: [queuedRow()], error: null };
      if (isCasUpdate(t)) return { data: [], error: null };
      return EMPTY;
    });
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.queued_reaped).toBe(0);
  });
});

describe("reapStaleRuns — threshold env", () => {
  it("STALE_RUN_REAP_HOURS=4 moves the cutoff and the error message", async () => {
    process.env.STALE_RUN_REAP_HOURS = "4";
    const cutoff4h = new Date(NOW - 4 * 3600_000).toISOString();
    const { svc, traces } = makeSvc((t) => {
      if (isQueuedSweepSelect(t)) return { data: [queuedRow()], error: null };
      if (isCasUpdate(t)) return { data: [{ id: "q1" }], error: null };
      return EMPTY;
    });
    await reapStaleRuns(svc, undefined, NOW);
    const sel = traces.find(isQueuedSweepSelect)!;
    expect(sel.lt).toContainEqual(["enqueued_at", cutoff4h]);
    const cas = traces.find(isCasUpdate)!;
    expect(cas.update!.error).toBe("stale_reap: queued >4h, never claimed");
  });
});

describe("reapStaleRuns — idempotency", () => {
  it("second sweep no-ops (reaped rows are terminal, selects return nothing)", async () => {
    const { svc, traces, rpcCalls } = makeSvc(() => EMPTY);
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res).toEqual({
      blocked_reaped: 0,
      queued_reaped: 0,
      promoted: 0,
      conductor_provisioning_reaped: 0,
      conductor_active_reaped: 0,
    });
    expect(traces.some(isCasUpdate)).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("reapStaleRuns — thread successor promotion", () => {
  it("after reaping a blocked chat run with no in-flight run left on the thread, promotes the earliest remaining blocked successor and fires its event", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, rpcCalls } = makeSvc(
      (t) => {
        if (isBlockedSweepSelect(t)) return { data: [blockedRow()], error: null };
        if (isBlockerStatusSelect(t))
          return { data: [{ id: "r0", status: "failed" }], error: null };
        if (isInflightCheck(t)) return { data: [], error: null };
        if (isSlugFetch(t)) return { data: { agent_slug: "operator" }, error: null };
        if (isCasUpdate(t)) return { data: [{ id: "b1" }], error: null };
        return EMPTY;
      },
      { promote_next_blocked_run: { data: "b2", error: null } },
    );
    const res = await reapStaleRuns(svc, { send } as never, NOW);
    expect(res.blocked_reaped).toBe(1);
    expect(res.promoted).toBe(1);
    expect(rpcCalls).toEqual([
      {
        fn: "promote_next_blocked_run",
        args: { p_tenant_id: "t1", p_thread_id: "th1" },
      },
    ]);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].name).toBe("agent.run.requested");
    expect(send.mock.calls[0][0].data.run_id).toBe("b2");
  });

  it("promotion is SKIPPED when another run is still in-flight on the thread (serialization preserved)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, rpcCalls } = makeSvc((t) => {
      if (isBlockedSweepSelect(t)) return { data: [blockedRow()], error: null };
      if (isBlockerStatusSelect(t))
        return { data: [{ id: "r0", status: "failed" }], error: null };
      if (isInflightCheck(t)) return { data: [{ id: "other" }], error: null };
      if (isCasUpdate(t)) return { data: [{ id: "b1" }], error: null };
      return EMPTY;
    });
    const res = await reapStaleRuns(svc, { send } as never, NOW);
    expect(res.blocked_reaped).toBe(1);
    expect(res.promoted).toBe(0);
    expect(rpcCalls).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("non-thread runs (no payload.thread_id) skip promotion entirely", async () => {
    const { svc, rpcCalls } = makeSvc((t) => {
      if (isQueuedSweepSelect(t))
        return { data: [queuedRow({ payload: {} })], error: null };
      if (isCasUpdate(t)) return { data: [{ id: "q1" }], error: null };
      return EMPTY;
    });
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.queued_reaped).toBe(1);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("stale_reap composes with infra-retry (no retry loop)", () => {
  it("stale_reap failures are NOT infra-retryable — the watchdog Path 3 will never re-fire a reaped run", () => {
    expect(
      isInfraRetryable("failed", "stale_reap: blocked >2h, blocker terminal"),
    ).toBe(false);
    expect(
      isInfraRetryable("failed", "stale_reap: queued >2h, never claimed"),
    ).toBe(false);
    expect(
      willBeInfraRetried({
        id: "x",
        tenant_id: "t",
        agent_slug: "operator",
        status: "failed",
        error: "stale_reap: blocked >2h, blocker terminal",
        infra_retry_count: 0,
        last_progress_at: null,
      }),
    ).toBe(false);
  });
});

const PROV_CUTOFF_15 = new Date(NOW - 15 * 60_000).toISOString();
const ACTIVE_CUTOFF_45 = new Date(NOW - 45 * 60_000).toISOString();

const isConductorProvSelect = (t: Trace) =>
  t.table === "conductor_runs" &&
  t.update === null &&
  t.eq.some(([c, v]) => c === "status" && v === "provisioning");
const isConductorActiveSelect = (t: Trace) =>
  t.table === "conductor_runs" &&
  t.update === null &&
  t.eq.some(([c, v]) => c === "status" && v === "active");
const isDispatchHistorySelect = (t: Trace) => t.table === "dispatch_history";
const isLiveChildSelect = (t: Trace) =>
  t.table === "agent_runs" && t.select === "id" && t.in?.[0] === "status";

const CANCELLED_OK: Resp = {
  data: { ok: true, cancelled: true, prior_status: "active", stopped_children: 1 },
  error: null,
};
const CANCELLED_NOOP: Resp = {
  data: { ok: true, cancelled: false, prior_status: "failed" },
  error: null,
};

describe("conductor stale-slot thresholds (env)", () => {
  afterEach(() => {
    delete process.env.CONDUCTOR_PROVISION_STUCK_MIN;
    delete process.env.CONDUCTOR_ACTIVE_STUCK_MIN;
  });
  it("default 15 / 45 min, env-tunable, ignores garbage/negatives", () => {
    expect(CONDUCTOR_PROVISION_STUCK_MIN_DEFAULT).toBe(15);
    expect(CONDUCTOR_ACTIVE_STUCK_MIN_DEFAULT).toBe(45);
    expect(conductorProvisionStuckMinutes()).toBe(15);
    expect(conductorActiveStuckMinutes()).toBe(45);
    process.env.CONDUCTOR_PROVISION_STUCK_MIN = "30";
    process.env.CONDUCTOR_ACTIVE_STUCK_MIN = "90";
    expect(conductorProvisionStuckMinutes()).toBe(30);
    expect(conductorActiveStuckMinutes()).toBe(90);
    process.env.CONDUCTOR_PROVISION_STUCK_MIN = "junk";
    process.env.CONDUCTOR_ACTIVE_STUCK_MIN = "-5";
    expect(conductorProvisionStuckMinutes()).toBe(15);
    expect(conductorActiveStuckMinutes()).toBe(45);
  });
});

describe("reapStaleRuns — Sweep 3: conductor stale-slot reap", () => {
  afterEach(() => {
    delete process.env.CONDUCTOR_PROVISION_STUCK_MIN;
    delete process.env.CONDUCTOR_ACTIVE_STUCK_MIN;
  });

  it("provisioning stuck > 15min → reaped via cancel_conductor_run('stale_slot_reap') with the updated_at staleness guard", async () => {
    const { svc, traces, rpcCalls } = makeSvc(
      (t) => {
        if (isConductorProvSelect(t))
          return { data: [{ id: "c1", tenant_id: "t1" }], error: null };
        return EMPTY;
      },
      { cancel_conductor_run: CANCELLED_OK },
    );
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.conductor_provisioning_reaped).toBe(1);
    expect(res.conductor_active_reaped).toBe(0);
    const sel = traces.find(isConductorProvSelect)!;
    expect(sel.lt).toContainEqual(["updated_at", PROV_CUTOFF_15]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("cancel_conductor_run");
    expect(rpcCalls[0].args.p_tenant_id).toBe("t1");
    expect(rpcCalls[0].args.p_conductor_run_id).toBe("c1");
    expect(rpcCalls[0].args.p_reason).toBe("stale_slot_reap");
    expect(rpcCalls[0].args.p_require_updated_before).toBe(PROV_CUTOFF_15);
  });

  it("active stuck > 45min but WITH a live child → NOT reaped (no-live-child gate)", async () => {
    const { svc, rpcCalls } = makeSvc(
      (t) => {
        if (isConductorActiveSelect(t))
          return { data: [{ id: "c2", tenant_id: "t1" }], error: null };
        if (isDispatchHistorySelect(t))
          return { data: [{ target_run_id: "child1" }], error: null };
        if (isLiveChildSelect(t)) return { data: [{ id: "child1" }], error: null };
        return EMPTY;
      },
      { cancel_conductor_run: CANCELLED_OK },
    );
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.conductor_active_reaped).toBe(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it("active stuck > 45min with NO live child → reaped", async () => {
    const { svc, traces, rpcCalls } = makeSvc(
      (t) => {
        if (isConductorActiveSelect(t))
          return { data: [{ id: "c3", tenant_id: "t1" }], error: null };
        if (isDispatchHistorySelect(t))
          return { data: [{ target_run_id: "child9" }], error: null };
        if (isLiveChildSelect(t)) return { data: [], error: null };
        return EMPTY;
      },
      { cancel_conductor_run: { ...CANCELLED_OK }, },
    );
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.conductor_active_reaped).toBe(1);
    const sel = traces.find(isConductorActiveSelect)!;
    expect(sel.lt).toContainEqual(["updated_at", ACTIVE_CUTOFF_45]);
    expect(rpcCalls[0].args.p_require_updated_before).toBe(ACTIVE_CUTOFF_45);
    expect(rpcCalls[0].args.p_reason).toBe("stale_slot_reap");
  });

  it("active stuck with a live child known ONLY via goal_graph (dispatch_history empty) → NOT reaped", async () => {
    const { svc, rpcCalls } = makeSvc(
      (t) => {
        if (isConductorActiveSelect(t))
          return {
            data: [
              {
                id: "c2b",
                tenant_id: "t1",
                goal_graph: [{ child_run_id: "gchild1" }],
              },
            ],
            error: null,
          };
        if (isDispatchHistorySelect(t)) return { data: [], error: null };
        if (isLiveChildSelect(t)) return { data: [{ id: "gchild1" }], error: null };
        return EMPTY;
      },
      { cancel_conductor_run: CANCELLED_OK },
    );
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.conductor_active_reaped).toBe(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it("active stuck with a dispatch row but NO children rows at all → reaped (empty dispatch_history)", async () => {
    const { svc, rpcCalls } = makeSvc(
      (t) => {
        if (isConductorActiveSelect(t))
          return { data: [{ id: "c3b", tenant_id: "t1" }], error: null };
        if (isDispatchHistorySelect(t)) return { data: [], error: null };
        return EMPTY;
      },
      { cancel_conductor_run: CANCELLED_OK },
    );
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.conductor_active_reaped).toBe(1);
    expect(rpcCalls).toHaveLength(1);
  });

  it("RPC returns cancelled:false (lost CAS / build progressed past the guard) → NOT counted", async () => {
    const { svc } = makeSvc(
      (t) => {
        if (isConductorProvSelect(t))
          return { data: [{ id: "c4", tenant_id: "t1" }], error: null };
        return EMPTY;
      },
      { cancel_conductor_run: CANCELLED_NOOP },
    );
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.conductor_provisioning_reaped).toBe(0);
  });

  it("dispatch_history lookup error on the active sweep → fail-closed, build NOT reaped", async () => {
    const { svc, rpcCalls } = makeSvc(
      (t) => {
        if (isConductorActiveSelect(t))
          return { data: [{ id: "c5", tenant_id: "t1" }], error: null };
        if (isDispatchHistorySelect(t))
          return { data: null, error: { message: "boom" } };
        return EMPTY;
      },
      { cancel_conductor_run: CANCELLED_OK },
    );
    const res = await reapStaleRuns(svc, undefined, NOW);
    expect(res.conductor_active_reaped).toBe(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it("CONDUCTOR_PROVISION_STUCK_MIN env moves the provisioning cutoff", async () => {
    process.env.CONDUCTOR_PROVISION_STUCK_MIN = "30";
    const cutoff30 = new Date(NOW - 30 * 60_000).toISOString();
    const { svc, traces } = makeSvc(
      (t) => {
        if (isConductorProvSelect(t))
          return { data: [{ id: "c6", tenant_id: "t1" }], error: null };
        return EMPTY;
      },
      { cancel_conductor_run: CANCELLED_OK },
    );
    await reapStaleRuns(svc, undefined, NOW);
    const sel = traces.find(isConductorProvSelect)!;
    expect(sel.lt).toContainEqual(["updated_at", cutoff30]);
  });
});
