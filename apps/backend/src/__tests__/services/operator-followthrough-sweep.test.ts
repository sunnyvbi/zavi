import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient() must not be called when svc is injected");
  },
}));

const fleetHalted = vi.fn().mockResolvedValue(false);
vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: () => fleetHalted(),
}));

import {
  sweepOperatorFollowthrough,
  operatorFollowthroughSlaMinutes,
  composeInterimBody,
  composeFailedBody,
} from "@/services/agents/operator-followthrough-sweep";

const NOW = Date.parse("2026-06-11T12:00:00.000Z");
const THREAD = "11111111-1111-1111-1111-111111111111";
const TENANT = "22222222-2222-2222-2222-222222222222";

type Resp = { data: unknown; error: { message: string } | null };

interface Trace {
  table: string;
  op: "select" | "insert" | "update";
  payload: Record<string, unknown> | null;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  in: [string, unknown[]] | null;
}

function makeSvc(router: (t: Trace) => Resp) {
  const traces: Trace[] = [];
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  function from(table: string) {
    const trace: Trace = {
      table,
      op: "select",
      payload: null,
      eq: [],
      is: [],
      in: null,
    };
    traces.push(trace);
    const b: Record<string, unknown> = {
      select(_c: string) {
        trace.op = "select";
        return b;
      },
      insert(p: Record<string, unknown>) {
        trace.op = "insert";
        trace.payload = p;
        inserted.push({ table, row: p });
        return b;
      },
      update(p: Record<string, unknown>) {
        trace.op = "update";
        trace.payload = p;
        return b;
      },
      eq(c: string, v: unknown) {
        trace.eq.push([c, v]);
        return b;
      },
      is(c: string, v: unknown) {
        trace.is.push([c, v]);
        return b;
      },
      or(f: string) {
        trace.eq.push(["or", f]);
        return b;
      },
      in(c: string, v: unknown[]) {
        trace.in = [c, v];
        return b;
      },
      order() {
        return b;
      },
      limit() {
        return b;
      },
      maybeSingle() {
        return Promise.resolve(router(trace));
      },
      then(resolve: (r: Resp) => unknown) {
        return Promise.resolve(router(trace)).then(resolve);
      },
    };
    return b;
  }
  return { svc: { from } as never, traces, inserted };
}

function childRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-aaaa",
    tenant_id: TENANT,
    agent_slug: "engineer",
    status: "running",
    error: null,
    started_at: new Date(NOW - 14 * 60_000).toISOString(),
    infra_retry_count: 0,
    last_progress_at: null,
    payload: { operator_thread_id: THREAD },
    ...over,
  };
}

function buildRouter(opts: {
  candidates: Array<Record<string, unknown>>;
  messages?: Array<{ meta: unknown }>;
  threadExists?: boolean;
  selectError?: boolean;
  insertError?: string;
  freshStatus?: string;
}) {
  return (t: Trace): Resp => {
    if (t.table === "agent_runs") {
      if (opts.selectError) return { data: null, error: { message: "boom" } };
      const byId = t.eq.find(([c]) => c === "id")?.[1];
      if (byId !== undefined) {
        const c = opts.candidates.find((x) => x.id === byId);
        return { data: c ? { status: opts.freshStatus ?? c.status } : null, error: null };
      }
      return { data: opts.candidates, error: null };
    }
    if (t.table === "agent_thread_messages") {
      if (t.op === "insert") {
        return opts.insertError
          ? { data: null, error: { message: opts.insertError } }
          : { data: null, error: null };
      }
      return { data: opts.messages ?? [], error: null };
    }
    if (t.table === "agent_threads") {
      if (t.op === "update") return { data: null, error: null };
      return {
        data: opts.threadExists === false ? null : { id: THREAD },
        error: null,
      };
    }
    return { data: null, error: null };
  };
}

beforeEach(() => {
  fleetHalted.mockResolvedValue(false);
  delete process.env.OPERATOR_FOLLOWTHROUGH_SLA_MINUTES;
});

describe("operatorFollowthroughSlaMinutes", () => {
  it("defaults to 10, honors a valid env override, ignores garbage", () => {
    expect(operatorFollowthroughSlaMinutes()).toBe(10);
    process.env.OPERATOR_FOLLOWTHROUGH_SLA_MINUTES = "3";
    expect(operatorFollowthroughSlaMinutes()).toBe(3);
    process.env.OPERATOR_FOLLOWTHROUGH_SLA_MINUTES = "-1";
    expect(operatorFollowthroughSlaMinutes()).toBe(10);
    process.env.OPERATOR_FOLLOWTHROUGH_SLA_MINUTES = "nope";
    expect(operatorFollowthroughSlaMinutes()).toBe(10);
  });
});

describe("sweepOperatorFollowthrough", () => {
  it("(a) stuck non-terminal child past SLA → posts ONE interim status", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({ candidates: [childRow()], messages: [] }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.interim_posted).toBe(1);
    expect(res.failed_posted).toBe(0);
    expect(inserted).toHaveLength(1);
    const row = inserted[0].row;
    expect(row.thread_id).toBe(THREAD);
    expect(row.tenant_id).toBe(TENANT);
    expect(row.sender_role).toBe("assistant");
    expect(row.agent_run_id).toBeNull();
    const sweeper = (row.meta as { operator_sweeper?: { kind?: string; run_id?: string } }).operator_sweeper;
    expect(sweeper?.kind).toBe("interim");
    expect(sweeper?.run_id).toBe("run-aaaa");
    expect(String(row.body)).toContain("still running");
  });

  it("(a) non-terminal but BELOW SLA → no post", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({
        candidates: [
          childRow({ started_at: new Date(NOW - 4 * 60_000).toISOString() }),
        ],
        messages: [],
      }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.interim_posted).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("(a) idempotent — an existing interim post suppresses a second", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({
        candidates: [childRow()],
        messages: [{ meta: { operator_sweeper: { kind: "interim" } } }],
      }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.interim_posted).toBe(0);
    expect(res.skipped_dedupe).toBe(1);
    expect(inserted).toHaveLength(0);
  });

  it("(b) failed-terminal with NO result → posts a retry offer", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({
        candidates: [
          childRow({
            status: "failed",
            error: "stale_reap: queued >2h, never claimed",
          }),
        ],
        messages: [],
      }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.failed_posted).toBe(1);
    expect(res.interim_posted).toBe(0);
    expect(inserted).toHaveLength(1);
    expect((inserted[0].row.meta as { operator_sweeper?: { kind?: string } }).operator_sweeper?.kind).toBe(
      "failed",
    );
    expect(String(inserted[0].row.body)).toContain("retry");
  });

  it("terminal-success child with a posted result → no-op", async () => {
    const { svc, inserted } = makeSvc(buildRouter({ candidates: [], messages: [] }));
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.scanned).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("(b) failed but a real result already posted → no retry offer (dedupe)", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({
        candidates: [childRow({ status: "failed", error: "boom" })],
        messages: [{ meta: { from_agent_slug: "engineer", handoff: true } }],
      }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.failed_posted).toBe(0);
    expect(res.skipped_dedupe).toBe(1);
    expect(inserted).toHaveLength(0);
  });

  it("(b) interim-only post does NOT suppress the eventual retry offer", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({
        candidates: [childRow({ status: "failed", error: "boom" })],
        messages: [{ meta: { operator_sweeper: { kind: "interim" } } }],
      }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.failed_posted).toBe(1);
    expect(inserted).toHaveLength(1);
  });

  it("(b) infra-retryable failure (boot_reap, no progress, under cap) → skipped", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({
        candidates: [
          childRow({
            status: "failed",
            error: "boot_reap: orphaned on deploy",
            last_progress_at: null,
            infra_retry_count: 0,
          }),
        ],
        messages: [],
      }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.failed_posted).toBe(0);
    expect(res.skipped_infra_retry).toBe(1);
    expect(inserted).toHaveLength(0);
  });

  it("fleet-halt → no-op", async () => {
    fleetHalted.mockResolvedValue(true);
    const { svc, inserted } = makeSvc(buildRouter({ candidates: [childRow()] }));
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.halted).toBe(true);
    expect(res.interim_posted).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("tenant scoping — post is bound to the run's tenant + operator thread", async () => {
    const seenEq: Array<[string, unknown]> = [];
    const { svc } = makeSvc((t: Trace): Resp => {
      if (t.table === "agent_runs") {
        if (t.eq.some(([c]) => c === "id")) return { data: { status: "running" }, error: null };
        return { data: [childRow()], error: null };
      }
      if (t.table === "agent_thread_messages") {
        if (t.op === "select") return { data: [], error: null };
        return { data: null, error: null };
      }
      if (t.table === "agent_threads") {
        if (t.op === "select") {
          seenEq.push(...t.eq);
          return { data: { id: THREAD }, error: null };
        }
        return { data: null, error: null };
      }
      return { data: null, error: null };
    });
    await sweepOperatorFollowthrough(svc, NOW);
    expect(seenEq).toContainEqual(["tenant_id", TENANT]);
    expect(seenEq).toContainEqual(["agent_slug", "operator"]);
    expect(seenEq).toContainEqual(["id", THREAD]);
  });

  it("missing operator thread → counted, no post, no crash", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({ candidates: [childRow()], messages: [], threadExists: false }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.interim_posted).toBe(0);
    expect(res.errors).toBe(1);
    expect(inserted).toHaveLength(0);
  });

  it("child with no operator_thread_id (slack/email route) → ignored", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({
        candidates: [childRow({ payload: { slack: { channel: "C1" } } })],
      }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.scanned).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("parallel-batch child (handoff_batch_id set) → ignored (batch-join owns it)", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({
        candidates: [
          childRow({
            payload: { operator_thread_id: THREAD, handoff_batch_id: "batch-1" },
          }),
        ],
      }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.scanned).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("never-started (started_at null) non-terminal → no interim (reaper owns it)", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({
        candidates: [childRow({ status: "queued", started_at: null })],
        messages: [],
      }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.interim_posted).toBe(0);
    expect(inserted).toHaveLength(0);
  });
});

describe("body composers", () => {
  it("no interim when the run finished between the batch read and the post", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({ candidates: [childRow()], messages: [], freshStatus: "success" }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.interim_posted).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("the failure line never takes the run's slot, so the runner's own terminal reply still lands", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({ candidates: [childRow({ status: "failed", last_progress_at: new Date(NOW).toISOString() })], messages: [] }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.failed_posted).toBe(1);
    expect(inserted[0].row.agent_run_id).toBeNull();
    expect((inserted[0].row.meta as { operator_sweeper: { run_id: string } }).operator_sweeper.run_id).toBe("run-aaaa");
  });

  it("a run that failed moments ago gets time for its own reply before the sweep speaks", async () => {
    const { svc, inserted } = makeSvc(
      buildRouter({
        candidates: [childRow({ status: "failed", last_progress_at: new Date(NOW).toISOString(), finished_at: new Date(NOW - 30_000).toISOString() })],
        messages: [],
      }),
    );
    const res = await sweepOperatorFollowthrough(svc, NOW);
    expect(res.failed_posted).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("dedupe reads the run's own reply AND sweeper lines that name it in meta", async () => {
    const { svc, traces } = makeSvc(buildRouter({ candidates: [childRow()], messages: [] }));
    await sweepOperatorFollowthrough(svc, NOW);
    const msgQuery = traces.find((t) => t.table === "agent_thread_messages" && t.op === "select");
    const orFilter = msgQuery?.eq.find(([c]) => c === "or")?.[1];
    expect(orFilter).toBe("agent_run_id.eq.run-aaaa,meta->operator_sweeper->>run_id.eq.run-aaaa");
  });

  it("interim mentions the agent + minutes", () => {
    expect(composeInterimBody("engineer", 14)).toContain("@engineer");
    expect(composeInterimBody("engineer", 14)).toContain("14 min");
    expect(composeInterimBody("engineer", 0)).toContain("under a minute");
  });
  it("failed offers a retry", () => {
    expect(composeFailedBody("research")).toContain("@research");
    expect(composeFailedBody("research").toLowerCase()).toContain("retry");
  });
});
