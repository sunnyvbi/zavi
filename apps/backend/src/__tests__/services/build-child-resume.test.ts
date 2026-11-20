import { describe, it, expect, vi } from "vitest";

import {
  tryBuildChildResume,
  BOOT_REQUEUE_SETTLE_MS,
  type InfraRetryRow,
} from "@/services/agents/infra-retry";

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient() must not be called when svc is injected");
  },
}));
import { reapOrphanedRunsOnBoot } from "@/services/agents/boot-reap";

type Resp = { data: unknown; error: { message: string } | null };

function makeSvc(responses: {
  dispatch_history?: Resp;
  conductor_runs?: Resp;
  decisions?: Resp;
  cas?: Resp;
  orphans?: Resp;
  terminalize?: Resp;
  parked?: Resp;
}) {
  const calls: Array<Record<string, unknown>> = [];
  function from(table: string) {
    const trace: Record<string, unknown> = {
      table,
      eq: [] as Array<[string, unknown]>,
      update: null as Record<string, unknown> | null,
      select: null as string | null,
      in: null as null | [string, unknown[]],
      single: false,
    };
    calls.push(trace);
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
        (trace.eq as Array<[string, unknown]>).push([c, v]);
        return b;
      },
      neq(c: string, v: unknown) {
        (trace.eq as Array<[string, unknown]>).push([`neq:${c}`, v]);
        return b;
      },
      or() {
        return b;
      },
      lt() {
        return b;
      },
      gte() {
        return b;
      },
      lte() {
        return b;
      },
      in(c: string, v: unknown[]) {
        trace.in = [c, v];
        return b;
      },
      limit() {
        return b;
      },
      single() {
        trace.single = true;
        return Promise.resolve(responses.conductor_runs ?? { data: null, error: null });
      },
      then(resolve: (r: Resp) => void) {
        let r: Resp;
        const eqs = trace.eq as Array<[string, unknown]>;
        if (table === "agent_runs" && trace.update && trace.in) r = responses.terminalize ?? { data: [], error: null };
        else if (table === "agent_runs" && trace.update) r = responses.cas ?? { data: [], error: null };
        else if (table === "agent_runs" && eqs.some(([c, v]) => c === "status" && v === "queued"))
          r = responses.parked ?? { data: [], error: null };
        else if (table === "agent_runs") r = responses.orphans ?? { data: [], error: null };
        else if (table === "dispatch_history") r = responses.dispatch_history ?? { data: [], error: null };
        else if (table === "decisions") r = responses.decisions ?? { data: [], error: null };
        else r = { data: [], error: null };
        resolve(r);
      },
    };
    return b;
  }
  return { svc: { from } as never, calls };
}

const CONDUCTOR_ID = "cond-1";

const buildChild = (over: Partial<InfraRetryRow> = {}): InfraRetryRow => ({
  id: "child-1",
  tenant_id: "t1",
  agent_slug: "engineer",
  status: "running",
  error: null,
  infra_retry_count: 0,
  last_progress_at: "2026-06-09T05:52:00.000Z",
  trigger: "a2a",
  ...over,
});

const happyResponses = (): {
  dispatch_history: Resp;
  conductor_runs: Resp;
  decisions: Resp;
  cas: Resp;
} => ({
  dispatch_history: { data: [{ source_run_id: CONDUCTOR_ID }], error: null },
  conductor_runs: {
    data: {
      kind: "build_app",
      goal_graph: [
        { id: "n-scaffold", status: "done", child_run_id: "x" },
        { id: "n-build", status: "dispatched", child_run_id: "child-1" },
      ],
    },
    error: null,
  },
  decisions: { data: [], error: null },
  cas: { data: [{ id: "child-1" }], error: null },
});

describe("tryBuildChildResume", () => {
  it("resumes a progressed build_app conductor child (parks same run_id, no terminalize; dispatch deferred to boot-reap's settle timer)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, calls } = makeSvc(happyResponses());
    const ok = await tryBuildChildResume(svc, { send } as never, buildChild());
    expect(ok).toBe(true);
    const cas = calls.find((c) => c.table === "agent_runs" && c.update) as Record<string, unknown>;
    expect((cas.update as Record<string, unknown>).status).toBe("queued");
    expect((cas.update as Record<string, unknown>).infra_retry_count).toBe(1);
    expect(cas.eq).toContainEqual(["status", "running"]);
    expect(cas.eq).toContainEqual(["infra_retry_count", 0]);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES when a decision was already emitted (dup ship-pr / push guard)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = happyResponses();
    r.decisions = { data: [{ id: "dec-1" }], error: null };
    const { svc } = makeSvc(r);
    const ok = await tryBuildChildResume(svc, { send } as never, buildChild());
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES a non-a2a (standalone chat/slack engineer) run", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, calls } = makeSvc(happyResponses());
    const ok = await tryBuildChildResume(svc, { send } as never, buildChild({ trigger: "chat" }));
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES when the parent conductor is not build_app", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = happyResponses();
    r.conductor_runs = {
      data: { kind: "company_goal", goal_graph: [] },
      error: null,
    };
    const { svc } = makeSvc(r);
    const ok = await tryBuildChildResume(svc, { send } as never, buildChild());
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES when no dispatched node is bound to this child (stale/superseded sibling)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = happyResponses();
    r.conductor_runs = {
      data: {
        kind: "build_app",
        goal_graph: [{ id: "n-build", status: "dispatched", child_run_id: "someone-else" }],
      },
      error: null,
    };
    const { svc } = makeSvc(r);
    const ok = await tryBuildChildResume(svc, { send } as never, buildChild());
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES when dispatch_history has no conductor source (not a conductor child)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = happyResponses();
    r.dispatch_history = { data: [], error: null };
    const { svc } = makeSvc(r);
    const ok = await tryBuildChildResume(svc, { send } as never, buildChild());
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES at the infra-retry cap (poison-loop bound)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, calls } = makeSvc(happyResponses());
    const ok = await tryBuildChildResume(svc, { send } as never, buildChild({ infra_retry_count: 3 }));
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("fails CLOSED (no re-fire) when the decisions read errors", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = happyResponses();
    r.decisions = { data: null, error: { message: "boom" } };
    const { svc } = makeSvc(r);
    const ok = await tryBuildChildResume(svc, { send } as never, buildChild());
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("reapOrphanedRunsOnBoot — build-child resume integration", () => {
  const BOOT = "2026-06-09T06:00:00.000Z";

  it("re-queues a progressed build_app conductor child instead of terminalizing it (dispatch after the settle window)", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn().mockResolvedValue(undefined);
      const { svc, calls } = makeSvc({
        orphans: { data: [buildChild({ id: "child-1" })], error: null },
        parked: {
          data: [
            { id: "child-1", tenant_id: "t1", agent_slug: "engineer", infra_retry_count: 1 },
          ],
          error: null,
        },
        ...happyResponses(),
      });
      const { reaped, requeued } = await reapOrphanedRunsOnBoot(BOOT, svc, { send } as never);
      expect(requeued).toBe(1);
      expect(reaped).toBe(0);
      const term = calls.find((c) => c.table === "agent_runs" && c.update && c.in);
      expect(term).toBeUndefined();
      expect(send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(BOOT_REQUEUE_SETTLE_MS);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][0].data.run_id).toBe("child-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still terminalizes a progressed build-child that already emitted a decision", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = happyResponses();
    r.decisions = { data: [{ id: "dec-1" }], error: null };
    const { svc, calls } = makeSvc({
      orphans: { data: [buildChild({ id: "child-1" })], error: null },
      terminalize: { data: [{ id: "child-1" }], error: null },
      ...r,
    });
    const { reaped, requeued } = await reapOrphanedRunsOnBoot(BOOT, svc, { send } as never);
    expect(requeued).toBe(0);
    expect(reaped).toBe(1);
    const term = calls.find((c) => c.table === "agent_runs" && c.update && c.in) as Record<string, unknown>;
    expect((term.update as Record<string, unknown>).status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });
});
