import { describe, it, expect, vi } from "vitest";
import {
  emitNeedsActionDecisions,
  performNeedsAction,
  parsePrUrl,
  PM_NEEDS_ACTION_CLASS,
  type NeedsActionDecision,
} from "../needs-action";
import type { AgentContext } from "@/services/agents/types";

type Result = { data: unknown; error: unknown };
type Op = [string, unknown[]];

function makeSvc(cfg: {
  route: (table: string, ops: Op[]) => Result;
  rpc?: (fn: string, args: Record<string, unknown>) => Result;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const svc = {
    from(table: string) {
      const ops: Op[] = [];
      const builder: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              const res = cfg.route(table, ops);
              return (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
                Promise.resolve(res).then(onF, onR);
            }
            if (prop === "maybeSingle") {
              return async () => cfg.route(table, ops);
            }
            return (...args: unknown[]) => {
              ops.push([prop, args]);
              return builder;
            };
          },
        },
      );
      return builder;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      const res = cfg.rpc ? cfg.rpc(fn, args) : { data: "dec-new", error: null };
      return Promise.resolve(res);
    },
    __rpcCalls: rpcCalls,
  };
  return svc as unknown as {
    from: (t: string) => unknown;
    rpc: (fn: string, args: Record<string, unknown>) => Promise<Result>;
    __rpcCalls: typeof rpcCalls;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asSvc = (m: unknown) => m as any;

const ctx = { tenant_id: "tenant-A", runId: "pm-run-1" } as unknown as AgentContext;

function hasRoadmapIdEq(ops: Op[]): boolean {
  return ops.some((o) => o[0] === "eq" && o[1][0] === "body->>roadmap_id");
}

describe("emitNeedsActionDecisions — flag gate + idempotency + classification", () => {
  it("flag OFF → emits nothing (no roadmap read, no emit_decision)", async () => {
    let roadmapRead = false;
    const svc = makeSvc({
      route: (table) => {
        if (table === "pm_roadmap") roadmapRead = true;
        return { data: [], error: null };
      },
    });
    const out = await emitNeedsActionDecisions(ctx, {
      svc: asSvc(svc),
      isEnabled: async () => false,
    });
    expect(out).toEqual({ emitted: 0, skipped: 0 });
    expect(roadmapRead).toBe(false);
    expect(svc.__rpcCalls).toHaveLength(0);
  });

  for (const trigger of ["slack", "chat", "email", "teams"] as const) {
    it(`trigger='${trigger}' (conversational) → no sweep, even with the flag ON`, async () => {
      let roadmapRead = false;
      const svc = makeSvc({
        route: (table) => {
          if (table === "pm_roadmap") roadmapRead = true;
          return { data: [], error: null };
        },
      });
      const out = await emitNeedsActionDecisions(
        { ...ctx, trigger } as unknown as AgentContext,
        { svc: asSvc(svc), isEnabled: async () => true },
      );
      expect(out).toEqual({ emitted: 0, skipped: 0 });
      expect(roadmapRead).toBe(false);
      expect(svc.__rpcCalls).toHaveLength(0);
    });
  }

  it("trigger='cron' (scheduled) → still sweeps and emits", async () => {
    const svc = makeSvc({
      route: (table, ops) => {
        if (table === "pm_roadmap")
          return {
            data: [
              {
                id: "rm-1",
                theme: "checkout 500s",
                status: "proposed",
                outcome: "recurred",
                child_run_id: "eng-1",
                last_dispatched_at: null,
              },
            ],
            error: null,
          };
        if (table === "decisions" && hasRoadmapIdEq(ops)) return { data: null, error: null };
        return { data: [], error: null };
      },
    });
    const out = await emitNeedsActionDecisions(
      { ...ctx, trigger: "cron" } as unknown as AgentContext,
      { svc: asSvc(svc), isEnabled: async () => true },
    );
    expect(out).toEqual({ emitted: 1, skipped: 0 });
    expect(svc.__rpcCalls[0].fn).toBe("emit_decision");
  });

  it("flag read THROWS → fail-closed, emits nothing", async () => {
    const svc = makeSvc({ route: () => ({ data: [], error: null }) });
    const out = await emitNeedsActionDecisions(ctx, {
      svc: asSvc(svc),
      isEnabled: async () => {
        throw new Error("system_config down");
      },
    });
    expect(out).toEqual({ emitted: 0, skipped: 0 });
    expect(svc.__rpcCalls).toHaveLength(0);
  });

  it("recurred theme → emits ONE pm.needs_action decision", async () => {
    const svc = makeSvc({
      route: (table, ops) => {
        if (table === "pm_roadmap")
          return {
            data: [
              {
                id: "rm-1",
                theme: "checkout 500s",
                status: "proposed",
                outcome: "recurred",
                child_run_id: "eng-1",
                last_dispatched_at: null,
              },
            ],
            error: null,
          };
        if (table === "decisions" && hasRoadmapIdEq(ops)) return { data: null, error: null };
        return { data: [], error: null };
      },
    });
    const out = await emitNeedsActionDecisions(ctx, { svc: asSvc(svc), isEnabled: async () => true });
    expect(out).toEqual({ emitted: 1, skipped: 0 });
    expect(svc.__rpcCalls).toHaveLength(1);
    const call = svc.__rpcCalls[0];
    expect(call.fn).toBe("emit_decision");
    expect(call.args.p_decision_class).toBe(PM_NEEDS_ACTION_CLASS);
    expect(call.args.p_tenant_id).toBe("tenant-A");
    const body = call.args.p_body as Record<string, unknown>;
    expect(body.exception_kind).toBe("recurred");
    expect(body.roadmap_id).toBe("rm-1");
    expect(body.proposed_action).toBe("redispatch_and_close_pr");
    expect(typeof body.rendered_markdown).toBe("string");
    expect(body.rendered_markdown as string).toContain("checkout 500s");
    expect(body.rendered_markdown as string).toContain("On approve:");
    expect(body.pr_url ?? null).toBeNull();
    expect(body.rendered_markdown as string).toContain("re-dispatch the engineer to retry.");
    expect(body.rendered_markdown as string).not.toContain("close the stale PR");
  });

  it("IDEMPOTENT — an open pm.needs_action already exists for the roadmap → skip, no emit", async () => {
    const svc = makeSvc({
      route: (table, ops) => {
        if (table === "pm_roadmap")
          return {
            data: [{ id: "rm-1", theme: "payment refund recurred", status: "proposed", outcome: "recurred", child_run_id: null, last_dispatched_at: null }],
            error: null,
          };
        if (table === "decisions" && hasRoadmapIdEq(ops)) return { data: { id: "dec-existing" }, error: null };
        if (table === "decisions") return { data: null, error: null };
        return { data: [], error: null };
      },
    });
    const out = await emitNeedsActionDecisions(ctx, { svc: asSvc(svc), isEnabled: async () => true });
    expect(out).toEqual({ emitted: 0, skipped: 1 });
    expect(svc.__rpcCalls).toHaveLength(0);
  });

  it("failed_to_open child → emits with exception_kind=failed_to_open + pr fields", async () => {
    const svc = makeSvc({
      route: (table, ops) => {
        if (table === "pm_roadmap")
          return {
            data: [{ id: "rm-2", theme: "signup auth bug", status: "in_flight", outcome: null, child_run_id: "eng-2", last_dispatched_at: new Date().toISOString() }],
            error: null,
          };
        if (table === "agent_runs")
          return { data: [{ id: "eng-2", status: "success", finished_at: new Date().toISOString(), parsed: { pr_state: "failed_to_open", pr_url: null } }], error: null };
        if (table === "decisions" && hasRoadmapIdEq(ops)) return { data: null, error: null };
        if (table === "decisions") return { data: null, error: null };
        return { data: [], error: null };
      },
    });
    const out = await emitNeedsActionDecisions(ctx, { svc: asSvc(svc), isEnabled: async () => true });
    expect(out).toEqual({ emitted: 1, skipped: 0 });
    const body = svc.__rpcCalls[0].args.p_body as Record<string, unknown>;
    expect(body.exception_kind).toBe("failed_to_open");
    expect(body.severity).toBe("high");
    expect(body.proposed_action).toBe("redispatch_and_close_pr");
  });

  it("infra-died child with a SPURIOUS failed_to_open stamp → coalesced dispatch_died card (not a false PR-open failure)", async () => {
    const svc = makeSvc({
      route: (table, ops) => {
        if (table === "pm_roadmap")
          return {
            data: [{ id: "rm-2b", theme: "reaped fix", status: "in_flight", outcome: null, child_run_id: "eng-2b", last_dispatched_at: new Date().toISOString() }],
            error: null,
          };
        if (table === "agent_runs")
          return {
            data: [{ id: "eng-2b", status: "failed", error: "boot_reap: orphaned by container restart (worker died mid-run)", finished_at: new Date().toISOString(), parsed: { pr_state: "failed_to_open", pr_url: null } }],
            error: null,
          };
        if (table === "decisions") return { data: null, error: null };
        return { data: [], error: null };
      },
    });
    const out = await emitNeedsActionDecisions(ctx, { svc: asSvc(svc), isEnabled: async () => true });
    expect(out).toEqual({ emitted: 1, skipped: 0 });
    const body = svc.__rpcCalls[0].args.p_body as Record<string, unknown>;
    expect(body.exception_kind).toBe("dispatch_died");
    expect(body.coalesced).toBe(true);
    expect(body.proposed_action).toBe("none");
    expect(body.affected_themes).toContain("reaped fix");
  });

  it("usage-limit death (status success but hit-limit error) → coalesced dispatch_died card", async () => {
    const svc = makeSvc({
      route: (table, ops) => {
        if (table === "pm_roadmap")
          return { data: [{ id: "rm-2c", theme: "quota fix", status: "in_flight", outcome: null, child_run_id: "eng-2c", last_dispatched_at: new Date().toISOString() }], error: null };
        if (table === "agent_runs")
          return { data: [{ id: "eng-2c", status: "failed", error: "dispatch_inner: Claude Code returned an error result: You've hit your limit · resets 4:40am (UTC)", finished_at: new Date().toISOString(), parsed: { pr_state: "failed_to_open", pr_url: null } }], error: null };
        if (table === "decisions") return { data: null, error: null };
        return { data: [], error: null };
      },
    });
    const out = await emitNeedsActionDecisions(ctx, { svc: asSvc(svc), isEnabled: async () => true });
    expect(out).toEqual({ emitted: 1, skipped: 0 });
    const body = svc.__rpcCalls[0].args.p_body as Record<string, unknown>;
    expect(body.exception_kind).toBe("dispatch_died");
    expect(body.coalesced).toBe(true);
    expect(body.affected_themes).toContain("quota fix");
  });

  it("in_flight PR stuck > STUCK_DAYS (high-severity) → emits individual exception_kind=stuck card", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const svc = makeSvc({
      route: (table, ops) => {
        if (table === "pm_roadmap")
          return { data: [{ id: "rm-3", theme: "payment webhook slow query", status: "in_flight", outcome: null, child_run_id: "eng-3", last_dispatched_at: eightDaysAgo }], error: null };
        if (table === "agent_runs")
          return { data: [{ id: "eng-3", status: "success", finished_at: eightDaysAgo, parsed: { pr_url: "https://github.com/acme/repo/pull/9", pr_state: null } }], error: null };
        if (table === "decisions" && hasRoadmapIdEq(ops)) return { data: null, error: null };
        if (table === "decisions") return { data: null, error: null };
        return { data: [], error: null };
      },
    });
    const out = await emitNeedsActionDecisions(ctx, { svc: asSvc(svc), isEnabled: async () => true });
    expect(out).toEqual({ emitted: 1, skipped: 0 });
    const body = svc.__rpcCalls[0].args.p_body as Record<string, unknown>;
    expect(body.exception_kind).toBe("stuck");
    expect(body.severity).toBe("high");
    expect(body.pr_url).toBe("https://github.com/acme/repo/pull/9");
  });

  it("NORMAL-severity stuck theme → coalesced into the stuck rollup, NOT an individual card", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const svc = makeSvc({
      route: (table, ops) => {
        if (table === "pm_roadmap")
          return { data: [{ id: "rm-3n", theme: "DL barcode parsing missing from DriverVerification.tsx", status: "in_flight", outcome: null, child_run_id: "eng-3n", last_dispatched_at: eightDaysAgo }], error: null };
        if (table === "agent_runs")
          return { data: [{ id: "eng-3n", status: "success", finished_at: eightDaysAgo, parsed: { pr_url: "https://github.com/acme/repo/pull/9", pr_state: null } }], error: null };
        if (table === "decisions") return { data: null, error: null };
        return { data: [], error: null };
      },
    });
    const out = await emitNeedsActionDecisions(ctx, { svc: asSvc(svc), isEnabled: async () => true });
    expect(out).toEqual({ emitted: 1, skipped: 0 });
    expect(svc.__rpcCalls).toHaveLength(1);
    const body = svc.__rpcCalls[0].args.p_body as Record<string, unknown>;
    expect(body.stuck_rollup).toBe(true);
    expect(body.exception_kind).toBe("stuck");
    expect(body.proposed_action).toBe("none");
    expect(body.affected_themes).toContain("DL barcode parsing missing from DriverVerification.tsx");
  });

  it("in_flight PR merged (terminal, not stuck) → NO decision", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const svc = makeSvc({
      route: (table) => {
        if (table === "pm_roadmap")
          return { data: [{ id: "rm-4", theme: "done", status: "in_flight", outcome: null, child_run_id: "eng-4", last_dispatched_at: eightDaysAgo }], error: null };
        if (table === "agent_runs")
          return { data: [{ id: "eng-4", status: "success", finished_at: eightDaysAgo, parsed: { pr_state: "merged" } }], error: null };
        return { data: [], error: null };
      },
    });
    const out = await emitNeedsActionDecisions(ctx, { svc: asSvc(svc), isEnabled: async () => true });
    expect(out).toEqual({ emitted: 0, skipped: 0 });
    expect(svc.__rpcCalls).toHaveLength(0);
  });
});

function baseDecision(over: Partial<NeedsActionDecision> = {}): NeedsActionDecision {
  return {
    id: "dec-1",
    tenant_id: "tenant-A",
    agent_run_id: "pm-run-1",
    status: "dispatching",
    body: {
      theme: "checkout 500s",
      roadmap_id: "rm-1",
      child_run_id: "eng-1",
      pr_url: "https://github.com/acme/repo/pull/42",
      pr_state: "failed_to_open",
      exception_kind: "recurred",
      proposed_action: "redispatch_and_close_pr",
    },
    ...over,
  };
}

describe("performNeedsAction — approve fires redispatch + close_pr exactly once", () => {
  it("fires enqueue(engineer) once AND close_pr once, tenant-scoped, audited", async () => {
    const enqueue = vi.fn(
      async (_i: { agent_slug: string; tenant_id: string; trigger: "a2a"; payload: Record<string, unknown> }) => ({
        run_id: "eng-new",
      }),
    );
    const closePr = vi.fn(
      async (_a: { tenant_id: string; run_id: string; owner: string; repo: string; pull_number: number }) => ({
        ok: true,
      }),
    );
    const log = vi.fn();
    const svc = makeSvc({
      route: (table, ops) => {
        if (table === "agent_runs" && ops.some((o) => o[0] === "eq" && o[1][0] === "payload->>source_decision_id"))
          return { data: null, error: null };
        if (table === "agent_runs") return { data: { payload: { repo_hint: "acme/repo", file_hints: ["src/x.ts"] } }, error: null };
        return { data: null, error: null };
      },
    });

    const res = await performNeedsAction(baseDecision(), { enqueue, closePr, svc: asSvc(svc), log });

    expect(res.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const enqArg = enqueue.mock.calls[0]![0];
    expect(enqArg.agent_slug).toBe("engineer");
    expect(enqArg.tenant_id).toBe("tenant-A");
    expect(enqArg.trigger).toBe("a2a");
    expect(enqArg.payload.source_decision_id).toBe("dec-1");
    expect(enqArg.payload.repo_hint).toBe("acme/repo");
    expect(String(enqArg.payload.task_description)).toContain("re-scope and retry");

    expect(closePr).toHaveBeenCalledTimes(1);
    const clArg = closePr.mock.calls[0]![0];
    expect(clArg).toMatchObject({ tenant_id: "tenant-A", owner: "acme", repo: "repo", pull_number: 42 });

    expect(log).toHaveBeenCalledTimes(1);
    expect((log.mock.calls[0]![0] as { code: string }).code).toBe("pm.needs_action.acted");
  });

  it("IDEMPOTENT redispatch — a prior engineer run for this decision exists → NO second enqueue", async () => {
    const enqueue = vi.fn(async () => ({ run_id: "eng-new" }));
    const closePr = vi.fn(async () => ({ ok: true }));
    const svc = makeSvc({
      route: (table, ops) => {
        if (table === "agent_runs" && ops.some((o) => o[0] === "eq" && o[1][0] === "payload->>source_decision_id"))
          return { data: { id: "eng-already" }, error: null };
        return { data: null, error: null };
      },
    });
    const res = await performNeedsAction(baseDecision(), { enqueue, closePr, svc: asSvc(svc), log: vi.fn() });
    expect(res.ok).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("close_pr failure is swallowed — action still succeeds", async () => {
    const enqueue = vi.fn(async () => ({ run_id: "eng-new" }));
    const closePr = vi.fn(async () => ({ ok: false, error: "HTTP 422 already closed" }));
    const svc = makeSvc({ route: () => ({ data: null, error: null }) });
    const res = await performNeedsAction(baseDecision(), { enqueue, closePr, svc: asSvc(svc), log: vi.fn() });
    expect(res.ok).toBe(true);
    expect(closePr).toHaveBeenCalledTimes(1);
    expect(res.notice).toContain("not closed");
  });

  it("no pr_url → close_pr is not called, action still succeeds", async () => {
    const enqueue = vi.fn(async () => ({ run_id: "eng-new" }));
    const closePr = vi.fn(async () => ({ ok: true }));
    const svc = makeSvc({ route: () => ({ data: null, error: null }) });
    const d = baseDecision({ body: { ...baseDecision().body, pr_url: null } });
    const res = await performNeedsAction(d, { enqueue, closePr, svc: asSvc(svc), log: vi.fn() });
    expect(res.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(closePr).not.toHaveBeenCalled();
  });

  it("stuck_rollup (proposed_action=none) → NO enqueue, NO close_pr, acted no-op", async () => {
    const enqueue = vi.fn(async () => ({ run_id: "eng-new" }));
    const closePr = vi.fn(async () => ({ ok: true }));
    const log = vi.fn();
    const svc = makeSvc({ route: () => ({ data: null, error: null }) });
    const d = baseDecision({
      body: {
        stuck_rollup: true,
        exception_kind: "stuck",
        affected_count: 2,
        roadmap_id: null,
        pr_url: null,
        proposed_action: "none",
      },
    });
    const res = await performNeedsAction(d, { enqueue, closePr, svc: asSvc(svc), log });
    expect(res.ok).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(closePr).not.toHaveBeenCalled();
    expect((log.mock.calls[0]![0] as { code: string }).code).toBe("pm.needs_action.acknowledged");
    expect(res.notice).toContain("Acknowledged");
  });

  it("coalesced dispatch_died (proposed_action=none) → NO enqueue, NO close_pr", async () => {
    const enqueue = vi.fn(async () => ({ run_id: "eng-new" }));
    const closePr = vi.fn(async () => ({ ok: true }));
    const svc = makeSvc({ route: () => ({ data: null, error: null }) });
    const d = baseDecision({
      body: { coalesced: true, exception_kind: "dispatch_died", roadmap_id: null, proposed_action: "none" },
    });
    const res = await performNeedsAction(d, { enqueue, closePr, svc: asSvc(svc), log: vi.fn() });
    expect(res.ok).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(closePr).not.toHaveBeenCalled();
  });

  it("null roadmap_id alone (even without proposed_action) → no-op, cannot re-dispatch", async () => {
    const enqueue = vi.fn(async () => ({ run_id: "eng-new" }));
    const closePr = vi.fn(async () => ({ ok: true }));
    const svc = makeSvc({ route: () => ({ data: null, error: null }) });
    const d = baseDecision({ body: { theme: "x", roadmap_id: null } });
    const res = await performNeedsAction(d, { enqueue, closePr, svc: asSvc(svc), log: vi.fn() });
    expect(res.ok).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(closePr).not.toHaveBeenCalled();
  });

  it("already 'acted' → no-op (no enqueue, no close_pr)", async () => {
    const enqueue = vi.fn();
    const closePr = vi.fn();
    const svc = makeSvc({ route: () => ({ data: null, error: null }) });
    const res = await performNeedsAction(baseDecision({ status: "acted" }), { enqueue, closePr, svc: asSvc(svc), log: vi.fn() });
    expect(res.ok).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(closePr).not.toHaveBeenCalled();
  });

  it("'rejected' decision → no-op (reject fires no side effect)", async () => {
    const enqueue = vi.fn();
    const closePr = vi.fn();
    const svc = makeSvc({ route: () => ({ data: null, error: null }) });
    const res = await performNeedsAction(baseDecision({ status: "rejected" }), { enqueue, closePr, svc: asSvc(svc), log: vi.fn() });
    expect(res.ok).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(closePr).not.toHaveBeenCalled();
  });

  it("fleet halt during enqueue → returns retryable fleet_halted (no crash)", async () => {
    const enqueue = vi.fn(async () => {
      const e = new Error("halted") as Error & { code?: string };
      e.code = "fleet_halted";
      throw e;
    });
    const closePr = vi.fn(async () => ({ ok: true }));
    const svc = makeSvc({ route: () => ({ data: null, error: null }) });
    const res = await performNeedsAction(baseDecision(), { enqueue, closePr, svc: asSvc(svc), log: vi.fn() });
    expect(res).toEqual({ ok: false, error: "fleet_halted" });
    expect(closePr).not.toHaveBeenCalled();
  });
});

describe("parsePrUrl", () => {
  it("parses a github PR url", () => {
    expect(parsePrUrl("https://github.com/acme/repo/pull/42")).toEqual({ owner: "acme", repo: "repo", pull_number: 42 });
  });
  it("returns null on a non-PR url", () => {
    expect(parsePrUrl("https://example.com/foo")).toBeNull();
    expect(parsePrUrl(null)).toBeNull();
    expect(parsePrUrl(undefined)).toBeNull();
  });
});
