import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const t1 = "00000000-0000-0000-0000-000000000001";
const u1 = "10000000-0000-0000-0000-000000000001";
const THREAD = "11111111-1111-4111-8111-111111111111";
const VIDEO = `${t1}/55555555-5555-4555-8555-555555555555.mp4`;

const { authState, bearerState, serviceState, defState } = vi.hoisted(() => {
  const T1 = "00000000-0000-0000-0000-000000000001";
  const U1 = "10000000-0000-0000-0000-000000000001";
  return {
    authState: {
      value: { user_id: U1, tenant_id: T1, access_token: "fake-jwt" },
    },
    bearerState: {
      rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    },
    serviceState: {
      updates: [] as Array<Record<string, unknown>>,
      inserts: [] as Array<{ table: string; row: unknown }>,
      thread: { user_id: U1, agent_slug: "operator" } as {
        user_id: string;
        agent_slug: string;
      } | null,
    },
    defState: {
      def: {
        slug: "operator",
        content_hash: "abc123",
        metadata_praxis: { requires_sandbox: false },
      },
    },
  };
});

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => authState.value),
}));

function bearerClientStub(): unknown {
  return {
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return builder;
    },
    rpc(name: string, args: Record<string, unknown>) {
      bearerState.rpcCalls.push({ name, args });
      if (name === "send_agent_chat_turn" || name === "send_agent_chat_turn_v3") {
        return Promise.resolve({
          data: [
            {
              thread_id: THREAD,
              user_message_id: "22222222-2222-2222-2222-222222222222",
              run_id: "33333333-3333-3333-3333-333333333333",
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function serviceClientStub(): unknown {
  return {
    from(table: string) {
      const builder = {
        select() {
          const inner = {
            eq: () => inner,
            order: () => inner,
            limit: () => inner,
            filter: () => inner,
            in: () => inner,
            neq: () => inner,
            is: () => inner,
            then(resolve: (v: { data: unknown[]; error: null; count: number }) => void) {
              resolve({ data: [], error: null, count: 0 });
            },
            async maybeSingle() {
              if (table === "agent_threads") return { data: serviceState.thread, error: null };
              if (table === "agent_runs") {
                return { data: { payload: { thread_id: THREAD } }, error: null };
              }
              return { data: null, error: null };
            },
            async single() {
              return { data: null, error: null };
            },
          };
          return inner;
        },
        update(patch: Record<string, unknown>) {
          const inner = {
            eq: () => inner,
            then(resolve: (v: { error: null }) => void) {
              if (table === "agent_runs" && patch && "payload" in patch) {
                serviceState.updates.push(patch.payload as Record<string, unknown>);
              }
              resolve({ error: null });
            },
          };
          return inner;
        },
        insert(row: unknown) {
          serviceState.inserts.push({ table, row });
          const done = Promise.resolve({ data: { id: "66666666-6666-6666-6666-666666666666" }, error: null });
          return Object.assign(done, {
            select: () => ({ single: () => done, maybeSingle: () => done }),
          });
        },
      };
      return builder;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
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
    agent: { slug: "operator", content_hash: "deadbeef" },
  })),
}));

vi.mock("@/services/auth/members", () => ({
  canUserAccessAgent: vi.fn(async () => true),
}));

vi.mock("@/../workers/client", () => ({
  inngest: { send: vi.fn(() => Promise.resolve()) },
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

function chatTurnCall() {
  return bearerState.rpcCalls.find(
    (c) => c.name === "send_agent_chat_turn" || c.name === "send_agent_chat_turn_v3",
  );
}

beforeEach(() => {
  bearerState.rpcCalls = [];
  serviceState.updates = [];
  serviceState.inserts = [];
  serviceState.thread = { user_id: u1, agent_slug: "operator" };
});

describe("POST /api/agents/:slug/chat — attached video reaches the run", () => {
  it("merges video_paths into a non-sandbox agent's run payload", async () => {
    const res = mockRes();
    await agentChatSend(
      {
        params: { slug: "operator" },
        body: { message: "Post this on my tiktok", video_paths: [VIDEO] },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(202);
    expect(chatTurnCall()?.args.p_message).toBe("Post this on my tiktok");
    expect(serviceState.updates.some((p) => {
      const v = p.video_paths as unknown;
      return Array.isArray(v) && v.length === 1 && v[0] === VIDEO;
    })).toBe(true);
  });

  it("a video-only turn gets a non-empty stored body instead of an RPC rejection", async () => {
    const res = mockRes();
    await agentChatSend(
      {
        params: { slug: "operator" },
        body: { message: "", video_paths: [VIDEO] },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(202);
    expect(chatTurnCall()?.args.p_message).toBe("(video)");
    expect(serviceState.updates.some((p) => Array.isArray(p.video_paths))).toBe(true);
  });

  it("'ok' with a video on an open thread starts a run instead of the no-run ack", async () => {
    const res = mockRes();
    await agentChatSend(
      {
        params: { slug: "operator" },
        body: { message: "ok", thread_id: THREAD, video_paths: [VIDEO] },
      } as unknown as Request,
      res,
    );

    expect(chatTurnCall()).toBeDefined();
    expect(serviceState.updates.some((p) => Array.isArray(p.video_paths))).toBe(true);
  });

  it("'hi' with a video starts a run instead of the no-run greeting", async () => {
    const res = mockRes();
    await agentChatSend(
      {
        params: { slug: "operator" },
        body: { message: "hi", video_paths: [VIDEO] },
      } as unknown as Request,
      res,
    );

    expect(chatTurnCall()).toBeDefined();
  });

  it("still refuses a video path under another tenant, before any RPC", async () => {
    const res = mockRes();
    await agentChatSend(
      {
        params: { slug: "operator" },
        body: {
          message: "post this",
          video_paths: ["99999999-9999-4999-8999-999999999999/55555555-5555-4555-8555-555555555555.mp4"],
        },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("path_not_owned");
    expect(chatTurnCall()).toBeUndefined();
  });
});
