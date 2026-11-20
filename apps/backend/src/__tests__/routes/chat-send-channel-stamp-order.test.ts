import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

const t1 = "00000000-0000-0000-0000-000000000001";
const u1 = "10000000-0000-0000-0000-000000000001";
const RUN = "33333333-3333-3333-3333-333333333333";
const THREAD = "11111111-1111-4111-8111-111111111111";

type SendTurnResult = { thread_id: string; user_message_id: string; run_id: string };

const { authState, bearerState, serviceState, defState, inngestState, channelState } =
  vi.hoisted(() => {
    const T1 = "00000000-0000-0000-0000-000000000001";
    const U1 = "10000000-0000-0000-0000-000000000001";
    return {
      authState: {
        value: { user_id: U1, tenant_id: T1, access_token: "fake-jwt" } as
          | { user_id: string; tenant_id: string; access_token: string }
          | null,
      },
      bearerState: {
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
        runPayload: null as Record<string, unknown> | null,
        priorAssistant: null as
          | { meta: Record<string, unknown>; agent_run_id: string | null; id: string }
          | null,
        thread: { user_id: U1, agent_slug: "meta_ads" } as
          | { user_id: string; agent_slug: string }
          | null,
      },
      defState: {
        def: {
          slug: "meta_ads",
          content_hash: "abc123",
          metadata_praxis: { requires_sandbox: false },
        } as {
          slug: string;
          content_hash: string;
          metadata_praxis: { requires_sandbox: boolean };
        } | null,
      },
      inngestState: { sentEvents: [] as unknown[] },
      channelState: {
        admission: { allowed: true, channel_slug: "meta_ads", estimate: 0 } as
          | { allowed: true; channel_slug: string; estimate: number }
          | { allowed: false; reason: string; message: string },
        stampCalls: [] as Array<{
          tenant_id: string;
          run_id: string;
          channel_slug: string;
        }>,
        gate: null as null | Promise<void>,
        releaseGate: null as null | (() => void),
        stampResult: true as boolean,
        stampThrows: false,
        order: [] as string[],
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

function bearerClientStub(): unknown {
  return {
    from(_table: string) {
      const builder = {
        select(_cols: string) {
          return builder;
        },
        eq(_col: string, _val: unknown) {
          return builder;
        },
        async maybeSingle() {
          return { data: null, error: null };
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
                return {
                  data: serviceState.runPayload
                    ? { payload: serviceState.runPayload }
                    : null,
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          };
          return inner;
        },
        update(_patch: Record<string, unknown>) {
          const inner = {
            eq(_col: string, _val: unknown) {
              return inner;
            },
            then(resolve: (v: { error: null }) => void) {
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
    agent: { slug: "meta_ads", content_hash: "deadbeef" },
  })),
}));

vi.mock("@/services/agents/kill-switch", () => ({
  isAgentKilled: vi.fn(async () => false),
}));

vi.mock("@/services/sandbox/repo-picker", () => ({
  parseRepoPickReply: vi.fn(() => null),
}));

vi.mock("@/services/auth/members", () => ({
  canUserAccessAgent: vi.fn(async () => true),
}));

vi.mock("@/services/channels/direct-run", () => ({
  admitDirectChannelRun: vi.fn(async () => channelState.admission),
  stampDirectChannelRun: vi.fn(
    async (tenant_id: string, run_id: string, channel_slug: string) => {
      channelState.stampCalls.push({ tenant_id, run_id, channel_slug });
      if (channelState.gate) await channelState.gate;
      channelState.order.push("stamp");
      if (channelState.stampThrows) throw new Error("stamp exploded");
      return channelState.stampResult;
    },
  ),
}));

vi.mock("@/../workers/client", () => ({
  inngest: {
    send: vi.fn((evt: unknown) => {
      channelState.order.push("dispatch");
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

function chatReq() {
  return {
    params: { slug: "meta_ads" },
    body: { message: "pause the worst performing ad set", thread_id: THREAD },
  } as unknown as Request;
}

async function drain(ticks = 25) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  authState.value = { user_id: u1, tenant_id: t1, access_token: "fake-jwt" };
  bearerState.rpcCalls = [];
  bearerState.rpcReturn = {
    data: [
      {
        thread_id: THREAD,
        user_message_id: "22222222-2222-2222-2222-222222222222",
        run_id: RUN,
      },
    ],
    error: null,
  };
  serviceState.runPayload = null;
  serviceState.priorAssistant = null;
  serviceState.thread = { user_id: u1, agent_slug: "meta_ads" };
  defState.def = {
    slug: "meta_ads",
    content_hash: "abc123",
    metadata_praxis: { requires_sandbox: false },
  };
  inngestState.sentEvents = [];
  channelState.admission = {
    allowed: true,
    channel_slug: "meta_ads",
    estimate: 0,
  };
  channelState.stampCalls = [];
  channelState.gate = null;
  channelState.releaseGate = null;
  channelState.stampResult = true;
  channelState.stampThrows = false;
  channelState.order = [];
});

afterEach(() => {
  vi.useRealTimers();
});

function holdTheStamp() {
  channelState.gate = new Promise<void>((resolve) => {
    channelState.releaseGate = resolve;
  });
}

describe("chat-send — the channel stamp is resolved BEFORE the run is dispatched", () => {
  it("does not dispatch while the stamp is still pending", async () => {
    holdTheStamp();

    const res = mockRes();
    const pending = agentChatSend(chatReq(), res);

    await drain(5);

    expect(channelState.stampCalls).toHaveLength(1);
    expect(channelState.stampCalls[0]).toMatchObject({
      tenant_id: t1,
      run_id: RUN,
      channel_slug: "meta_ads",
    });

    expect(inngestState.sentEvents).toHaveLength(0);
    expect(res.statusCode).toBeUndefined();

    channelState.releaseGate!();
    await pending;

    expect(inngestState.sentEvents).toHaveLength(1);
    expect(channelState.order).toEqual(["stamp", "dispatch"]);
    expect(res.statusCode).toBe(202);
  });

  it(
    "dispatches anyway once a STALLED stamp passes its deadline",
    async () => {
      vi.useFakeTimers();
      holdTheStamp();

      const res = mockRes();
      const pending = agentChatSend(chatReq(), res);

      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
      expect(channelState.stampCalls).toHaveLength(1);
      expect(inngestState.sentEvents).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2_000);
      await pending;

      expect(inngestState.sentEvents).toHaveLength(1);
      expect(res.statusCode).toBe(202);
      expect(channelState.order).toEqual(["dispatch"]);
    },
    5000,
  );

  it("stamps with the SURFACE channel, not one derived from any tool", async () => {
    channelState.admission = {
      allowed: true,
      channel_slug: "youtube_ads",
      estimate: 0,
    };

    await agentChatSend(chatReq(), mockRes());

    expect(channelState.stampCalls).toHaveLength(1);
    expect(channelState.stampCalls[0].channel_slug).toBe("youtube_ads");
  });

  it("does NOT stamp a turn that resolves to no channel, and still dispatches", async () => {
    channelState.admission = { allowed: true, channel_slug: "", estimate: 0 };

    const res = mockRes();
    await agentChatSend(chatReq(), res);

    expect(channelState.stampCalls).toHaveLength(0);
    expect(inngestState.sentEvents).toHaveLength(1);
    expect(channelState.order).toEqual(["dispatch"]);
    expect(res.statusCode).toBe(202);
  });

  it("still sends the turn when the stamp does not land", async () => {
    channelState.stampResult = false;

    const res = mockRes();
    await agentChatSend(chatReq(), res);

    expect(channelState.stampCalls).toHaveLength(1);
    expect(inngestState.sentEvents).toHaveLength(1);
    expect(res.statusCode).toBe(202);
  });

  it("still sends the turn when the stamp throws", async () => {
    channelState.stampThrows = true;

    const res = mockRes();
    await agentChatSend(chatReq(), res);

    expect(inngestState.sentEvents).toHaveLength(1);
    expect(res.statusCode).toBe(202);
  });
});
