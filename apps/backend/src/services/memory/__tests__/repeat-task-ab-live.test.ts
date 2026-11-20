import { describe, it, expect, vi } from "vitest";
import { makeRepeatTaskAbLiveDeps } from "../repeat-task-ab-live";
import type { RepeatTaskAbLiveWiring } from "../repeat-task-ab-live";
import type { RepeatTaskGoldenLite } from "../repeat-task-ab";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

type SbCall = { op: "insert" | "update"; table: string; row: unknown; eq?: [string, unknown] };

function makeFakeSb(calls: SbCall[], opts: { insertError?: string } = {}) {
  return () =>
    ({
      from(table: string) {
        return {
          insert(row: unknown) {
            calls.push({ op: "insert", table, row });
            return Promise.resolve({
              error: opts.insertError ? { message: opts.insertError } : null,
            });
          },
          update(row: unknown) {
            calls.push({ op: "update", table, row });
            const builder: {
              eq: (col: string, val: unknown) => typeof builder;
              then: (
                onF: (v: { error: null }) => unknown,
                onR?: (e: unknown) => unknown,
              ) => Promise<unknown>;
            } = {
              eq: () => builder,
              then: (onF, onR) => Promise.resolve({ error: null }).then(onF, onR),
            };
            return builder;
          },
        };
      },
    }) as never;
}

const golden: RepeatTaskGoldenLite = {
  id: "11111111-1111-1111-1111-111111111111",
  tenant_id: "22222222-2222-2222-2222-222222222222",
  agent_slug: "support-lead",
  query: "What is our refund policy?",
};

function fakeDispatcherResult(over: Partial<DispatcherResult> = {}): DispatcherResult {
  return {
    output_text: "the answer",
    parse_ok: true,
    parsed: null,
    raw_response_text: "the answer",
    prompt_snapshot: "",
    usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.0042 },
    ...over,
  } as DispatcherResult;
}

function baseWiring(over: Partial<RepeatTaskAbLiveWiring> = {}): {
  wiring: Partial<RepeatTaskAbLiveWiring>;
  calls: SbCall[];
  runDispatch: ReturnType<typeof vi.fn>;
} {
  const calls: SbCall[] = [];
  const runDispatch = vi.fn(async () =>
    fakeDispatcherResult(),
  ) as ReturnType<typeof vi.fn>;
  const wiring: Partial<RepeatTaskAbLiveWiring> = {
    buildContext: async () =>
      ({ agent: { slug: golden.agent_slug }, draft_mode: false }) as unknown as AgentContext,
    makeDraftCtx: (ctx) => ({ ...ctx, draft_mode: true }),
    runDispatch: runDispatch as never,
    getDispatcher: () => null,
    loadAgentDefinition: async () => ({ content_hash: "hash-abc" }),
    sb: makeFakeSb(calls),
    ...over,
  };
  return { wiring, calls, runDispatch };
}

describe("makeRepeatTaskAbLiveDeps — live dispatch dep", () => {
  it("threads memory_mode:'off' + intent=query + a2a/origin for the brain_off arm", async () => {
    const { wiring, calls } = baseWiring();
    const deps = makeRepeatTaskAbLiveDeps(wiring);
    await deps.dispatch(golden, "brain_off");

    const insert = calls.find((c) => c.op === "insert" && c.table === "agent_runs");
    expect(insert).toBeTruthy();
    const row = insert!.row as { trigger: string; payload: Record<string, unknown> };
    expect(row.trigger).toBe("a2a");
    expect(row.payload.intent).toBe(golden.query);
    expect(row.payload.memory_mode).toBe("off");
    expect(row.payload.origin).toBe("repeat_task_ab");
    expect(row.payload.arm).toBe("brain_off");
  });

  it("leaves memory_mode undefined for the brain_on arm", async () => {
    const { wiring, calls } = baseWiring();
    const deps = makeRepeatTaskAbLiveDeps(wiring);
    await deps.dispatch(golden, "brain_on");
    const insert = calls.find((c) => c.op === "insert" && c.table === "agent_runs");
    const row = insert!.row as { payload: Record<string, unknown> };
    expect(row.payload.memory_mode).toBeUndefined();
  });

  it("passes a draft ctx (draft_mode true) to runDispatch — zero side effects", async () => {
    const { wiring, runDispatch } = baseWiring();
    const deps = makeRepeatTaskAbLiveDeps(wiring);
    await deps.dispatch(golden, "brain_on");
    expect(runDispatch).toHaveBeenCalledTimes(1);
    const ctxArg = runDispatch.mock.calls[0][0] as AgentContext;
    expect(ctxArg.draft_mode).toBe(true);
  });

  it("maps DispatcherResult → AbDispatchResult (output_text, parse_ok, usage)", async () => {
    const { wiring } = baseWiring();
    const deps = makeRepeatTaskAbLiveDeps(wiring);
    const res = await deps.dispatch(golden, "brain_on");
    expect(res.output_text).toBe("the answer");
    expect(res.parse_ok).toBe(true);
    expect(res.usage?.cost_usd).toBe(0.0042);
    expect(res.usage?.input_tokens).toBe(100);
    expect(res.usage?.output_tokens).toBe(50);
  });

  it("creates the FK-parent row then marks it terminal=success on parse_ok", async () => {
    const { wiring, calls } = baseWiring();
    const deps = makeRepeatTaskAbLiveDeps(wiring);
    await deps.dispatch(golden, "brain_on");
    const insert = calls.find((c) => c.op === "insert" && c.table === "agent_runs");
    const update = calls.find((c) => c.op === "update" && c.table === "agent_runs");
    expect(insert).toBeTruthy();
    expect(update).toBeTruthy();
    expect((update!.row as { status: string }).status).toBe("success");
    expect(calls.indexOf(insert!)).toBeLessThan(calls.indexOf(update!));
  });

  it("marks terminal=parse_failed when the dispatch parse fails", async () => {
    const { wiring, calls } = baseWiring({
      runDispatch: (async () =>
        fakeDispatcherResult({ parse_ok: false })) as never,
    });
    const deps = makeRepeatTaskAbLiveDeps(wiring);
    const res = await deps.dispatch(golden, "brain_on");
    expect(res.parse_ok).toBe(false);
    const update = calls.find((c) => c.op === "update" && c.table === "agent_runs");
    expect((update!.row as { status: string }).status).toBe("parse_failed");
  });

  it("marks terminal=dispatch_error AND rethrows when runDispatch throws (no orphan 'running')", async () => {
    const { wiring, calls } = baseWiring({
      runDispatch: (async () => {
        throw new Error("model exploded");
      }) as never,
    });
    const deps = makeRepeatTaskAbLiveDeps(wiring);
    await expect(deps.dispatch(golden, "brain_on")).rejects.toThrow("model exploded");
    const update = calls.find((c) => c.op === "update" && c.table === "agent_runs");
    expect(update, "terminal update must run in finally even on throw").toBeTruthy();
    expect((update!.row as { status: string }).status).toBe("dispatch_error");
  });

  it("REFUSES a known real customer tenant unless allowRealTenant (dep-level, not just CLI)", async () => {
    const realGolden: RepeatTaskGoldenLite = {
      ...golden,
      tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    };
    const { wiring, calls } = baseWiring();
    const deps = makeRepeatTaskAbLiveDeps(wiring);
    await expect(deps.dispatch(realGolden, "brain_on")).rejects.toThrow(
      /refuses real customer tenant/,
    );
    expect(calls.filter((c) => c.table === "agent_runs")).toHaveLength(0);

    const { wiring: w2 } = baseWiring();
    const deps2 = makeRepeatTaskAbLiveDeps({ ...w2, allowRealTenant: true });
    await expect(deps2.dispatch(realGolden, "brain_on")).resolves.toBeDefined();
  });

  it("REFUSES bespoke-dispatcher agents and writes NO agent_runs row", async () => {
    const { wiring, calls } = baseWiring({ getDispatcher: () => ({})  });
    const deps = makeRepeatTaskAbLiveDeps(wiring);
    await expect(deps.dispatch({ ...golden, agent_slug: "pm" }, "brain_on")).rejects.toThrow(
      /bespoke-dispatcher/,
    );
    expect(calls.length).toBe(0);
  });

  it("throws a clean error when the agent definition is missing", async () => {
    const { wiring, calls } = baseWiring({ loadAgentDefinition: async () => null });
    const deps = makeRepeatTaskAbLiveDeps(wiring);
    await expect(deps.dispatch(golden, "brain_on")).rejects.toThrow(/not found/);
    expect(calls.length).toBe(0);
  });

  it("writeMetric inserts a repeat_task_ab_metrics row", async () => {
    const { wiring, calls } = baseWiring();
    const deps = makeRepeatTaskAbLiveDeps(wiring);
    await deps.writeMetric({
      tenant_id: golden.tenant_id,
      agent_slug: golden.agent_slug,
      golden_id: golden.id,
      eval_run_id: "run-1",
      arm: "brain_on",
      correctness_score: null,
      model_cost_usd: 0.01,
      retrieval_cost_usd: null,
      judge_cost_usd: null,
      walltime_ms: 1234,
      terminal_status: "finished",
    });
    const insert = calls.find(
      (c) => c.op === "insert" && c.table === "repeat_task_ab_metrics",
    );
    expect(insert).toBeTruthy();
    expect((insert!.row as { arm: string }).arm).toBe("brain_on");
  });

  it("newEvalRunId + now are wired", () => {
    const deps = makeRepeatTaskAbLiveDeps(baseWiring().wiring);
    expect(typeof deps.newEvalRunId()).toBe("string");
    expect(deps.newEvalRunId()).not.toBe(deps.newEvalRunId());
    expect(typeof deps.now()).toBe("number");
  });
});
