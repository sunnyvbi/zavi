
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "10000000-0000-4000-8000-000000000001";
const VALID_THREAD = "20000000-0000-4000-8000-000000000099";

const m = vi.hoisted(() => {
  type RunnableState =
    | { runnable: true; agent: unknown }
    | {
        runnable: false;
        reason:
          | "not_found"
          | "default_disabled"
          | "global_override_hide"
          | "tenant_hidden_override"
          | "staff_locked_hide"
          | "plan_upgrade_required";
        detail: string;
        required_tier?: string;
      };

  const state: {
    runnable: RunnableState;
    threadExisting: { id: string } | null;
  } = {
    runnable: { runnable: true, agent: { slug: "cto-engineer", metadata_praxis: { chat_eligible: true } } },
    threadExisting: null,
  };

  const TENANT_INNER = "00000000-0000-4000-8000-000000000001";
  const USER_INNER = "10000000-0000-4000-8000-000000000001";
  const VALID_THREAD_INNER = "20000000-0000-4000-8000-000000000099";

  const ensureAgentRunnable = vi.fn(async () => state.runnable);

  const loadAgentDefinition = vi.fn(async (slug: string) => {
    if (slug === "ghost") return null;
    return {
      slug,
      content_hash: "deadbeef",
      metadata_praxis: {},
      metadata: {},
    };
  });

  const canUserAccessAgent = vi.fn(async () => true);

  const requireAuth = vi.fn(async () => ({
    user_id: USER_INNER,
    tenant_id: TENANT_INNER,
    access_token: "fake-jwt",
  }));

  const threadsMaybeSingle = vi.fn(async () => ({
    data: state.threadExisting,
    error: null,
  }));
  function makeThreadsQuery() {
    const isDeleted = vi.fn(() => ({ maybeSingle: threadsMaybeSingle }));
    const eq4 = vi.fn(() => ({ is: isDeleted }));
    const eq3 = vi.fn(() => ({ eq: eq4 }));
    const eq2 = vi.fn(() => ({ eq: eq3 }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const select = vi.fn(() => ({ eq: eq1 }));
    return { select };
  }
  function makeAgentRunsQuery(): Record<string, unknown> {
    const terminal = { data: [] as unknown[], count: 0, error: null };
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (resolve: (v: typeof terminal) => unknown) =>
              resolve(terminal);
          }
          if (prop === "maybeSingle" || prop === "single")
            return async () => terminal;
          return () => proxy;
        },
      },
    );
    return proxy;
  }
  function makeGeneric(): Record<string, unknown> {
    const terminal = async () => ({ data: null, error: null });
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === "then") return undefined;
          if (prop === "maybeSingle" || prop === "single") return terminal;
          return () => proxy;
        },
      },
    );
    return proxy;
  }

  const svcFrom = vi.fn((table: string) => {
    if (table === "agent_threads") return makeThreadsQuery();
    if (table === "agent_runs") return makeAgentRunsQuery();
    return makeGeneric();
  });
  const serviceClient = vi.fn(() => ({ from: svcFrom }));

  const bearerRpc = vi.fn(async () => ({
    data: [
      {
        thread_id: VALID_THREAD_INNER,
        user_message_id: "30000000-0000-4000-8000-000000000001",
        run_id: "40000000-0000-4000-8000-000000000001",
      },
    ],
    error: null,
  }));
  const serverClientFromBearer = vi.fn(() => ({
    rpc: bearerRpc,
    from: vi.fn(() => makeGeneric()),
  }));

  const inngestSend = vi.fn(async () => ({ ids: [] }));
  const parseRepoPickReply = vi.fn(() => null);
  const dispatchDeterministicConfirm = vi.fn(async () => ({ ok: false }));
  const decomposeMessage = vi.fn(async () => null);
  const dispatchBatchFanout = vi.fn(async () => undefined);

  return {
    state,
    ensureAgentRunnable,
    loadAgentDefinition,
    canUserAccessAgent,
    requireAuth,
    serviceClient,
    serverClientFromBearer,
    bearerRpc,
    threadsMaybeSingle,
    svcFrom,
    inngestSend,
    parseRepoPickReply,
    dispatchDeterministicConfirm,
    decomposeMessage,
    dispatchBatchFanout,
  };
});

vi.mock("@/services/agents/ensure-runnable", () => ({
  ensureAgentRunnable: m.ensureAgentRunnable,
}));

vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: m.loadAgentDefinition,
  listAgents: vi.fn(() => []),
  getAgentDefaultState: vi.fn(() => "enabled"),
  listAlwaysOnSlugs: vi.fn(() => []),
  listDefaultDisabledSlugs: vi.fn(() => []),
}));

vi.mock("@/services/auth/members", () => ({
  canUserAccessAgent: m.canUserAccessAgent,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: m.requireAuth,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: m.serviceClient,
  serverClientFromBearer: m.serverClientFromBearer,
}));

vi.mock("@/../workers/client", () => ({
  inngest: { send: m.inngestSend },
}));

vi.mock("@/services/sandbox/repo-picker", () => ({
  parseRepoPickReply: m.parseRepoPickReply,
}));

vi.mock("@/services/agents/qa-confirm-service", () => ({
  dispatchDeterministicConfirm: m.dispatchDeterministicConfirm,
}));

vi.mock("@/agents/engineer/decompose", () => ({
  decomposeMessage: m.decomposeMessage,
}));

vi.mock("@/services/agents/batch-fanout-dispatcher", () => ({
  dispatchBatchFanout: m.dispatchBatchFanout,
}));

import { agentChatSend } from "../../routes/agents/chat-send";

function mkRes(): { res: Response; status: () => number; body: () => unknown } {
  let _s = 200;
  let _b: unknown = null;
  const res = {
    status(c: number) {
      _s = c;
      return res;
    },
    json(b: unknown) {
      _b = b;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => _s, body: () => _b };
}

function mkReq(slug: string, body: Record<string, unknown>): Request {
  return { params: { slug }, body } as unknown as Request;
}

beforeEach(() => {
  m.state.runnable = { runnable: true, agent: { slug: "cto-engineer", metadata_praxis: { chat_eligible: true } } };
  m.state.threadExisting = null;
  m.ensureAgentRunnable.mockClear();
  m.loadAgentDefinition.mockClear();
  m.threadsMaybeSingle.mockClear();
  m.svcFrom.mockClear();
  m.serviceClient.mockClear();
  m.bearerRpc.mockClear();
  m.serverClientFromBearer.mockClear();
});

describe("POST /api/agents/:slug/chat — visibility gate (GAP D)", () => {
  it("default_disabled → 403 with reason as code, RPC not called", async () => {
    m.state.runnable = {
      runnable: false,
      reason: "default_disabled",
      detail: 'agent "advisor" not visible for tenant',
    };
    const { res, status, body } = mkRes();
    await agentChatSend(mkReq("advisor", { message: "hi" }), res);
    expect(status()).toBe(403);
    expect((body() as { error: { code: string } }).error.code).toBe(
      "default_disabled",
    );
    expect(m.bearerRpc).not.toHaveBeenCalled();
  });

  it("DB-level failure inside ensureAgentRunnable → 500 internal", async () => {
    m.ensureAgentRunnable.mockImplementationOnce(async () => {
      throw new Error("supabase unreachable");
    });
    const { res, status, body } = mkRes();
    await agentChatSend(mkReq("cto-engineer", { message: "hi" }), res);
    expect(status()).toBe(500);
    expect((body() as { error: { code: string } }).error.code).toBe("internal");
    expect(m.bearerRpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/agents/:slug/chat — foreign thread_id 4-predicate (GAP F)", () => {
  it("foreign thread_id (existing=null) → 404 thread_not_found, RPC not called", async () => {
    m.state.threadExisting = null;
    const { res, status, body } = mkRes();
    await agentChatSend(
      mkReq("cto-engineer", {
        message: "please investigate this issue",
        thread_id: "50000000-0000-4000-8000-000000000001",
      }),
      res,
    );
    expect(status()).toBe(404);
    expect((body() as { error: { code: string } }).error.code).toBe(
      "thread_not_found",
    );
    expect(m.bearerRpc).not.toHaveBeenCalled();
  });

  it("valid own thread → pre-check passes, reaches RPC (positive control)", async () => {
    m.state.threadExisting = { id: VALID_THREAD };
    const { res, status } = mkRes();
    await agentChatSend(
      mkReq("cto-engineer", {
        message: "please investigate this issue",
        thread_id: VALID_THREAD,
      }),
      res,
    );
    expect(m.bearerRpc).toHaveBeenCalled();
    expect(status()).not.toBe(404);
    expect(status()).not.toBe(403);
  });

  it("no thread_id (first-turn) → pre-check skipped, reaches RPC", async () => {
    m.state.threadExisting = null;
    const { res, status } = mkRes();
    await agentChatSend(mkReq("cto-engineer", { message: "first turn" }), res);
    expect(m.bearerRpc).toHaveBeenCalled();
    expect(status()).not.toBe(404);
  });
});

describe("POST /api/agents/:slug/chat — three-tier pricing", () => {
  it("TS gate plan_upgrade_required → 403 with the upgrade body, RPC not called", async () => {
    m.state.runnable = {
      runnable: false,
      reason: "plan_upgrade_required",
      required_tier: "pro",
      detail: "Meta Ads needs the Pro plan ($240/mo).",
    };
    const { res, status, body } = mkRes();
    await agentChatSend(mkReq("meta_ads", { message: "hi" }), res);
    expect(status()).toBe(403);
    expect(body()).toEqual({
      error: {
        code: "plan_upgrade_required",
        required_tier: "pro",
        message: "Meta Ads needs the Pro plan ($240/mo).",
      },
    });
    expect(m.bearerRpc).not.toHaveBeenCalled();
  });

  it("DB trigger raise inside the chat-turn RPC → 403 with the tier from details", async () => {
    m.bearerRpc.mockImplementationOnce(async () => ({
      data: null,
      error: { message: "plan_upgrade_required", details: "starter" },
    }) as never);
    const { res, status, body } = mkRes();
    await agentChatSend(mkReq("cto-engineer", { message: "first turn" }), res);
    expect(status()).toBe(403);
    expect((body() as { error: { code: string; required_tier: string } }).error).toMatchObject({
      code: "plan_upgrade_required",
      required_tier: "starter",
    });
  });
});

void TENANT;
void USER;
