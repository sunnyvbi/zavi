import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const T1 = "00000000-0000-0000-0000-000000000001";
const U1 = "10000000-0000-0000-0000-000000000001";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";

type SendTurnResult = { thread_id: string; user_message_id: string; run_id: string };

const {
  authState,
  bearerState,
  serviceState,
  defState,
  inngestState,
  allowlistState,
  decomposeState,
} = vi.hoisted(() => {
  const TT1 = "00000000-0000-0000-0000-000000000001";
  const UU1 = "10000000-0000-0000-0000-000000000001";
  return {
    authState: {
      value: { user_id: UU1, tenant_id: TT1, access_token: "fake-jwt" } as
        | { user_id: string; tenant_id: string; access_token: string }
        | null,
    },
    bearerState: {
      rpcReturn: {
        data: [
          {
            thread_id: "11111111-1111-1111-1111-111111111111",
            user_message_id: "22222222-2222-2222-2222-222222222222",
            run_id: "33333333-3333-3333-3333-333333333333",
          },
        ] as SendTurnResult[],
        error: null as { message: string } | null,
      },
      rpcCalls: [] as Array<{ name: string; args: unknown }>,
    },
    serviceState: {
      priorAssistant: null as
        | { meta: Record<string, unknown>; agent_run_id: string | null; id: string }
        | null,
      thread: { user_id: UU1, agent_slug: "engineer" } as
        | { user_id: string; agent_slug: string }
        | null,
      inserts: {
        agent_run_batches: [] as Array<Record<string, unknown>>,
        agent_thread_messages: [] as Array<Record<string, unknown>>,
        agent_threads: [] as Array<Record<string, unknown>>,
      },
      connectorMeta: null as
        | {
            installation_id?: number | null;
            repo_full_names: string[];
            default_repo_full_name: string | null;
          }
        | null,
      createdThreadId: "99999999-9999-9999-9999-999999999999",
      serviceRpcCalls: [] as Array<{ name: string; args: unknown }>,
    },
    defState: {
      def: {
        slug: "engineer",
        content_hash: "abc123",
        metadata_praxis: { requires_sandbox: true },
      } as {
        slug: string;
        content_hash: string;
        metadata_praxis: { requires_sandbox: boolean };
      } | null,
    },
    inngestState: { sentEvents: [] as unknown[] },
    allowlistState: { allowed: false },
    decomposeState: {
      result: { kind: "single" } as
        | { kind: "single" }
        | { kind: "multi"; tasks: Array<{ title: string; task_description: string }> },
      callCount: 0,
    },
  };
});

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (!authState.value) {
      res.status(401).json({ error: { code: "unauthenticated" } });
    }
    return authState.value;
  }),
}));

vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: vi.fn(async () => defState.def),
}));

vi.mock("@/services/agents/ensure-runnable", () => ({
  ensureAgentRunnable: vi.fn(async () => ({
    runnable: true,
    agent: { slug: "engineer", content_hash: "deadbeef" },
  })),
}));

vi.mock("@/services/sandbox/repo-picker", () => ({
  parseRepoPickReply: vi.fn(() => null),
  pickRepoForTask: vi.fn(
    async ({ task_description }: { task_description: string }) => {
      if (/admin/i.test(task_description))
        return { decision: "pick", repo: "rravi149/adminIosApp" };
      if (/backend|api/i.test(task_description))
        return { decision: "pick", repo: "rravi149/upcar" };
      return { decision: "ask", message: "which repo?" };
    },
  ),
}));

vi.mock("@/services/auth/members", () => ({
  canUserAccessAgent: vi.fn(async () => true),
}));

vi.mock("@/services/agents/qa-confirm-service", () => ({
  dispatchDeterministicConfirm: vi.fn(async () => ({ handled: false })),
}));

vi.mock("@/agents/engineer/ship-gate", () => ({
  evaluateCtoShipGate: vi.fn(() => ({ shippable: true })),
  shipBlockExplanation: vi.fn(() => ""),
}));

vi.mock("@/agents/engineer/decompose", () => ({
  decomposeMessage: vi.fn(async () => {
    decomposeState.callCount += 1;
    return decomposeState.result;
  }),
  MAX_TASKS: 4,
}));

vi.mock("@/services/agents/batch-fanout-allowlist", () => ({
  isBatchFanoutAllowlisted: vi.fn(async () => allowlistState.allowed),
}));

function bearerClientStub(): unknown {
  return {
    from(_table: string) {
      const inner = {
        select(_cols: string) {
          return inner;
        },
        eq(_col: string, _val: unknown) {
          return inner;
        },
        in(_col: string, _vals: unknown[]) {
          return inner;
        },
        is(_col: string, _val: unknown) {
          return inner;
        },
        order(_col: string, _opts: unknown) {
          return inner;
        },
        limit(_n: number) {
          return inner;
        },
        async maybeSingle() {
          return { data: null, error: null };
        },
      };
      return inner;
    },
    rpc(name: string, args: unknown) {
      bearerState.rpcCalls.push({ name, args });
      if (name === "send_agent_chat_turn") {
        return Promise.resolve(bearerState.rpcReturn);
      }
      if (name === "emit_decision") {
        return Promise.resolve({ data: "deadbeef-0000-0000-0000-000000000001", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function serviceClientStub(): unknown {
  return {
    from(table: string) {
      const builder = {
        select(_cols: string) {
          const inner = {
            eq(_col: string, _val: unknown) {
              return inner;
            },
            in(_col: string, _vals: unknown[]) {
              return inner;
            },
            order(_col: string, _opts: unknown) {
              return inner;
            },
            limit(_n: number) {
              return inner;
            },
            filter(_col: string, _op: string, _val: unknown) {
              return inner;
            },
            neq(_col: string, _val: unknown) {
              return inner;
            },
            is(_col: string, _val: unknown) {
              return inner;
            },
            then(resolve: (v: { data: unknown[]; error: null; count?: number | null }) => void) {
              resolve({ data: [], error: null, count: 0 });
            },
            async maybeSingle() {
              if (table === "agent_thread_messages") {
                return { data: serviceState.priorAssistant, error: null };
              }
              if (table === "agent_threads") {
                return { data: serviceState.thread, error: null };
              }
              if (table === "connector_metadata") {
                return { data: serviceState.connectorMeta, error: null };
              }
              if (table === "decisions" && _cols === "decision_class, handler") {
                return { data: { decision_class: "engineer.ship-pr", handler: null }, error: null };
              }
              return { data: null, error: null };
            },
          };
          return inner;
        },
        insert(row: Record<string, unknown>) {
          if (table === "agent_run_batches") {
            serviceState.inserts.agent_run_batches.push(row);
          } else if (table === "agent_thread_messages") {
            serviceState.inserts.agent_thread_messages.push(row);
          } else if (table === "agent_threads") {
            serviceState.inserts.agent_threads.push(row);
          }
          return {
            then(resolve: (v: { error: null }) => void) {
              resolve({ error: null });
            },
            select(_cols: string) {
              return {
                async single() {
                  return {
                    data: { id: serviceState.createdThreadId },
                    error: null,
                  };
                },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          const inner = {
            eq(_col: string, _val: unknown) {
              return inner;
            },
            then(resolve: (v: { error: null }) => void) {
              void patch;
              resolve({ error: null });
            },
          };
          return inner;
        },
      };
      return builder;
    },
    rpc(name: string, args: unknown) {
      serviceState.serviceRpcCalls.push({ name, args });
      if (name === "emit_decision") {
        return Promise.resolve({
          data: "deadbeef-0000-0000-0000-000000000001",
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => bearerClientStub(),
  serviceClient: () => serviceClientStub(),
}));

vi.mock("@/../workers/client", () => ({
  inngest: {
    send: vi.fn((evt: unknown) => {
      inngestState.sentEvents.push(evt);
      return Promise.resolve();
    }),
  },
}));

import { agentChatSend } from "@/routes/agents/chat-send";

function mockRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res as Response;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res as Response;
  };
  return res as Response & { statusCode?: number; body?: unknown };
}

beforeEach(() => {
  authState.value = { user_id: U1, tenant_id: T1, access_token: "fake-jwt" };
  bearerState.rpcCalls = [];
  bearerState.rpcReturn = {
    data: [
      {
        thread_id: THREAD_ID,
        user_message_id: "22222222-2222-2222-2222-222222222222",
        run_id: "33333333-3333-3333-3333-333333333333",
      },
    ],
    error: null,
  };
  serviceState.priorAssistant = null;
  serviceState.thread = { user_id: U1, agent_slug: "engineer" };
  serviceState.inserts.agent_run_batches = [];
  serviceState.inserts.agent_thread_messages = [];
  serviceState.inserts.agent_threads = [];
  serviceState.connectorMeta = {
    installation_id: 123,
    repo_full_names: ["rravi149/upcar"],
    default_repo_full_name: "rravi149/upcar",
  };
  serviceState.serviceRpcCalls = [];
  defState.def = {
    slug: "engineer",
    content_hash: "abc123",
    metadata_praxis: { requires_sandbox: true },
  };
  inngestState.sentEvents = [];
  allowlistState.allowed = false;
  decomposeState.result = { kind: "single" };
  decomposeState.callCount = 0;
});

describe("POST /api/agents/engineer/chat — multi-task fan-out (C-b + C-c2f default-allow)", () => {
  it("regression #1: prior single-PR proposal + 'yes' → existing emit_decision fast-path runs unchanged (single-PR path NOT affected by multi-task)", async () => {
    allowlistState.allowed = false;
    serviceState.priorAssistant = {
      meta: {
        envelope: {
          pending_pr_proposal: true,
          files: [{ path: "src/foo.ts", action: "modify" }],
          repo: "rravi149/praxis",
        },
      },
      agent_run_id: "44444444-4444-4444-4444-444444444444",
      id: "55555555-5555-5555-5555-555555555555",
    };

    const req = {
      params: { slug: "engineer" },
      body: { message: "yes", thread_id: THREAD_ID },
    } as unknown as Request;
    const res = mockRes();

    await agentChatSend(req, res);

    const emitDecisionFired = serviceState.serviceRpcCalls.some(
      (c) => c.name === "emit_decision",
    );
    const approveFired = bearerState.rpcCalls.some(
      (c) => c.name === "approve_decision",
    );
    expect(emitDecisionFired).toBe(true);
    expect(approveFired).toBe(true);

    expect(serviceState.inserts.agent_run_batches.length).toBe(0);
    expect(decomposeState.callCount).toBe(0);

    expect(
      bearerState.rpcCalls.some((c) => c.name === "send_agent_chat_turn"),
    ).toBe(false);
  });

  it("regression #2 (POST C-c2f rewrite): single-task text from decomposeMessage → legacy send_agent_chat_turn still fires; no batch row inserted", async () => {
    allowlistState.allowed = false;
    decomposeState.result = { kind: "single" };

    const req = {
      params: { slug: "engineer" },
      body: {
        message: "fix the login redirect bug",
        thread_id: THREAD_ID,
      },
    } as unknown as Request;
    const res = mockRes();

    await agentChatSend(req, res);

    expect(
      bearerState.rpcCalls.some((c) => c.name === "send_agent_chat_turn"),
    ).toBe(true);

    expect(decomposeState.callCount).toBe(1);

    expect(serviceState.inserts.agent_run_batches.length).toBe(0);
  });

  it("regression #3 (POST C-c2f): multi-task text → batch propose lands (batch row + user msg + assistant envelope); NO send_agent_chat_turn, NO agent_runs row", async () => {
    allowlistState.allowed = true;
    const tasks = [
      { title: "Fix login redirect bug", task_description: "Login redirects to / instead of /workspace; should go to /workspace post-auth" },
      { title: "Add dark mode toggle", task_description: "Add a toggle in /settings/appearance; default off" },
    ];
    decomposeState.result = { kind: "multi", tasks };

    const req = {
      params: { slug: "engineer" },
      body: {
        message: "fix the login redirect bug AND add a dark mode toggle",
        thread_id: THREAD_ID,
      },
    } as unknown as Request;
    const res = mockRes();

    await agentChatSend(req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { action: string }).action).toBe("batch_proposed");
    expect((res.body as { task_count: number }).task_count).toBe(2);
    expect(typeof (res.body as { batch_id?: string }).batch_id).toBe("string");

    expect(decomposeState.callCount).toBe(1);

    expect(serviceState.inserts.agent_run_batches.length).toBe(1);
    const batchRow = serviceState.inserts.agent_run_batches[0];
    expect(batchRow.status).toBe("proposed");
    expect(batchRow.tenant_id).toBe(T1);
    expect(batchRow.thread_id).toBe(THREAD_ID);
    expect(batchRow.task_specs).toEqual(tasks);

    expect(serviceState.inserts.agent_thread_messages.length).toBe(2);
    const userMsg = serviceState.inserts.agent_thread_messages.find(
      (r) => r.sender_role === "user",
    );
    const assistantMsg = serviceState.inserts.agent_thread_messages.find(
      (r) => r.sender_role === "assistant",
    );
    expect(userMsg).toBeDefined();
    expect(userMsg!.agent_run_id).toBeNull();
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.agent_run_id).toBeNull();
    const env = (assistantMsg!.meta as { envelope: Record<string, unknown> }).envelope;
    expect(env.kind).toBe("batch_fanout");
    expect(env.pending_batch_proposal).toBe(true);
    expect(env.batch_id).toBe(batchRow.id);
    expect(Array.isArray(env.tasks)).toBe(true);
    expect((env.tasks as unknown[]).length).toBe(2);

    expect(
      bearerState.rpcCalls.some((c) => c.name === "send_agent_chat_turn"),
    ).toBe(false);
    expect(
      bearerState.rpcCalls.some((c) => c.name === "send_agent_chat_turn_v2"),
    ).toBe(false);
  });

  it("guardrail: allowlisted + single-task decomposition → legacy RPC fires unchanged (no batch row, no envelope insert)", async () => {
    allowlistState.allowed = true;
    decomposeState.result = { kind: "single" };

    const req = {
      params: { slug: "engineer" },
      body: {
        message: "refactor the auth middleware and update its callers",
        thread_id: THREAD_ID,
      },
    } as unknown as Request;
    const res = mockRes();

    await agentChatSend(req, res);

    expect(decomposeState.callCount).toBe(1);
    expect(serviceState.inserts.agent_run_batches.length).toBe(0);
    expect(
      bearerState.rpcCalls.some((c) => c.name === "send_agent_chat_turn"),
    ).toBe(true);
  });

  it("first-turn (no thread_id) + multi + usable default repo → creates thread inline + batch propose lands; NO legacy RPC", async () => {
    decomposeState.result = {
      kind: "multi",
      tasks: [
        { title: "Fix login redirect", task_description: "land on /workspace" },
        { title: "Add dark-mode toggle", task_description: "in /settings" },
      ],
    };
    serviceState.connectorMeta = {
      repo_full_names: ["rravi149/upcar"],
      default_repo_full_name: "rravi149/upcar",
    };

    const req = {
      params: { slug: "engineer" },
      body: { message: "fix the login redirect AND add a dark-mode toggle" },
    } as unknown as Request;
    const res = mockRes();

    await agentChatSend(req, res);

    expect(decomposeState.callCount).toBe(1);
    expect((res.body as { action: string }).action).toBe("batch_proposed");
    expect(serviceState.inserts.agent_threads.length).toBe(1);
    expect(serviceState.inserts.agent_run_batches.length).toBe(1);
    expect(serviceState.inserts.agent_run_batches[0].thread_id).toBe(
      serviceState.createdThreadId,
    );
    expect((res.body as { thread_id: string }).thread_id).toBe(
      serviceState.createdThreadId,
    );
    expect(
      bearerState.rpcCalls.some((c) => c.name === "send_agent_chat_turn"),
    ).toBe(false);
  });

  it("multi-repo tenant: each task is routed to its OWN repo at propose time (task_specs + envelope carry per-task repo)", async () => {
    serviceState.connectorMeta = {
      repo_full_names: ["rravi149/upcar", "rravi149/adminIosApp"],
      default_repo_full_name: "rravi149/upcar",
    };
    const tasks = [
      { title: "backend trace header", task_description: "set the X-Zavi-Trace header in the backend api" },
      { title: "admin reads trace", task_description: "read the trace header in the admin app" },
    ];
    decomposeState.result = { kind: "multi", tasks };

    const req = {
      params: { slug: "engineer" },
      body: {
        message: "add a trace header in the backend AND read it in admin",
        thread_id: THREAD_ID,
      },
    } as unknown as Request;
    const res = mockRes();

    await agentChatSend(req, res);

    expect((res.body as { action: string }).action).toBe("batch_proposed");
    expect(serviceState.inserts.agent_run_batches.length).toBe(1);

    const specs = serviceState.inserts.agent_run_batches[0]
      .task_specs as Array<{ repo?: string }>;
    expect(specs.map((t) => t.repo)).toEqual([
      "rravi149/upcar",
      "rravi149/adminIosApp",
    ]);

    const assistantMsg = serviceState.inserts.agent_thread_messages.find(
      (r) => r.sender_role === "assistant",
    );
    const env = (assistantMsg!.meta as { envelope: { tasks: Array<{ repo?: string }> } })
      .envelope;
    expect(env.tasks.map((t) => t.repo)).toEqual([
      "rravi149/upcar",
      "rravi149/adminIosApp",
    ]);
  });

  it("single connected repo: routing is skipped, tasks stay unrouted (no regression)", async () => {
    serviceState.connectorMeta = {
      repo_full_names: ["rravi149/upcar"],
      default_repo_full_name: "rravi149/upcar",
    };
    const tasks = [
      { title: "backend a", task_description: "do a in the backend api" },
      { title: "backend b", task_description: "do b in the admin" },
    ];
    decomposeState.result = { kind: "multi", tasks };

    const req = {
      params: { slug: "engineer" },
      body: { message: "do a AND do b", thread_id: THREAD_ID },
    } as unknown as Request;
    const res = mockRes();

    await agentChatSend(req, res);

    expect(serviceState.inserts.agent_run_batches.length).toBe(1);
    const specs = serviceState.inserts.agent_run_batches[0]
      .task_specs as Array<{ repo?: string }>;
    expect(specs.every((t) => t.repo === undefined)).toBe(true);
  });

  it("first-turn (no thread_id) + multi + NO default repo → does NOT fan out; falls through to legacy single-run (repo onboarding)", async () => {
    decomposeState.result = {
      kind: "multi",
      tasks: [
        { title: "A", task_description: "do A" },
        { title: "B", task_description: "do B" },
      ],
    };
    serviceState.connectorMeta = {
      installation_id: 123,
      repo_full_names: ["rravi149/upcar"],
      default_repo_full_name: null,
    };

    const req = {
      params: { slug: "engineer" },
      body: { message: "do A AND do B" },
    } as unknown as Request;
    const res = mockRes();

    await agentChatSend(req, res);

    expect(decomposeState.callCount).toBe(0);
    expect(serviceState.inserts.agent_threads.length).toBe(0);
    expect(serviceState.inserts.agent_run_batches.length).toBe(0);
    expect(
      bearerState.rpcCalls.some((c) => c.name === "send_agent_chat_turn"),
    ).toBe(true);
  });
});
