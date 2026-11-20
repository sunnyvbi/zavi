import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn(async () => {}) }));
vi.mock("@/services/team-notes/emit-run-end", () => ({ emitTeamNoteRunEnd: emitMock }));
vi.mock("@/services/agents/thread-event", () => ({ emitThreadEvent: vi.fn(async () => {}) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient() must not be called when svc is injected");
  },
}));

import { reapOrphanedRunsOnBoot } from "../boot-reap";
import { reapStaleRuns } from "../stale-run-reaper";

type EmitArgs = Record<string, unknown>;
const emitted = () => emitMock.mock.calls.map((c) => (c as unknown[])[0] as EmitArgs);

beforeEach(() => emitMock.mockClear());

describe("persistTerminal: team-note emit wiring", () => {
  const runner = readFileSync(join(__dirname, "../runner.ts"), "utf8");
  const casLossReturn = runner.indexOf("CAS-lost safety-net run_end emit failed");
  const emitAt = runner.indexOf("await emitTeamNoteRunEnd({");
  const trackAt = runner.indexOf('track("agent_run_finished"');

  it("the CAS write returns the columns the emit needs", () => {
    expect(runner).toMatch(
      /\.eq\("status", "running"\)\s*\.select\("id, payload, cost_usd, tenant_id, trigger, infra_retry_count, last_progress_at"\);/,
    );
  });

  it("emits only after the CAS-loss return (a loser never emits) and before any other post-win work", () => {
    expect(casLossReturn).toBeGreaterThan(0);
    expect(emitAt).toBeGreaterThan(casLossReturn);
    expect(trackAt).toBeGreaterThan(emitAt);
    const between = runner.slice(casLossReturn, emitAt);
    expect(between.match(/\bawait\b/g) ?? []).toHaveLength(0);
    expect(runner.match(/await emitTeamNoteRunEnd\(/g) ?? []).toHaveLength(1);
  });

  it("is isolated in its own try/catch so an emit failure cannot break the terminal path", () => {
    const block = runner.slice(runner.lastIndexOf("try {", emitAt), trackAt);
    expect(block).toMatch(/\} catch \(e\) \{\s*console\.warn\(\s*`\[persistTerminal\] team-note emit failed/);
  });

  it("uses the persisted terminal status/error and the same retry predicate as the failure bubble", () => {
    const call = runner.slice(emitAt, trackAt);
    expect(call).toMatch(/status: typeof update\.status === "string" \? update\.status : "dispatch_error"/);
    expect(call).toMatch(/error: typeof update\.error === "string" \? update\.error : null/);
    expect(call).toMatch(/paused: pausedForApproval/);
    expect(call).toMatch(
      /willRetry:\s*!result &&\s*willBeInfraRetried\(\{[\s\S]*?status: \(update\.status as string \| undefined\) \?\? "dispatch_error",\s*error: error \?\? null,/,
    );
    expect(runner).toMatch(
      /!willBeInfraRetried\(\{[\s\S]{0,120}status: \(update\.status as string \| undefined\) \?\? "dispatch_error",\s*error: error \?\? null,/,
    );
  });
});

type Orphan = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  error: string | null;
  infra_retry_count: number;
  last_progress_at: string | null;
  trigger: string | null;
  payload: unknown;
};

function bootSvc(orphans: Orphan[], reaped: Orphan[] = orphans) {
  function builder(table: string) {
    const state: { update?: Record<string, unknown> } = {};
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "or", "lt", "in", "gte", "lte", "limit"]) b[m] = () => b;
    b.update = (u: Record<string, unknown>) => {
      state.update = u;
      return b;
    };
    b.maybeSingle = async () => ({ data: null, error: null });
    (b as { then: unknown }).then = (resolve: (v: { data?: unknown; error: null }) => void) => {
      if (table === "agent_runs" && state.update && "status" in state.update) {
        return resolve({
          data: reaped.map((o) => ({
            id: o.id, tenant_id: o.tenant_id, agent_slug: o.agent_slug, payload: o.payload, trigger: o.trigger,
          })),
          error: null,
        });
      }
      if (table === "agent_runs" && state.update) return resolve({ error: null });
      return resolve({ data: orphans, error: null });
    };
    return b;
  }
  return { from: (t: string) => builder(t), rpc: async () => ({ error: null }) } as never;
}

const orphan = (over: Partial<Orphan>): Orphan => ({
  id: "run-x",
  tenant_id: "tenant-1",
  agent_slug: "operator",
  status: "running",
  error: null,
  infra_retry_count: 0,
  last_progress_at: "2026-06-10T23:59:00.000Z",
  trigger: "chat",
  payload: { thread_id: "thread-1" },
  ...over,
});

describe("boot-reap: team-note emit", () => {
  it("emits run_failed for a reaped chat run, not for one the infra retry will re-fire", async () => {
    const done = orphan({ id: "run-done" });
    const retried = orphan({ id: "run-retried", last_progress_at: null });
    await reapOrphanedRunsOnBoot("2026-06-11T00:00:00.000Z", bootSvc([done, retried]));
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitted()[0]).toMatchObject({
      runId: "run-done",
      tenantId: "tenant-1",
      agentSlug: "operator",
      trigger: "chat",
      status: "failed",
      willRetry: false,
      paused: false,
    });
    expect(String(emitted()[0].error)).toMatch(/^boot_reap/);
  });

  it("never emits for a slack run or a row this writer did not reap", async () => {
    const slack = orphan({ id: "run-slack", trigger: "slack" });
    const lost = orphan({ id: "run-lost" });
    await reapOrphanedRunsOnBoot("2026-06-11T00:00:00.000Z", bootSvc([slack, lost], [slack]));
    expect(emitMock).not.toHaveBeenCalled();
  });
});

type Resp = { data: unknown; error: { message: string } | null };
type Trace = { update: Record<string, unknown> | null; eq: Array<[string, unknown]>; in: unknown };

function staleSvc(router: (t: Trace) => Resp) {
  function from() {
    const trace: Trace = { update: null, eq: [], in: null };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Record<string, unknown>) => {
        trace.update = p;
        return b;
      },
      eq: (c: string, v: unknown) => {
        trace.eq.push([c, v]);
        return b;
      },
      lt: () => b,
      or: () => b,
      is: () => b,
      in: (c: string, v: unknown[]) => {
        trace.in = [c, v];
        return b;
      },
      filter: () => b,
      limit: () => b,
      single: () => b,
      maybeSingle: () => b,
      then: (resolve: (r: Resp) => void) => resolve(router(trace)),
    };
    return b;
  }
  return { from, rpc: vi.fn(async () => ({ data: null, error: null })) } as never;
}

const isQueuedSelect = (t: Trace) => t.update === null && t.eq.some(([c, v]) => c === "status" && v === "queued") && t.in === null;
const casFor = (t: Trace) => (t.update ? (t.eq.find(([c]) => c === "id")?.[1] as string) : null);

describe("stale-run-reaper: team-note emit", () => {
  it("emits for a CAS-won chat row; skips a CAS-lost row", async () => {
    const rows = [
      { id: "q-won", tenant_id: "t1", agent_slug: "operator", payload: { thread_id: "th1" }, trigger: "chat" },
      { id: "q-lost", tenant_id: "t1", agent_slug: "operator", payload: { thread_id: "th2" }, trigger: "chat" },
    ];
    const svc = staleSvc((t) => {
      if (isQueuedSelect(t)) return { data: rows, error: null };
      const id = casFor(t);
      if (id === "q-won") return { data: [{ id }], error: null };
      if (id === "q-lost") return { data: [], error: null };
      return { data: [], error: null };
    });
    await reapStaleRuns(svc, undefined, Date.parse("2026-06-10T12:00:00.000Z"));
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitted()[0]).toMatchObject({
      runId: "q-won",
      tenantId: "t1",
      trigger: "chat",
      status: "failed",
      error: "stale_reap",
      willRetry: false,
    });
  });

  it("passes the row's own trigger, so a non-chat reaped run is filtered by the hook", async () => {
    const svc = staleSvc((t) => {
      if (isQueuedSelect(t)) {
        return { data: [{ id: "q-cron", tenant_id: "t1", agent_slug: "pm", payload: {}, trigger: "cron" }], error: null };
      }
      if (casFor(t) === "q-cron") return { data: [{ id: "q-cron" }], error: null };
      return { data: [], error: null };
    });
    await reapStaleRuns(svc, undefined, Date.parse("2026-06-10T12:00:00.000Z"));
    expect(emitted()[0]).toMatchObject({ runId: "q-cron", trigger: "cron" });
  });
});
