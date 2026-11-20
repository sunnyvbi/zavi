
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  persistTerminal: vi.fn(),
  postRunDistill: vi.fn(),
  recordAgentTake: vi.fn(),
  growthPostProcessor: vi.fn(),
  notifyThreadOwner: vi.fn(),
  recordPredictions: vi.fn(),
  writeCronRunSummary: vi.fn(),
  loadAgentDefinition: vi.fn(),
  inngestSend: vi.fn(),
  serviceClientMock: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("../../client", () => ({
  inngest: { send: mocks.inngestSend, createFunction: () => ({}) },
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/agents/runner", () => ({
  persistTerminal: mocks.persistTerminal,
  postRunDistill: mocks.postRunDistill,
  buildContext: vi.fn(), claimAgentRun: vi.fn(), enqueueAgentRun: vi.fn(), runDispatch: vi.fn(),
}));
vi.mock("@/services/memory/takes-service", () => ({ recordAgentTake: mocks.recordAgentTake }));
vi.mock("@/agents/index", () => ({
  postProcessors: { "growth-lead": mocks.growthPostProcessor },
}));
vi.mock("@/services/notifications/push-fanout", () => ({ notifyThreadOwner: mocks.notifyThreadOwner }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: mocks.loadAgentDefinition }));
vi.mock("@/services/agents/cron-summary", () => ({ writeCronRunSummary: mocks.writeCronRunSummary }));
vi.mock("@/services/agents/predictions", () => ({ recordPredictions: mocks.recordPredictions }));
vi.mock("@/services/agents/progress", () => ({ makeEmitProgress: () => vi.fn() }));
vi.mock("@/services/agents/model-router", () => ({ resolveModelForRun: vi.fn() }));
vi.mock("@/services/agents/ensure-runnable", () => ({ ensureAgentRunnable: vi.fn() }));
vi.mock("@/services/sandbox/lifecycle", () => ({
  bootstrapRepoIfNeeded: vi.fn(), injectSandboxSecrets: vi.fn(), pauseAndMarkPaused: vi.fn(),
  resolveSandboxForRun: vi.fn(), resolveStoredDefaultBranch: vi.fn(), wipeSandboxSecrets: vi.fn(),
}));
vi.mock("@/services/sandbox/run-worktree", () => ({
  createRunWorktree: vi.fn(), reapOrphanWorktrees: vi.fn(), removeRunWorktree: vi.fn(),
}));
vi.mock("@/services/sandbox/e2b-client", () => ({ extendSandboxTimeout: vi.fn() }));
vi.mock("@/services/sandbox/keepalive-flag", () => ({ getTenantSandboxKeepalive: vi.fn() }));
vi.mock("@/services/sandbox/browser-mcp/anchor-backend", () => ({
  closeAnchorRun: vi.fn(),
  anchorBackend: { runOp: vi.fn() },
  getBrowserActionEmitter: vi.fn(() => ({ emit: vi.fn() })),
  BROWSER_ACTION_DECISION_CLASS: "browser_action",
}));
vi.mock("@/services/sandbox/browser-mcp/backend", () => ({ _clearRunBrowserState: vi.fn() }));
vi.mock("@/services/agents/engine/capture-ledger", () => ({ clearCaptureLedger: vi.fn() }));
vi.mock("@/services/connectors/github/oauth", () => ({ mintInstallationToken: vi.fn() }));
vi.mock("@/services/sandbox/repo-picker", () => ({ pickRepoForTask: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.logEvent }));
vi.mock("@/services/provisioning/provisioned-repo-gate", () => ({ assertProvisionedRepoTarget: vi.fn(), realProvisionedRepoGateDeps: {} }));

import { finalizeRun, type FinalizeStepLike } from "../finalize-run";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

const TENANT = "tenant-1";
const RUN_ID = "run-1";

function makeResult(over: Partial<DispatcherResult> = {}): DispatcherResult {
  return {
    output_text: "hello world",
    parsed: { ok: true },
    parse_ok: true,
    raw_response_text: "hello world",
    prompt_snapshot: "sys",
    usage: { input_tokens: 10, output_tokens: 20 },
    ...over,
  } as DispatcherResult;
}

describe("refusal completion events", () => {
  it("keeps a refused first plan failed in timing while retaining plan-build attribution", async () => {
    mocks.persistTerminal.mockResolvedValue("refused");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { deps } = makeDeps();
      await finalizeRun({
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "cgo", trigger: "chat",
        model: "m", result: makeResult(), payload: { stage: "draft_strategy", origin: "setup_draft" },
      }, deps);
      const timing = log.mock.calls.map(([line]) => JSON.parse(String(line)))
        .find(row => row.event === "run_timing");
      expect(timing).toMatchObject({
        run_id: RUN_ID, parse_ok: true, outcome: "failed", plan_build: true, first_plan: true,
      });
    } finally {
      log.mockRestore();
    }
  });
  it("memoizes the refusal verdict across replays and keeps the cron summary consistent", async () => {
    mocks.persistTerminal.mockResolvedValueOnce("refused").mockResolvedValue("not_refused");
    const cache = new Map<string, unknown>();
    const step: FinalizeStepLike = {
      run: async (id, fn) => {
        if (!cache.has(id)) cache.set(id, await fn());
        return cache.get(id);
      },
      sendEvent: vi.fn(async () => undefined),
    };
    const {deps, emitWorker} = makeDeps({step});
    for (let i = 0; i < 3; i++) {
      expect((await finalizeRun({run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", trigger: "cron", model: "m", result: makeResult(), payload: {}}, deps)).status).toBe("failed");
    }
    expect(mocks.persistTerminal).toHaveBeenCalledTimes(1);
    expect(emitWorker.mock.calls.filter(([stage]) => stage === "completed")).toEqual([["completed", {code: "failed"}]]);
    expect(mocks.writeCronRunSummary).toHaveBeenCalledWith(expect.objectContaining({status: "failed"}));
  });
  it.each([true, false])("reuses the persisted refusal for events, progress and return (memoized=%s)", async memoized => {
    mocks.persistTerminal.mockResolvedValue("refused");
    const recording = makeRecordingStep();
    const { deps, emitWorker } = makeDeps(memoized ? {step: recording.step} : {});
    const result = makeResult({output_text: "I cannot start the requested check."});
    const finished = await finalizeRun({run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", trigger: "manual", model: "m", result, payload: {}}, deps);
    expect(finished.status).toBe("failed");
    expect(result.parse_ok).toBe(true);
    expect(emitWorker).toHaveBeenCalledWith("completed", {code: "failed"});
    const events = memoized ? recording.sentEvents : mocks.inngestSend.mock.calls.map(([event]) => event);
    expect(events.find(event => event.name === "agent.run.completed")?.data.status).toBe("failed");
    expect(mocks.persistTerminal).toHaveBeenCalledTimes(1);
  });
});

function makeRecordingStep() {
  const calls: Array<{ id: string; kind: "run" | "sendEvent" }> = [];
  const sentEvents: Array<{ name: string; data: Record<string, unknown> }> = [];
  const step: FinalizeStepLike = {
    run: async (id, fn) => {
      calls.push({ id, kind: "run" });
      return fn();
    },
    sendEvent: async (id, payload) => {
      calls.push({ id, kind: "sendEvent" });
      sentEvents.push(payload);
      return undefined;
    },
  };
  return { step, calls, sentEvents };
}

function makeDeps(over: { step?: FinalizeStepLike } = {}) {
  const emitWorker = vi.fn(async (_stage: string, _meta?: unknown) => undefined);
  const rebuildContext = vi.fn(async () => ({}) as AgentContext);
  return {
    deps: { step: over.step, emitWorker, rebuildContext },
    emitWorker,
    rebuildContext,
  };
}

function stubCostRead(cost: number | null = 0.42) {
  mocks.serviceClientMock.mockImplementation(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { cost_usd: cost }, error: null }) }),
      }),
    }),
  }));
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => (m as { mockReset?: () => void }).mockReset?.());
  mocks.persistTerminal.mockResolvedValue(undefined);
  mocks.postRunDistill.mockResolvedValue(undefined);
  mocks.recordAgentTake.mockResolvedValue(undefined);
  mocks.growthPostProcessor.mockResolvedValue(undefined);
  mocks.notifyThreadOwner.mockResolvedValue(undefined);
  mocks.recordPredictions.mockResolvedValue(undefined);
  mocks.writeCronRunSummary.mockResolvedValue(undefined);
  mocks.loadAgentDefinition.mockResolvedValue({ metadata_praxis: { memory_layer: true } });
  mocks.inngestSend.mockResolvedValue(undefined);
  stubCostRead();
});

describe("finalizeRun — EC2 mode (step present)", () => {
  it("a failed completion warning step also preserves the saved terminal result", async () => {
    const { step, sentEvents } = makeRecordingStep();
    const run = step.run, send = step.sendEvent;
    step.run = async (id, fn) => { if (id === "log-emit-completed-failed") throw new Error("warning step failed"); return run(id, fn); };
    step.sendEvent = async (id, payload) => { if (id.startsWith("emit-completed")) throw new Error("send failed"); return send(id, payload); };
    const { deps } = makeDeps({ step });
    await expect(finalizeRun({ run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", trigger: "manual", model: "m", result: makeResult(), payload: {} }, deps)).resolves.toEqual({ run_id: RUN_ID, status: "success" });
    expect(mocks.persistTerminal).toHaveBeenCalledTimes(1);
    expect(sentEvents.map(e => e.name)).toEqual(["agent.run.terminal"]);
  });
  it.each(["persisted", "completed"])("a failed %s progress notification cannot turn persisted success into failure", async failedStage => {
    const { step, sentEvents } = makeRecordingStep();
    const { deps, emitWorker } = makeDeps({ step });
    emitWorker.mockImplementation(async stage => { if (stage === failedStage) throw new Error("progress unavailable"); });
    await expect(finalizeRun({ run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", trigger: "manual", model: "m", result: makeResult(), payload: {} }, deps)).resolves.toEqual({ run_id: RUN_ID, status: "success" });
    expect(mocks.persistTerminal).toHaveBeenCalledTimes(1);
    expect(sentEvents.map(e => e.name)).toContain("agent.run.completed");
    expect(emitWorker.mock.calls.some(([stage]) => stage === "failed")).toBe(false);
  });
  it("a signup preview run is not distilled into the Brain", async () => {
    const { step, calls } = makeRecordingStep();
    const { deps } = makeDeps({ step });
    await finalizeRun(
      {
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "seo", trigger: "channel_recipe",
        model: "claude-sonnet-4-6", result: makeResult(), payload: {}, preview: true,
      },
      deps,
    );
    expect(calls.map((c) => c.id)).not.toContain("post-run-distill");
    expect(mocks.postRunDistill).not.toHaveBeenCalled();
  });

  it("runs the post-run steps in the frozen order + emits the two events", async () => {
    const { step, calls, sentEvents } = makeRecordingStep();
    const { deps } = makeDeps({ step });

    const res = await finalizeRun(
      {
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", trigger: "manual",
        model: "claude-sonnet-4-6", result: makeResult(), payload: {},
      },
      deps,
    );

    expect(res).toEqual({ run_id: RUN_ID, status: "success" });
    expect(calls.map((c) => c.id)).toEqual([
      "persist-success",
      "progress-persisted",
      "progress-completed",
      "post-run-distill",
      "post-run-record-take",
      "emit-completed",
      "emit-terminal",
    ]);
    expect(sentEvents.map((e) => e.name)).toEqual([
      "agent.run.completed",
      "agent.run.terminal",
    ]);
    expect(sentEvents[0].data).toMatchObject({
      run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", status: "success",
    });
    expect(sentEvents[1].data).toEqual({ run_id: RUN_ID });
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("growth-lead + non-chat trigger → post-run-growth fires before persist", async () => {
    const { step, calls } = makeRecordingStep();
    const { deps, rebuildContext } = makeDeps({ step });

    await finalizeRun(
      {
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "growth-lead", trigger: "cron",
        model: "m", result: makeResult(), payload: {},
      },
      deps,
    );

    expect(calls.map((c) => c.id)).toEqual([
      "post-run-growth",
      "persist-success",
      "progress-persisted",
      "progress-completed",
      "post-run-distill",
      "post-run-record-take",
      "cron-summary",
      "emit-completed",
      "emit-terminal",
    ]);
    expect(rebuildContext).toHaveBeenCalledTimes(1);
    expect(mocks.growthPostProcessor).toHaveBeenCalledTimes(1);
  });

  it("the success status lands before the distill and record-take steps, so a slow one cannot hold it", async () => {
    let releaseDistill!: () => void;
    const distillGate = new Promise<void>((r) => (releaseDistill = r));
    const order: string[] = [];
    mocks.persistTerminal.mockImplementation(async () => {
      order.push("persist");
    });
    mocks.postRunDistill.mockImplementation(async () => {
      order.push("distill:start");
      await distillGate;
      order.push("distill:end");
    });
    mocks.recordAgentTake.mockImplementation(async () => {
      order.push("take");
    });
    const { step } = makeRecordingStep();
    const { deps, emitWorker } = makeDeps({ step });
    const done = finalizeRun(
      {
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "engineer", trigger: "a2a",
        model: "m", result: makeResult(), payload: { stage: "build" },
      },
      deps,
    );
    await vi.waitFor(() => expect(order).toContain("distill:start"));
    expect(order).toEqual(["persist", "distill:start"]);
    expect(emitWorker).toHaveBeenCalledWith("persisted");
    releaseDistill();
    await done;
    expect(order).toEqual(["persist", "distill:start", "distill:end", "take"]);
  });

  it("a distill or record-take failure after persist never undoes or skips the terminal events", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.postRunDistill.mockRejectedValue(new Error("entity upsert down"));
    mocks.recordAgentTake.mockRejectedValue(new Error("takes down"));
    const { step, calls, sentEvents } = makeRecordingStep();
    const { deps } = makeDeps({ step });
    const res = await finalizeRun(
      {
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", trigger: "manual",
        model: "m", result: makeResult(), payload: {},
      },
      deps,
    );
    expect(res.status).toBe("success");
    expect(mocks.persistTerminal).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.id)[0]).toBe("persist-success");
    expect(sentEvents.map((e) => e.name)).toEqual(["agent.run.completed", "agent.run.terminal"]);
  });

  it("emit-completed failing after persist-success retries once under its own id and never fails the run", async () => {
    const { step, calls, sentEvents } = makeRecordingStep();
    const send = step.sendEvent;
    step.sendEvent = async (id, payload) => {
      if (id === "emit-completed") {
        calls.push({ id, kind: "sendEvent" });
        throw Object.assign(new Error("send failed"), { stepId: id });
      }
      return send(id, payload);
    };
    const { deps, emitWorker } = makeDeps({ step });
    const res = await finalizeRun(
      { run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", trigger: "manual", model: "m", result: makeResult(), payload: {} },
      deps,
    );
    expect(res).toEqual({ run_id: RUN_ID, status: "success" });
    expect(calls.map((c) => c.id).slice(-3)).toEqual(["emit-completed", "emit-completed-retry", "emit-terminal"]);
    expect(sentEvents.map((e) => e.name)).toEqual(["agent.run.completed", "agent.run.terminal"]);
    expect(emitWorker).not.toHaveBeenCalledWith("failed", expect.anything());
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("emit-completed and its retry both failing: logged, the run stays success, no failed event or second persist", async () => {
    const { step, calls, sentEvents } = makeRecordingStep();
    const send = step.sendEvent;
    step.sendEvent = async (id, payload) => {
      if (id.startsWith("emit-completed")) {
        calls.push({ id, kind: "sendEvent" });
        throw new Error("send failed");
      }
      return send(id, payload);
    };
    const { deps, emitWorker } = makeDeps({ step });
    const res = await finalizeRun(
      { run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", trigger: "manual", model: "m", result: makeResult(), payload: {} },
      deps,
    );
    expect(res.status).toBe("success");
    expect(mocks.persistTerminal).toHaveBeenCalledTimes(1);
    expect(sentEvents.map((e) => e.name)).toEqual(["agent.run.terminal"]);
    expect(sentEvents.map((e) => e.name)).not.toContain("agent.run.failed");
    expect(emitWorker.mock.calls.map((c) => (c as unknown[])[0])).not.toContain("failed");
    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    expect(mocks.logEvent.mock.calls[0][0]).toMatchObject({
      level: "warn",
      code: "emit_completed_failed",
      run_id: RUN_ID,
      tenant_id: TENANT,
    });
    expect(calls.map((c) => c.id)).toContain("emit-completed-retry");
    expect(calls.map((c) => c.id)).toContain("log-emit-completed-failed");
  });

  it("growth-lead + chat trigger → post-run-growth SKIPPED (chat path handles it)", async () => {
    const { step, calls } = makeRecordingStep();
    const { deps } = makeDeps({ step });
    await finalizeRun(
      {
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "growth-lead", trigger: "chat",
        model: "m", result: makeResult(), payload: { thread_id: "th-1" },
      },
      deps,
    );
    expect(calls.map((c) => c.id)).not.toContain("post-run-growth");
    expect(mocks.growthPostProcessor).not.toHaveBeenCalled();
  });

  it("parse_ok false → status parse_failed + completed code parse_failed", async () => {
    const { step, sentEvents } = makeRecordingStep();
    const { deps, emitWorker } = makeDeps({ step });
    const res = await finalizeRun(
      {
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", trigger: "manual",
        model: "m", result: makeResult({ parse_ok: false }), payload: {},
      },
      deps,
    );
    expect(res.status).toBe("parse_failed");
    expect(emitWorker).toHaveBeenCalledWith("completed", { code: "parse_failed" });
    expect(sentEvents[0].data).toMatchObject({ status: "parse_failed" });
  });

  it("chat trigger + parse_ok → mobile push fires once, inside a memoized step", async () => {
    const { step, calls } = makeRecordingStep();
    const { deps } = makeDeps({ step });
    await finalizeRun(
      {
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", trigger: "chat",
        model: "m", result: makeResult(), payload: { thread_id: "th-9" },
      },
      deps,
    );
    expect(mocks.notifyThreadOwner).toHaveBeenCalledTimes(1);
    expect(mocks.notifyThreadOwner.mock.calls[0][0]).toMatchObject({
      tenant_id: TENANT, agent_slug: "pm", thread_id: "th-9", title: "Zavi replied",
    });
    expect(calls).toContainEqual({ id: "mobile-push-chat-reply", kind: "run" });
  });

  it("reactive agent (support-lead) + parse_ok + output → recordPredictions fires inside a memoized step", async () => {
    const { step, calls } = makeRecordingStep();
    const { deps } = makeDeps({ step });
    await finalizeRun(
      {
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "support-lead", trigger: "manual",
        model: "m", result: makeResult(), payload: {},
      },
      deps,
    );
    expect(mocks.recordPredictions).toHaveBeenCalledTimes(1);
    expect(calls).toContainEqual({ id: "record-predictions", kind: "run" });
  });

  it("persistTerminal is called with EXACTLY the 8-arg shape (run_id, slug, result, null, model, payload, trigger, tenant_id)", async () => {
    const { step } = makeRecordingStep();
    const { deps } = makeDeps({ step });
    const result = makeResult();
    const payload = { thread_id: "x" };
    await finalizeRun(
      {
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", trigger: "manual",
        model: "claude-sonnet-4-6", result, payload,
      },
      deps,
    );
    expect(mocks.persistTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.persistTerminal.mock.calls[0]).toEqual([
      RUN_ID, "pm", result, null, "claude-sonnet-4-6", payload, "manual", TENANT,
    ]);
  });
});

describe("finalizeRun — HTTP mode (step undefined)", () => {
  it("runs the SAME leaves in the SAME order; inngest.send fires twice with the two events", async () => {
    const { deps } = makeDeps({ step: undefined });

    const res = await finalizeRun(
      {
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "growth-lead", trigger: "cron",
        model: "claude-sonnet-4-6", result: makeResult(), payload: {},
      },
      deps,
    );

    expect(res).toEqual({ run_id: RUN_ID, status: "success" });
    expect(mocks.postRunDistill).toHaveBeenCalledTimes(1);
    expect(mocks.recordAgentTake).toHaveBeenCalledTimes(1);
    expect(mocks.growthPostProcessor).toHaveBeenCalledTimes(1);
    expect(mocks.persistTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.writeCronRunSummary).toHaveBeenCalledTimes(1);
    expect(mocks.inngestSend).toHaveBeenCalledTimes(2);
    expect(mocks.inngestSend.mock.calls[0][0]).toMatchObject({ name: "agent.run.completed" });
    expect(mocks.inngestSend.mock.calls[1][0]).toMatchObject({ name: "agent.run.terminal" });
  });

  it("HTTP mode persistTerminal 8-arg shape matches EC2 mode exactly", async () => {
    const { deps } = makeDeps({ step: undefined });
    const result = makeResult();
    const payload = { foo: "bar" };
    await finalizeRun(
      {
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "qa", trigger: "manual",
        model: "m", result, payload,
      },
      deps,
    );
    expect(mocks.persistTerminal.mock.calls[0]).toEqual([
      RUN_ID, "qa", result, null, "m", payload, "manual", TENANT,
    ]);
  });

  it("a hung chat push never holds up the HTTP finalize (fire-and-forget without a step)", async () => {
    const { deps } = makeDeps({ step: undefined });
    mocks.notifyThreadOwner.mockImplementationOnce(() => new Promise(() => {}));
    const res = await finalizeRun(
      {
        run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", trigger: "chat",
        model: "m", result: makeResult(), payload: { thread_id: "th-9" },
      },
      deps,
    );
    expect(res).toEqual({ run_id: RUN_ID, status: "success" });
    expect(mocks.notifyThreadOwner).toHaveBeenCalledTimes(1);
    expect(mocks.inngestSend).toHaveBeenCalledTimes(2);
  });
});

it("five worker replays persist and emit each completion stage only once", async () => {
  const cache = new Map<string, unknown>();
  const step: FinalizeStepLike = {
    run: async (id, fn) => {
      if (!cache.has(id)) cache.set(id, await fn());
      return cache.get(id);
    },
    sendEvent: async () => undefined,
  };
  const { deps, emitWorker } = makeDeps({ step });
  for (let i = 0; i < 5; i++) await finalizeRun({
    run_id: RUN_ID, tenant_id: TENANT, agent_slug: "pm", trigger: "manual",
    model: "m", result: makeResult(), payload: {},
  }, deps);
  expect(mocks.persistTerminal).toHaveBeenCalledTimes(1);
  expect(emitWorker.mock.calls.filter(([stage]) => stage === "persisted")).toHaveLength(1);
  expect(emitWorker.mock.calls.filter(([stage]) => stage === "completed")).toHaveLength(1);
});
