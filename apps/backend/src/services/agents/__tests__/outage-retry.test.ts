import { describe, it, expect, vi } from "vitest";
import {
  isRealToolEvent,
  staticOutageSkip,
  providerRecoveredSince,
  supersessionKey,
  runOutageRetrySweep,
  OUTAGE_RETRY_PER_TICK,
  type OutageCandidate,
} from "../outage-retry";
import { isProviderOutageError } from "../infra-retry";
import { classifyUsageLimitStatus } from "../usage-limit-status";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const SEAT =
  "Claude Code returned an error result: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead";
const LIMIT = "Claude Code returned an error result: You've hit your limit · resets 7pm (UTC)";

function cand(over: Partial<OutageCandidate> = {}): OutageCandidate {
  return {
    id: "run-1",
    tenant_id: "ten-1",
    agent_slug: "operator",
    status: "dispatch_error",
    error: SEAT,
    infra_retry_count: 0,
    trigger: "chat",
    batch_id: null,
    finished_at: "2026-10-21T10:00:00Z",
    enqueued_at: "2026-10-21T09:59:00Z",
    custom_trigger_id: null,
    payload: { thread_id: "th-1" },
    ...over,
  };
}

describe("isProviderOutageError", () => {
  it("is our seat or a usage limit, never a customer connector's auth error", () => {
    expect(isProviderOutageError(SEAT)).toBe(true);
    expect(isProviderOutageError(LIMIT)).toBe(true);
    expect(isProviderOutageError(`money-path run not auto-retried (c-1a2b): ${LIMIT}`)).toBe(true);
    expect(isProviderOutageError("Claude Code returned an error result: API Error: 401 authentication_error")).toBe(true);
    expect(isProviderOutageError("meta_ads: OAuth access token has expired")).toBe(false);
    expect(isProviderOutageError("Meta API: account out of credits for boosts")).toBe(false);
    expect(isProviderOutageError("You've hit your limit · resets Sep 26 at 5:30am (Asia/Calcutta)")).toBe(true);
    expect(isProviderOutageError("boot_reap: orphaned by container restart")).toBe(false);
    expect(isProviderOutageError(null)).toBe(false);
  });
});

describe("staticOutageSkip", () => {
  it("accepts a fresh outage failure on chat, mcp, slack and cron, custom agents included", () => {
    for (const trigger of ["chat", "mcp", "slack", "cron"]) {
      expect(staticOutageSkip(cand({ trigger }), NOW)).toBeNull();
    }
    expect(staticOutageSkip(cand({ agent_slug: "c-1a2b3c", trigger: "cron" }), NOW)).toBeNull();
  });

  it("refuses money-path slugs, other triggers, batch and conductor children, old and marked runs", () => {
    expect(staticOutageSkip(cand({ agent_slug: "performance-marketer" }), NOW)).toBe("money_path");
    expect(staticOutageSkip(cand({ trigger: "a2a" }), NOW)).toBe("trigger");
    expect(staticOutageSkip(cand({ batch_id: "b-1" }), NOW)).toBe("batch_child");
    expect(staticOutageSkip(cand({ payload: { build_conductor_run_id: "c-run" } }), NOW)).toBe("conductor_child");
    expect(staticOutageSkip(cand({ finished_at: "2026-10-20T23:00:00Z" }), NOW)).toBe("too_old");
    expect(staticOutageSkip(cand({ payload: { outage_retry: { state: "requeued" } } }), NOW)).toBe("already_marked");
    expect(staticOutageSkip(cand({ error: "fetch failed" }), NOW)).toBe("not_outage");
  });
});

describe("providerRecoveredSince", () => {
  const ok = (rows: Parameters<typeof classifyUsageLimitStatus>[0]) =>
    classifyUsageLimitStatus(rows, (e) => isProviderOutageError(e));
  const row = (status: string, error: string | null, finished_at: string) => ({
    id: finished_at,
    agent_slug: "x",
    tenant_id: "t",
    status,
    error,
    finished_at,
  });

  it("needs a success after the failure AND after the latest outage failure", () => {
    const failedAt = "2026-10-21T10:00:00Z";
    expect(providerRecoveredSince(failedAt, ok([row("dispatch_error", SEAT, failedAt), row("success", null, "2026-10-21T10:30:00Z")]))).toBe(true);
    expect(providerRecoveredSince(failedAt, ok([row("success", null, "2026-10-21T09:00:00Z"), row("dispatch_error", SEAT, failedAt)]))).toBe(false);
    expect(
      providerRecoveredSince(
        failedAt,
        ok([row("dispatch_error", SEAT, failedAt), row("success", null, "2026-10-21T10:30:00Z"), row("dispatch_error", LIMIT, "2026-10-21T10:40:00Z")]),
      ),
    ).toBe(false);
    expect(providerRecoveredSince(failedAt, ok([]))).toBe(false);
  });
});

describe("supersessionKey", () => {
  it("keys chat by thread, slack by thread, custom cron by trigger; MCP has none", () => {
    expect(supersessionKey(cand())).toEqual({ kind: "thread", thread_id: "th-1" });
    expect(
      supersessionKey(cand({ trigger: "slack", payload: { slack: { channel_id: "C1", thread_ts: "1.2", event_id: "Ev1" } } })),
    ).toEqual({ kind: "slack", channel_id: "C1", thread_ts: "1.2" });
    expect(supersessionKey(cand({ trigger: "cron", agent_slug: "c-1", custom_trigger_id: "tr-1" }))).toEqual({
      kind: "custom_trigger",
      trigger_id: "tr-1",
    });
    expect(supersessionKey(cand({ trigger: "cron", agent_slug: "pm" }))).toEqual({ kind: "agent" });
    expect(supersessionKey(cand({ trigger: "mcp" }))).toBeNull();
  });
});

type Q = { table: string; filters: Array<[string, ...unknown[]]> };

function makeSvc(opts: {
  candidates: OutageCandidate[];
  lastSuccessAt: string | null;
  failures?: Array<{ status: string; error: string; finished_at: string }>;
  events?: Array<{ stage: string; meta: unknown }>;
  eventsError?: boolean;
  newerRunFor?: Set<string>;
  rpc?: (name: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null };
}) {
  const queries: Q[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  function resolve(q: Q): unknown[] {
    const has = (op: string, col: string) => q.filters.find((f) => f[0] === op && f[1] === col);
    if (q.table === "agent_run_events") return opts.events ?? [];
    if (["decisions", "run_artifacts", "channel_actions", "agent_tool_effects"].includes(q.table)) return [];
    if (q.table === "agent_runs") {
      if (has("eq", "parent_run_id")) return [];
      const neq = has("neq", "id");
      if (neq) return opts.newerRunFor?.has(neq[2] as string) ? [{ id: "newer" }] : [];
      const status = has("eq", "status");
      if (status && status[2] === "success") {
        return opts.lastSuccessAt
          ? [{ id: "s", agent_slug: "x", tenant_id: "t", status: "success", error: null, finished_at: opts.lastSuccessAt }]
          : [];
      }
      if (has("is", "payload->outage_retry")) return opts.candidates;
      return (opts.failures ?? []).map((f, i) => ({ id: `f${i}`, agent_slug: "x", tenant_id: "t", ...f }));
    }
    return [];
  }
  const svc = {
    from(table: string) {
      const q: Q = { table, filters: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "neq", "in", "is", "not", "gt", "gte", "lt", "or", "order", "limit"]) {
        b[op] = (...args: unknown[]) => {
          q.filters.push([op, ...args]);
          return b;
        };
      }
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(
          q.table === "agent_run_events" && opts.eventsError
            ? { data: null, error: { message: "boom" } }
            : { data: resolve(q), error: null },
        ).then(res, rej);
      return b;
    },
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (opts.rpc) return opts.rpc(name, args);
      return { data: name === "requeue_outage_retry" ? "requeued" : true, error: null };
    }),
  };
  return { svc: svc as never, queries, rpcCalls };
}

function deps(svc: never) {
  const sent: unknown[] = [];
  const logs: Array<{ code: string; stage?: string }> = [];
  return {
    sent,
    logs,
    d: {
      svc,
      send: async (ev: unknown) => {
        sent.push(ev);
      },
      slackClaimId: (event_id: string, run_id: string) => `${event_id}|${run_id}`,
      log: async (e: { code: string; stage?: string }) => {
        logs.push(e);
      },
      now: () => NOW,
    },
  };
}

describe("runOutageRetrySweep", () => {
  it("waits while the provider has not recovered: no requeue, no mark", async () => {
    const { svc, rpcCalls } = makeSvc({ candidates: [cand()], lastSuccessAt: "2026-10-21T09:00:00Z" });
    const { d, sent } = deps(svc);
    const out = await runOutageRetrySweep(d);
    expect(out).toMatchObject({ requeued: 0, waiting: 1, skipped: 0 });
    expect(rpcCalls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("requeues the same run once after recovery, with a fresh attempt-scoped event on the interactive lane", async () => {
    const { svc, rpcCalls } = makeSvc({ candidates: [cand()], lastSuccessAt: "2026-10-21T11:00:00Z" });
    const { d, sent, logs } = deps(svc);
    const out = await runOutageRetrySweep(d);
    expect(out.requeued).toBe(1);
    expect(rpcCalls[0].name).toBe("requeue_outage_retry");
    expect(rpcCalls[0].args).toMatchObject({
      p_tenant_id: "ten-1",
      p_run_id: "run-1",
      p_expected_status: "dispatch_error",
      p_expected_retry_count: 0,
      p_expected_finished_at: "2026-10-21T10:00:00Z",
      p_slack_claim_ids: [],
    });
    expect((rpcCalls[0].args.p_marker as Record<string, unknown>)).toMatchObject({ state: "requeued", failure_class: "seat", attempt: 1 });
    expect(sent).toEqual([
      expect.objectContaining({ id: "run-1-infra-retry-1", name: "agent.run.requested", data: expect.objectContaining({ run_id: "run-1", lane: "interactive" }) }),
    ]);
    expect(logs.map((l) => l.code)).toContain("outage_retry_requeued");
  });

  it("reopens the Slack reply claim for a Slack run", async () => {
    const row = cand({ trigger: "slack", payload: { slack: { channel_id: "C1", thread_ts: "1.2", event_id: "Ev1" } } });
    const { svc, rpcCalls } = makeSvc({ candidates: [row], lastSuccessAt: "2026-10-21T11:00:00Z" });
    await runOutageRetrySweep(deps(svc).d);
    expect(rpcCalls[0].args.p_slack_claim_ids).toEqual(["Ev1|run-1"]);
  });

  it("marks a run that used a real tool, and never requeues it", async () => {
    const { svc, rpcCalls } = makeSvc({
      candidates: [cand()],
      lastSuccessAt: "2026-10-21T11:00:00Z",
      events: [{ stage: "tool_use_started", meta: { tool_name: "mcp__server__meta_ads__update_budget" } }],
    });
    const { d, sent } = deps(svc);
    const out = await runOutageRetrySweep(d);
    expect(out.skipped).toBe(1);
    expect(rpcCalls.map((c) => c.name)).toEqual(["mark_outage_retry_skipped"]);
    expect((rpcCalls[0].args.p_marker as Record<string, unknown>).reason).toBe("observed_execution");
    expect(sent).toHaveLength(0);
  });

  it("requeues when the only tool events are the heartbeat and run-agent's nameless dispatch error", async () => {
    const { svc, rpcCalls } = makeSvc({
      candidates: [cand()],
      lastSuccessAt: "2026-10-21T11:00:00Z",
      events: [
        { stage: "tool_use_completed", meta: { tool_name: "assistant_turn", iter: 3 } },
        { stage: "tool_use_errored", meta: { code: "dispatch:Claude Code returned an error result: Your organization" } },
      ],
    });
    await runOutageRetrySweep(deps(svc).d);
    expect(rpcCalls.map((c) => c.name)).toEqual(["requeue_outage_retry"]);
  });

  it.each([
    ["a nameless started event", { stage: "tool_use_started", meta: {} }],
    ["a nameless completed event", { stage: "tool_use_completed", meta: { ms: 5 } }],
    ["a nameless error that is not the dispatch error", { stage: "tool_use_errored", meta: { code: "err" } }],
  ])("fails closed on %s: counted as a tool, never requeued", async (_label, ev) => {
    const { svc, rpcCalls } = makeSvc({ candidates: [cand()], lastSuccessAt: "2026-10-21T11:00:00Z", events: [ev] });
    const { d, sent } = deps(svc);
    await runOutageRetrySweep(d);
    expect(sent).toHaveLength(0);
    expect(rpcCalls.map((c) => c.name)).toEqual(["mark_outage_retry_skipped"]);
  });

  it("refuses the retry when the event read fails (no requeue, no mark; judged again next tick)", async () => {
    const { svc, rpcCalls } = makeSvc({ candidates: [cand()], lastSuccessAt: "2026-10-21T11:00:00Z", eventsError: true });
    const { d, sent, logs } = deps(svc);
    const out = await runOutageRetrySweep(d);
    expect(out.errors).toBe(1);
    expect(sent).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
    expect(logs.map((l) => l.code)).toContain("outage_retry_failed");
  });

  it("marks a run the founder already replaced with a newer one", async () => {
    const { svc, rpcCalls } = makeSvc({
      candidates: [cand()],
      lastSuccessAt: "2026-10-21T11:00:00Z",
      newerRunFor: new Set(["run-1"]),
    });
    await runOutageRetrySweep(deps(svc).d);
    expect(rpcCalls.map((c) => c.name)).toEqual(["mark_outage_retry_skipped"]);
    expect((rpcCalls[0].args.p_marker as Record<string, unknown>).reason).toBe("superseded");
  });

  it("a tenant that cannot pay is marked skipped (the credit trigger rolled the requeue back)", async () => {
    const { svc, rpcCalls } = makeSvc({
      candidates: [cand()],
      lastSuccessAt: "2026-10-21T11:00:00Z",
      rpc: (name) =>
        name === "requeue_outage_retry" ? { data: null, error: { message: "insufficient_credits" } } : { data: true, error: null },
    });
    const { d, sent } = deps(svc);
    const out = await runOutageRetrySweep(d);
    expect(sent).toHaveLength(0);
    expect(out.skipped).toBe(1);
    expect(rpcCalls[1]).toMatchObject({ name: "mark_outage_retry_skipped" });
    expect((rpcCalls[1].args.p_marker as Record<string, unknown>).reason).toBe("insufficient_credits");
  });

  it("passes the supersession key so the RPC re-checks it inside the requeue", async () => {
    const { svc, rpcCalls } = makeSvc({ candidates: [cand()], lastSuccessAt: "2026-10-21T11:00:00Z" });
    await runOutageRetrySweep(deps(svc).d);
    expect(rpcCalls[0].args.p_supersession).toEqual({ kind: "thread", thread_id: "th-1" });
  });

  it.each(["tenant_disabled", "agent_hidden", "superseded"])(
    "an RPC refusal (%s) leaves the run as it failed, sends nothing, and marks it",
    async (reason) => {
      const { svc, rpcCalls } = makeSvc({
        candidates: [cand()],
        lastSuccessAt: "2026-10-21T11:00:00Z",
        rpc: (name) => (name === "requeue_outage_retry" ? { data: reason, error: null } : { data: true, error: null }),
      });
      const { d, sent } = deps(svc);
      const out = await runOutageRetrySweep(d);
      expect(sent).toHaveLength(0);
      expect(out.skipped).toBe(1);
      expect((rpcCalls[1].args.p_marker as Record<string, unknown>).reason).toBe(reason);
    },
  );

  it("unrelated failures that pass the loose prefilter cannot crowd out a real outage", async () => {
    const noise = Array.from({ length: 60 }, (_, i) =>
      cand({ id: `noise-${i}`, error: "github: 401 Bad credentials", payload: { thread_id: `n-${i}` } }),
    );
    const { svc, rpcCalls } = makeSvc({ candidates: [...noise, cand({ id: "real" })], lastSuccessAt: "2026-10-21T11:00:00Z" });
    const out = await runOutageRetrySweep(deps(svc).d);
    expect(out.requeued).toBe(1);
    expect(rpcCalls[0].args.p_run_id).toBe("real");
  });

  it("a lost CAS sends nothing", async () => {
    const { svc } = makeSvc({
      candidates: [cand()],
      lastSuccessAt: "2026-10-21T11:00:00Z",
      rpc: () => ({ data: "lost", error: null }),
    });
    const { d, sent } = deps(svc);
    const out = await runOutageRetrySweep(d);
    expect(out.requeued).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("money-path and non-outage rows are never touched", async () => {
    const { svc, rpcCalls } = makeSvc({
      candidates: [cand({ agent_slug: "dispute-response" }), cand({ id: "run-2", error: "fetch failed" })],
      lastSuccessAt: "2026-10-21T11:00:00Z",
    });
    const out = await runOutageRetrySweep(deps(svc).d);
    expect(out).toMatchObject({ requeued: 0, skipped: 0, waiting: 0 });
    expect(rpcCalls).toHaveLength(0);
  });

  it(`requeues at most ${OUTAGE_RETRY_PER_TICK} per sweep`, async () => {
    const many = Array.from({ length: OUTAGE_RETRY_PER_TICK + 3 }, (_, i) => cand({ id: `run-${i}`, payload: { thread_id: `th-${i}` } }));
    const { svc } = makeSvc({ candidates: many, lastSuccessAt: "2026-10-21T11:00:00Z" });
    const out = await runOutageRetrySweep(deps(svc).d);
    expect(out.requeued).toBe(OUTAGE_RETRY_PER_TICK);
    expect(out.waiting).toBe(3);
  });
});

describe("isRealToolEvent", () => {
  it("only the heartbeat and the run-level dispatch error are not tools", () => {
    expect(isRealToolEvent({ stage: "tool_use_completed", meta: { tool_name: "assistant_turn" } })).toBe(false);
    expect(isRealToolEvent({ stage: "tool_use_errored", meta: { code: "dispatch:boom" } })).toBe(false);
    expect(isRealToolEvent({ stage: "tool_use_completed", meta: { tool_name: "ToolSearch" } })).toBe(true);
    expect(isRealToolEvent({ stage: "tool_use_started", meta: { code: "dispatch:boom" } })).toBe(true);
    expect(isRealToolEvent({ stage: "tool_use_errored", meta: null })).toBe(true);
  });
});
