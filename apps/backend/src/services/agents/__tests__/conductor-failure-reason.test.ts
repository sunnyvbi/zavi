import { describe, it, expect, vi } from "vitest";
import {
  BUILD_FAILURE_CLASSES,
  coerceFailureClass,
  boundFailureReason,
  conductorTick,
  type ConductorRow,
  type ConductorNode,
  type ConductorTickDeps,
  type ChildTerminalStatus,
  type BuildFailureClass,
} from "../conductor";

type StatusCall = {
  status: string;
  reason?: { failure_class: BuildFailureClass; failure_reason: string };
};

function node(over: Partial<ConductorNode> = {}): ConductorNode {
  return {
    id: "n",
    status: "pending",
    target_agent_slug: "engineer",
    payload: { stage: "build", idea: "a marketplace", company_name: "Acme" },
    estimate_usd: 1,
    child_run_id: null,
    ...over,
  };
}

function makeDeps(graph: ConductorNode[], over: Partial<ConductorRow> = {}) {
  const calls: StatusCall[] = [];
  const r: ConductorRow = {
    id: "cond-1",
    tenant_id: "t1",
    objective: "build product",
    status: "active",
    max_usd: 100,
    spend_usd: 0,
    kind: "build_app",
    goal_graph: graph,
    ...over,
  };
  let saved = graph;
  const deps: ConductorTickDeps = {
    load: vi.fn(async () => r),
    childStatus: vi.fn(async (): Promise<ChildTerminalStatus> => "running"),
    consumeBudget: vi.fn(async () => "charged" as const),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "x" })),
    saveGraph: vi.fn(async (_id: string, g: ConductorNode[]) => {
      saved = g;
    }),
    setStatus: vi.fn(async (_id: string, status: string, reason?: StatusCall["reason"]) => {
      calls.push({ status, reason });
    }),
    hostingStatus: vi.fn(async () => "ready" as const),
  };
  return { deps, calls, saved: () => saved };
}

describe("BUG 1 — a terminal build records why it ended", () => {
  it("the anyFailed roll-up lifts the failed node's reason onto the row", async () => {
    const h = makeDeps([
      node({ id: "a", status: "done" }),
      node({
        id: "b",
        status: "failed",
        error: "npm ci exited 1: ERESOLVE could not resolve",
        failure_class: "stage_failed",
      }),
      node({ id: "c", status: "pending" }),
    ]);

    const res = await conductorTick("cond-1", h.deps);

    expect(res).toEqual({ action: "completed", final: "paused" });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].status).toBe("paused");
    expect(h.calls[0].reason).toEqual({
      failure_class: "stage_failed",
      failure_reason: "npm ci exited 1: ERESOLVE could not resolve",
    });
  });

  it("a failed node with NO error still yields a reason, and never claims a diagnosis", async () => {
    const h = makeDeps([
      node({ id: "a", status: "failed", payload: { stage: "spec" } }),
      node({ id: "b", status: "pending" }),
    ]);

    await conductorTick("cond-1", h.deps);

    const reason = h.calls[0].reason!;
    expect(reason.failure_class).toBe("stage_failed");
    expect(reason.failure_reason).toContain("spec");
    expect(reason.failure_reason).toMatch(/without recording a reason/i);
  });

  it("a successful run passes NO reason — success is not a failure with an empty label", async () => {
    const h = makeDeps([node({ id: "a", status: "done" }), node({ id: "b", status: "done" })]);

    const res = await conductorTick("cond-1", h.deps);

    expect(res).toEqual({ action: "completed", final: "done" });
    expect(h.calls).toEqual([{ status: "done", reason: undefined }]);
  });

  it("REGRESSION NET: every terminal setStatus call carries a usable reason", async () => {
    const shapes: Array<{ name: string; graph: ConductorNode[] }> = [
      {
        name: "failed head, pending tail (silent-stall short-circuit)",
        graph: [node({ id: "a", status: "failed", error: "boom" }), node({ id: "b", status: "pending" })],
      },
      {
        name: "failed tail, nothing pending (no-pending roll-up)",
        graph: [node({ id: "a", status: "done" }), node({ id: "b", status: "failed", error: "kaput" })],
      },
      {
        name: "failed node with an empty error string",
        graph: [node({ id: "a", status: "failed", error: "   " }), node({ id: "b", status: "pending" })],
      },
    ];

    const seen: Array<{ shape: string; call: StatusCall }> = [];
    for (const s of shapes) {
      const h = makeDeps(s.graph);
      await conductorTick("cond-1", h.deps);
      for (const call of h.calls) seen.push({ shape: s.name, call });
    }

    expect(seen.length).toBeGreaterThanOrEqual(shapes.length);
    for (const { shape, call } of seen) {
      if (call.status === "done") continue;
      expect(call.reason, `${shape} terminalized with no reason`).toBeDefined();
      expect(call.reason!.failure_class, `${shape} has no failure_class`).toBeTruthy();
      expect(
        call.reason!.failure_reason.trim().length,
        `${shape} has an empty failure_reason`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("BUG 1 — the DB CHECK must never be able to abort a terminalize", () => {
  it("clamps any unrecognised failure_class to 'unknown' instead of throwing", () => {
    for (const bad of ["", "   ", "user_cancel", "child_cancelled", "STAGE_FAILED", "'; drop table x;--"]) {
      expect(coerceFailureClass(bad)).toBe("unknown");
    }
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(coerceFailureClass(bad)).toBe("unknown");
    }
  });

  it("passes through every value the SQL CHECK actually allows", () => {
    for (const ok of BUILD_FAILURE_CLASSES) expect(coerceFailureClass(ok)).toBe(ok);
  });

  it("a node carrying a garbage failure_class still terminalizes, as 'unknown'", async () => {
    const h = makeDeps([
      node({ id: "a", status: "failed", error: "boom", failure_class: "totally_made_up" as never }),
      node({ id: "b", status: "pending" }),
    ]);

    const res = await conductorTick("cond-1", h.deps);

    expect(res).toEqual({ action: "completed", final: "failed" });
    expect(h.calls[0].reason!.failure_class).toBe("unknown");
    expect(h.calls[0].reason!.failure_reason).toBe("boom");
  });

  it("a non-string error in JSONB does not throw before setStatus is reached", async () => {
    const h = makeDeps([
      node({ id: "a", status: "failed", error: 500 as never, last_failure_signal: null }),
      node({ id: "b", status: "pending" }),
    ]);

    const res = await conductorTick("cond-1", h.deps);

    expect(res).toEqual({ action: "completed", final: "failed" });
    expect(h.calls[0].reason!.failure_reason).toMatch(/without recording a reason/i);
  });

  it("bounds the reason without splitting a surrogate pair", () => {
    const emoji = "\u{1F680}";
    const padded = "x".repeat(3999) + emoji;
    const out = boundFailureReason(padded, "fallback");
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false);
    expect(() => Buffer.from(out, "utf8").toString("utf8")).not.toThrow();
    expect(boundFailureReason("   ", "fallback")).toBe("fallback");
    expect(boundFailureReason(null, "fallback")).toBe("fallback");
  });
});
