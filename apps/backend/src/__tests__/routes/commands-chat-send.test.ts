import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const t1 = "00000000-0000-0000-0000-000000000001";
const u1 = "10000000-0000-0000-0000-000000000001";

type TenantCommandRow = { slug: string; instructions_md: string };
type SendTurnResult = { thread_id: string; user_message_id: string; run_id: string };

const {
  authState,
  bearerState,
  serviceState,
  defState,
  inngestState,
} = vi.hoisted(() => {
  const T1 = "00000000-0000-0000-0000-000000000001";
  const U1 = "10000000-0000-0000-0000-000000000001";
  return {
    authState: {
      value: { user_id: U1, tenant_id: T1, access_token: "fake-jwt" } as
        | { user_id: string; tenant_id: string; access_token: string }
        | null,
    },
    bearerState: {
      commandRow: null as TenantCommandRow | null,
      commandError: null as { code?: string; message: string } | null,
      rpcReturn: {
        data: [
          {
            thread_id: "11111111-1111-4111-8111-111111111111",
            user_message_id: "22222222-2222-2222-2222-222222222222",
            run_id: "33333333-3333-3333-3333-333333333333",
          },
        ] as SendTurnResult[],
        error: null as { message: string } | null,
      },
      rpcCalls: [] as Array<{ name: string; args: unknown }>,
    },
    serviceState: {
      lastUpdatePayload: null as Record<string, unknown> | null,
      runPayload: null as Record<string, unknown> | null,
      priorAssistant: null as
        | { meta: Record<string, unknown>; agent_run_id: string | null; id: string }
        | null,
      thread: { user_id: U1, agent_slug: "engineer" } as
        | { user_id: string; agent_slug: string }
        | null,
      connectorMeta: {
        installation_id: 123,
        repo_full_names: ["rravi149/upcar"],
      } as { installation_id: number | null; repo_full_names: string[] } | null,
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

function bearerClientStub(): unknown {
  return {
    from(_table: string) {
      let _filter = "";
      const builder = {
        select(_cols: string) {
          return builder;
        },
        eq(_col: string, _val: unknown) {
          return builder;
        },
        async maybeSingle() {
          return { data: bearerState.commandRow, error: bearerState.commandError };
        },
      };
      return builder;
    },
    rpc(name: string, args: unknown) {
      bearerState.rpcCalls.push({ name, args });
      if (name === "send_agent_chat_turn") {
        return Promise.resolve(bearerState.rpcReturn);
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
            order(_col: string, _opts: unknown) {
              return inner;
            },
            limit(_n: number) {
              return inner;
            },
            filter(_col: string, _op: string, _val: unknown) {
              return inner;
            },
            in(_col: string, _vals: unknown[]) {
              return inner;
            },
            neq(_col: string, _val: unknown) {
              return inner;
            },
            is(_col: string, _val: unknown) {
              return inner;
            },
            then(
              resolve: (v: { data: unknown[]; error: null; count: number }) => void,
            ) {
              resolve({ data: [], error: null, count: 0 });
            },
            async maybeSingle() {
              if (table === "agent_thread_messages") {
                return { data: serviceState.priorAssistant, error: null };
              }
              if (table === "agent_threads") {
                return { data: serviceState.thread, error: null };
              }
              if (table === "agent_runs") {
                return { data: serviceState.runPayload ? { payload: serviceState.runPayload } : null, error: null };
              }
              if (table === "connector_metadata") {
                return { data: serviceState.connectorMeta, error: null };
              }
              return { data: null, error: null };
            },
          };
          return inner;
        },
        update(patch: Record<string, unknown>) {
          const inner = {
            eq(_col: string, _val: unknown) {
              return inner;
            },
            then(resolve: (v: { error: null }) => void) {
              if (patch && typeof patch === "object" && "payload" in patch) {
                serviceState.lastUpdatePayload =
                  patch.payload as Record<string, unknown>;
              }
              resolve({ error: null });
            },
          };
          return inner;
        },
        insert(_row: unknown) {
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  };
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => bearerClientStub(),
  serviceClient: () => serviceClientStub(),
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
}));

vi.mock("@/services/auth/members", () => ({
  canUserAccessAgent: vi.fn(async () => true),
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
  authState.value = { user_id: u1, tenant_id: t1, access_token: "fake-jwt" };
  bearerState.commandRow = null;
  bearerState.commandError = null;
  bearerState.rpcCalls = [];
  bearerState.rpcReturn = {
    data: [
      {
        thread_id: "11111111-1111-4111-8111-111111111111",
        user_message_id: "22222222-2222-2222-2222-222222222222",
        run_id: "33333333-3333-3333-3333-333333333333",
      },
    ],
    error: null,
  };
  serviceState.lastUpdatePayload = null;
  serviceState.runPayload = null;
  serviceState.priorAssistant = null;
  serviceState.thread = { user_id: u1, agent_slug: "engineer" };
  serviceState.connectorMeta = {
    installation_id: 123,
    repo_full_names: ["rravi149/upcar"],
  };
  defState.def = {
    slug: "engineer",
    content_hash: "abc123",
    metadata_praxis: { requires_sandbox: true },
  };
  inngestState.sentEvents = [];
});

describe("POST /api/agents/:slug/chat — command_slug branch", () => {
  it("rejects malformed command_slug with 400 (zod) — no RPC call", async () => {
    const req = {
      params: { slug: "engineer" },
      body: { message: "hello", command_slug: "BAD_SLUG!!!" },
    } as unknown as Request;
    const res = mockRes();

    await agentChatSend(req, res);

    expect(res.statusCode).toBe(400);
    expect(
      bearerState.rpcCalls.some((c) => c.name === "send_agent_chat_turn"),
    ).toBe(false);
  });

  it("returns invalid_command (400) when slug not found for tenant — RPC not called", async () => {
    bearerState.commandRow = null;
    const req = {
      params: { slug: "engineer" },
      body: { message: "do X", command_slug: "missing-cmd" },
    } as unknown as Request;
    const res = mockRes();

    await agentChatSend(req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "invalid_command",
    );
    expect(
      bearerState.rpcCalls.some((c) => c.name === "send_agent_chat_turn"),
    ).toBe(false);
  });

  it("rejects payload_too_long (400) BEFORE the RPC call when wrapper+body exceeds 32000", async () => {
    bearerState.commandRow = {
      slug: "huge",
      instructions_md: "a".repeat(8000),
    };
    const longUserMsg = "b".repeat(25000);
    const req = {
      params: { slug: "engineer" },
      body: { message: longUserMsg, command_slug: "huge" },
    } as unknown as Request;
    const res = mockRes();

    await agentChatSend(req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "payload_too_long",
    );
    expect(
      bearerState.rpcCalls.some((c) => c.name === "send_agent_chat_turn"),
    ).toBe(false);
  });

  it("happy path: RPC receives RAW user message + payload merge adds command_slug", async () => {
    bearerState.commandRow = {
      slug: "onboard-host",
      instructions_md: "Always start by asking what state the host is in.",
    };
    const req = {
      params: { slug: "engineer" },
      body: { message: "make this happen", command_slug: "onboard-host" },
    } as unknown as Request;
    const res = mockRes();

    await agentChatSend(req, res);

    const sendCall = bearerState.rpcCalls.find(
      (c) => c.name === "send_agent_chat_turn",
    );
    expect(sendCall).toBeDefined();
    expect(
      (sendCall!.args as { p_message: string }).p_message,
    ).toBe("make this happen");

    expect(serviceState.lastUpdatePayload).toMatchObject({
      command_slug: "onboard-host",
    });
  });

  it("approval fast-path SKIPPED when command_slug present (engineer + pending PR + 'yes')", async () => {
    bearerState.commandRow = {
      slug: "approve-flow",
      instructions_md: "Run the approve flow.",
    };
    serviceState.priorAssistant = {
      meta: {
        envelope: {
          pending_pr_proposal: true,
          files: [{ path: "x.ts", action: "create" }],
        },
      },
      agent_run_id: "44444444-4444-4444-4444-444444444444",
      id: "55555555-5555-5555-5555-555555555555",
    };
    const req = {
      params: { slug: "engineer" },
      body: {
        message: "yes",
        thread_id: "11111111-1111-4111-8111-111111111111",
        command_slug: "approve-flow",
      },
    } as unknown as Request;
    const res = mockRes();

    await agentChatSend(req, res);

    expect(
      bearerState.rpcCalls.some(
        (c) => c.name === "emit_decision" || c.name === "approve_decision",
      ),
    ).toBe(false);

    expect(
      bearerState.rpcCalls.some((c) => c.name === "send_agent_chat_turn"),
    ).toBe(true);
  });
});
