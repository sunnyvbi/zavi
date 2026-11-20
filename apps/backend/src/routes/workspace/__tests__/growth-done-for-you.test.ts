import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "11111111-1111-4111-8111-111111111111";
const ACTION = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";

const s = vi.hoisted(() => ({
  auth: null as null | { tenant_id: string; user_id: string; tenant_overridden?: boolean },
  enabled: true as boolean | Error,
  deferred: false,
  tier: "free" as string | Error,
  runs: [] as Array<Record<string, unknown>>,
  card: null as null | Record<string, unknown>,
  artifacts: [] as Array<Record<string, unknown>>,
  reads: [] as Array<{ table: string; filters: Array<[string, string, unknown]> }>,
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  settleWins: true,
  cardRpc: { ok: true } as Record<string, unknown>,
  engineCalls: [] as unknown[][],
  engineResult: { ok: true, run_id: "run-new", duplicate: false } as Record<string, unknown>,
  locked: false,
  stops: [] as string[],
  tracked: [] as Array<{ event: string; args: Record<string, unknown> }>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (s.auth) return s.auth;
    res.status(401).json({ error: { code: "unauthenticated" } });
    return null;
  }),
}));
function builder(table: string) {
  const read = { table, filters: [] as Array<[string, string, unknown]> };
  s.reads.push(read);
  const q: Record<string, unknown> = {};
  const rec = (op: string) => (col: string, val: unknown) => {
    read.filters.push([op, col, val]);
    return q;
  };
  for (const op of ["eq", "in", "like"]) q[op] = rec(op);
  for (const op of ["select", "order", "limit"]) q[op] = () => q;
  const data = () => (table === "agent_runs" ? s.runs : table === "run_artifacts" ? s.artifacts : table === "channel_actions" ? s.card : []);
  q.maybeSingle = async () => {
    if (table === "agent_runs") {
      const key = read.filters.find((f) => f[1] === "cron_dedupe_key")?.[2];
      return { data: s.runs.find((r) => r.cron_dedupe_key === key) ?? null, error: null };
    }
    return { data: data(), error: null };
  };
  q.then = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) => Promise.resolve({ data: data(), error: null }).then(r, j);
  return q;
}
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (t: string) => {
    if (t !== T) throw new Error("wrong tenant");
    return { from: builder };
  },
  tenantRpc: async (tid: string, fn: string, args: Record<string, unknown>) => {
    if (tid !== T) throw new Error("wrong tenant");
    s.rpc.push({ fn, args });
    if (fn === "claim_done_for_you_settle") {
      const won = s.settleWins;
      s.settleWins = false;
      return { data: won, error: null };
    }
    return { data: s.cardRpc, error: null };
  },
}));
vi.mock("@/services/settings", () => ({
  getBoolSettingStrictResolved: async () => {
    if (s.enabled instanceof Error) throw s.enabled;
    return s.enabled;
  },
}));
vi.mock("@/services/agents/entitlement", () => ({
  loadTierGateConfig: async () => ({ enforced: true, agentMin: undefined, alwaysPro: undefined, proTenants: [], deferred: s.deferred }),
  resolveTenantTier: async () => {
    if (s.tier instanceof Error) throw s.tier;
    return s.tier;
  },
}));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn() }));
vi.mock("@/services/agents/request-stop", () => ({
  requestStopForRun: vi.fn(async (_sc: unknown, _t: string, run: string) => {
    s.stops.push(run);
    for (const r of s.runs) if (r.id === run && r.status === "queued") r.status = "cancelled";
    return { ok: true, cancelling: true };
  }),
}));
vi.mock("@/services/channels/engine", () => ({
  runChannelRecipe: vi.fn(async (...args: unknown[]) => {
    s.engineCalls.push(args);
    return s.engineResult;
  }),
}));
vi.mock("@/services/channels/context", () => ({ defaultChannelContext: vi.fn() }));
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: async () => s.locked }));
vi.mock("@/services/channels/recipe", () => ({ recipeExists: () => true }));
vi.mock("@/services/analytics/action-events", () => ({
  trackDoneForYou: (event: string, args: Record<string, unknown>) => s.tracked.push({ event, args }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));

import { getDoneForYou, postDoneForYou } from "../growth-done-for-you";
import { doneForYouKey } from "@/services/billing/tiers";

type MockRes = Response & { statusCode: number; body: unknown };
function mockRes(): MockRes {
  const res = { statusCode: 200, body: undefined as unknown } as unknown as MockRes;
  (res as unknown as { status: unknown }).status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  (res as unknown as { json: unknown }).json = vi.fn((b: unknown) => {
    res.body = b;
    return res;
  });
  return res;
}
const post = async (body: Record<string, unknown> = { action_id: ACTION, request_id: "req-123456" }) => {
  const res = mockRes();
  await postDoneForYou({ body } as Request, res);
  return res;
};
const get = async () => {
  const res = mockRes();
  await getDoneForYou({} as Request, res);
  return res;
};
const code = (res: { body: unknown }) => (res.body as { error?: { code?: string; reason?: string } }).error;

const run = (n: number, over: Record<string, unknown> = {}) => ({
  id: `run-${n}`,
  cron_dedupe_key: doneForYouKey(T, n),
  trigger: "channel_recipe",
  enqueued_by: null,
  status: "success",
  enqueued_at: new Date().toISOString(),
  channel_slug: "seo",
  dfy: { action_id: ACTION, attempt: n, mode: "research", by_user_id: USER },
  parsed: { rendered_markdown: "Google reads /pricing. Next: add an FAQ block to it.", steps: [{ title: "Readable", body: "x" }] },
  output_text: null,
  ...over,
});

beforeEach(() => {
  s.auth = { tenant_id: T, user_id: USER };
  s.enabled = true;
  s.deferred = false;
  s.tier = "free";
  s.runs = [];
  s.card = {
    id: ACTION,
    channel_slug: "seo",
    status: "pending",
    snoozed_until: null,
    exec_class: null,
    exec_status: null,
    card_kind: "task",
    body: { step: { title: "Check /pricing", body: "Google may not read it" } },
  };
  s.artifacts = [];
  s.reads = [];
  s.rpc = [];
  s.settleWins = true;
  s.cardRpc = { ok: true };
  s.engineCalls = [];
  s.engineResult = { ok: true, run_id: "run-new", duplicate: false };
  s.locked = false;
  s.stops = [];
  s.tracked = [];
});

describe("POST done-for-you: refusals", () => {
  it("refuses an overridden tenant, the flag off, an unreadable tier, a paid plan", async () => {
    s.auth = { tenant_id: T, user_id: USER, tenant_overridden: true };
    expect(code(await post())?.code).toBe("tenant_override_forbidden");
    s.auth = { tenant_id: T, user_id: USER };
    s.enabled = false;
    expect(code(await post())?.code).toBe("dfy_off");
    s.enabled = new Error("db");
    expect((await post()).statusCode).toBe(503);
    s.enabled = true;
    s.deferred = true;
    expect(code(await post())?.code).toBe("tier_unreadable");
    s.deferred = false;
    s.tier = new Error("db");
    expect(code(await post())?.code).toBe("tier_unreadable");
    s.tier = "starter";
    expect(code(await post())?.code).toBe("not_free");
    expect(s.engineCalls).toHaveLength(0);
  });

  it("another tenant's card reads as missing; an ineligible card is refused with its reason", async () => {
    s.card = null;
    const r = await post();
    expect(r.statusCode).toBe(404);
    for (const read of s.reads) expect(read.filters).toContainEqual(["eq", "tenant_id", T]);
    s.card = { id: ACTION, channel_slug: "x_organic", status: "pending", exec_class: null, exec_status: null, card_kind: "post", body: { step: {} } };
    const r2 = await post();
    expect(code(r2)).toMatchObject({ code: "dfy_not_eligible", reason: "needs_account" });
    s.card = { id: ACTION, channel_slug: "seo", status: "pending", exec_class: null, exec_status: null, card_kind: "task", body: { step: {} } };
    s.locked = true;
    expect(code(await post())).toMatchObject({ code: "dfy_not_eligible", reason: "channel_not_free_previewable" });
    expect(s.engineCalls).toHaveLength(0);
  });

  it("refuses once a task succeeded, and after three attempts", async () => {
    s.runs = [run(1)];
    expect(code(await post())?.code).toBe("dfy_used");
    s.runs = [1, 2, 3].map((n) => run(n, { status: "failed" }));
    expect(code(await post())?.code).toBe("dfy_used_up");
    expect(s.engineCalls).toHaveLength(0);
  });

  it("refuses a bad body", async () => {
    expect((await post({ action_id: "x", request_id: "short" })).statusCode).toBe(400);
  });
});

describe("POST done-for-you: start", () => {
  it("starts attempt 1 as a service-written channel run with a server-built redo and the key", async () => {
    const r = await post();
    expect(r.statusCode).toBe(202);
    expect(r.body).toMatchObject({ ok: true, run_id: "run-new", attempt: 1 });
    const [tenant, slug, , redo, extra, requestId] = s.engineCalls[0] as [string, string, unknown, Record<string, unknown>, Record<string, unknown>, string];
    expect(tenant).toBe(T);
    expect(slug).toBe("seo");
    expect(requestId).toBe(doneForYouKey(T, 1));
    expect(redo).toMatchObject({ action_key: ACTION, kind: "do" });
    expect(redo).not.toHaveProperty("redo_of_action_id");
    expect(String(redo.note)).toContain("Carry out this card yourself");
    expect(extra).toEqual({ done_for_you: { action_id: ACTION, attempt: 1, mode: "research", by_user_id: USER } });
    expect(s.tracked.map((t) => t.event)).toEqual(["dfy_approved"]);
    const { enqueueAgentRun } = await import("@/services/agents/runner");
    const deps = (s.engineCalls[0] as unknown[])[2] as { enqueue: (i: Record<string, unknown>) => Promise<unknown> };
    await deps.enqueue({ slug: "seo", tenant_id: T, payload: {} });
    expect(vi.mocked(enqueueAgentRun).mock.calls.at(-1)?.[0]).toMatchObject({ trigger: "channel_recipe", actor_user_id: USER });
  });

  it("a running attempt answers with its own run and starts nothing", async () => {
    s.runs = [run(1, { status: "running" })];
    const r = await post();
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ run_id: "run-1", attempt: 1 });
    expect(s.engineCalls).toHaveLength(0);
  });

  it("numbers the next attempt after a failure and after Can't do (on another card)", async () => {
    s.runs = [run(1, { status: "dispatch_error" })];
    await post();
    expect((s.engineCalls[0] as unknown[])[5]).toBe(doneForYouKey(T, 2));
    s.engineCalls = [];
    s.runs = [run(1, { parsed: { rendered_markdown: "Can't do: your sales numbers", steps: [] } })];
    const r = await post();
    expect(code(r)).toMatchObject({ code: "dfy_not_eligible", reason: "cannot_do_before" });
  });

  it("cancels a stale queued attempt, then starts the next one", async () => {
    s.runs = [run(1, { status: "queued", enqueued_at: new Date(Date.now() - 31 * 60_000).toISOString() })];
    const r = await post();
    expect(r.statusCode).toBe(202);
    expect(s.stops).toEqual(["run-1"]);
    expect((s.engineCalls[0] as unknown[])[5]).toBe(doneForYouKey(T, 2));
  });

  it("a stale attempt still running is stopped, and the next one waits until it has ended", async () => {
    s.runs = [run(1, { status: "running", enqueued_at: new Date(Date.now() - 31 * 60_000).toISOString() })];
    const r = await post();
    expect(code(r)?.code).toBe("dfy_finishing");
    expect(s.stops).toEqual(["run-1"]);
    expect(s.engineCalls).toHaveLength(0);
  });

  it("a stale attempt that finished meanwhile is read again: its success is the task", async () => {
    s.runs = [run(1, { status: "running", enqueued_at: new Date(Date.now() - 31 * 60_000).toISOString() })];
    const { requestStopForRun } = await import("@/services/agents/request-stop");
    vi.mocked(requestStopForRun).mockImplementationOnce(async () => {
      s.runs[0].status = "success";
      return { ok: true, already_terminal: true };
    });
    expect(code(await post())?.code).toBe("dfy_used");
    expect(s.engineCalls).toHaveLength(0);
  });

  it("a race on the key answers with the run that holds it", async () => {
    s.engineResult = { ok: false, reason: "budget_unavailable", message: "x" };
    s.runs = [];
    const { runChannelRecipe } = await import("@/services/channels/engine");
    vi.mocked(runChannelRecipe).mockImplementationOnce(async (...args: unknown[]) => {
      s.engineCalls.push(args);
      s.runs = [run(1, { id: "run-other", status: "queued" })];
      return s.engineResult as never;
    });
    const r = await post();
    expect(r.statusCode).toBe(202);
    expect(r.body).toMatchObject({ run_id: "run-other", duplicate: true });
  });

  it("a channel the founder stopped is refused", async () => {
    s.engineResult = { ok: false, reason: "founder_stopped", message: "You stopped SEO." };
    expect(code(await post())?.code).toBe("founder_stopped");
  });
});

describe("GET done-for-you: settle once", () => {
  it("marks the card done once, by the presser, and sends dfy_executed once", async () => {
    s.runs = [run(1)];
    s.artifacts = [{ id: "img-1", mime: "image/png" }];
    const r = await get();
    expect(r.body).toMatchObject({ state: "done", run_id: "run-1", action_id: ACTION, result: { images: [{ id: "img-1" }] } });
    const mark = s.rpc.find((c) => c.fn === "set_channel_action");
    expect(mark?.args).toMatchObject({ p_action_id: ACTION, p_status: "acted", p_note: "Done by Zavi", p_event_key: "dfy:run-1", p_actor_user_id: USER });
    expect(s.tracked.map((t) => t.event)).toEqual(["dfy_executed"]);
    await get();
    expect(s.tracked.map((t) => t.event)).toEqual(["dfy_executed"]);
  });

  it("a presser who left: the card is marked with no actor", async () => {
    s.runs = [run(1)];
    let calls = 0;
    s.cardRpc = { ok: false, code: "not_found" };
    const orig = s.rpc;
    void orig;
    await get();
    const marks = s.rpc.filter((c) => c.fn === "set_channel_action");
    calls = marks.length;
    expect(calls).toBe(2);
    expect(marks[1].args.p_actor_user_id).toBeNull();
  });

  it("a failed attempt settles as dfy_failed and marks nothing; can't do reports the reason", async () => {
    s.runs = [run(1, { status: "failed" })];
    const r = await get();
    expect(r.body).toMatchObject({ state: "available", last_outcome: "failed", result: null });
    expect(s.rpc.some((c) => c.fn === "set_channel_action")).toBe(false);
    expect(s.tracked.map((t) => t.event)).toEqual(["dfy_failed"]);
    s.tracked = [];
    s.settleWins = true;
    s.runs = [run(1, { parsed: { rendered_markdown: "Can't do: your login", steps: [] } })];
    const r2 = await get();
    expect(r2.body).toMatchObject({ state: "available", last_outcome: "cannot_do" });
    expect(s.tracked.map((t) => t.event)).toEqual(["dfy_cannot_do"]);
  });

  it("a running attempt is not settled", async () => {
    s.runs = [run(1, { status: "running" })];
    const r = await get();
    expect(r.body).toMatchObject({ state: "running" });
    expect(s.rpc).toHaveLength(0);
  });

  it("an upgraded workspace still sees its result; one that never used it sees unavailable", async () => {
    s.tier = "starter";
    s.runs = [run(1)];
    expect((await get()).body).toMatchObject({ state: "done" });
    s.runs = [];
    expect((await get()).body).toMatchObject({ state: "unavailable" });
  });
});
