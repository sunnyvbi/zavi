import { describe, it, expect, vi, beforeEach } from "vitest";
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

const { admitMock } = vi.hoisted(() => ({ admitMock: vi.fn() }));

vi.mock("@/services/channels/direct-run", () => ({
  admitDirectChannelRun: admitMock,
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

const { originState, fastState } = vi.hoisted(() => ({
  originState: {
    calls: [] as Array<Record<string, unknown>>,
    gate: null as null | Promise<void>,
    releaseGate: null as null | (() => void),
  },
  fastState: {
    greeting: null as null | { thread_id: string; user_message_id: string | null; ok: true; action: string },
    greetingCalls: [] as unknown[],
  },
}));

vi.mock("@/services/agents/thread-channel-origin", () => ({
  stampThreadChannelOrigin: vi.fn(async (input: Record<string, unknown>) => {
    originState.calls.push(input);
    if (originState.gate) await originState.gate;
  }),
}));

vi.mock("@/services/setup/chat-fastpaths", () => ({
  CGO: "cgo",
  CONFLICT_USE_FILE: "Use the file's",
  CONFLICT_KEEP: "Keep what you have",
  SetupFastPathError: class extends Error {},
  ownThread: vi.fn(async () => null),
  latestCgoThread: vi.fn(async () => null),
  writeNoRunExchange: vi.fn(async () => null),
  trySetupFaq: vi.fn(async () => null),
  tryResolveConflict: vi.fn(async () => null),
  tryGreeting: vi.fn(async (...args: unknown[]) => {
    fastState.greetingCalls.push(args);
    return fastState.greeting;
  }),
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

const NEW_THREAD = "44444444-4444-4444-8444-444444444444";
const CARD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function opReq(body: Record<string, unknown>, slug = "chatgpt_ads") {
  return { params: { slug }, body } as unknown as Request;
}

beforeEach(() => {
  authState.value = { user_id: u1, tenant_id: t1, access_token: "fake-jwt" };
  bearerState.rpcCalls = [];
  bearerState.rpcReturn = {
    data: [
      {
        thread_id: NEW_THREAD,
        user_message_id: "22222222-2222-2222-2222-222222222222",
        run_id: RUN,
      },
    ],
    error: null,
  };
  serviceState.runPayload = null;
  serviceState.priorAssistant = null;
  serviceState.thread = { user_id: u1, agent_slug: "chatgpt_ads" };
  defState.def = {
    slug: "chatgpt_ads",
    content_hash: "abc123",
    metadata_praxis: { requires_sandbox: false },
  };
  inngestState.sentEvents = [];
  channelState.admission = { allowed: true, channel_slug: "chatgpt_ads", estimate: 0 };
  admitMock.mockImplementation(async () => channelState.admission);
  channelState.stampCalls = [];
  channelState.gate = null;
  channelState.releaseGate = null;
  channelState.stampResult = true;
  channelState.stampThrows = false;
  channelState.order = [];
  originState.calls = [];
  originState.gate = null;
  originState.releaseGate = null;
  fastState.greeting = null;
  fastState.greetingCalls = [];
});

function holdOrigin() {
  originState.gate = new Promise<void>((resolve) => {
    originState.releaseGate = resolve;
  });
}

describe("chat-send: a channel page turn stamps its thread before answering", () => {
  it("normal path: a new chat from the page is stamped with the RPC's thread, the auth tenant and user, before the 202", async () => {
    holdOrigin();
    const res = mockRes();
    const pending = agentChatSend(
      opReq({ message: "how are my ChatGPT ads doing", page_channel: "chatgpt_ads" }),
      res,
    );
    await drain(10);

    expect(originState.calls).toEqual([
      {
        tenantId: t1,
        userId: u1,
        threadId: NEW_THREAD,
        agentSlug: "chatgpt_ads",
        pageChannel: "chatgpt_ads",
        pageChannelActionId: null,
      },
    ]);
    expect(res.statusCode).toBeUndefined();

    originState.releaseGate!();
    await pending;
    expect(res.statusCode).toBe(202);
    expect((res.body as { thread_id: string }).thread_id).toBe(NEW_THREAD);
  });

  it("carries the card id to the stamp (the stamp decides whether to accept it)", async () => {
    await agentChatSend(
      opReq({ message: "why this one", page_channel: "chatgpt_ads", page_channel_action_id: CARD, channel_action_id: CARD }),
      mockRes(),
    );
    expect(originState.calls[0]).toMatchObject({ pageChannelActionId: CARD, threadId: NEW_THREAD });
  });

  it("greeting fast path: a fresh 'hi' from the page is stamped with the thread the fast path created", async () => {
    const GREET = "55555555-5555-4555-8555-555555555555";
    fastState.greeting = { thread_id: GREET, user_message_id: "u-msg", ok: true, action: "greeting" };
    const res = mockRes();
    await agentChatSend(opReq({ message: "hi", page_channel: "chatgpt_ads" }), res);

    expect(fastState.greetingCalls).toHaveLength(1);
    expect(bearerState.rpcCalls.filter((c) => c.name.startsWith("send_agent_chat_turn"))).toHaveLength(0);
    expect(originState.calls).toEqual([
      expect.objectContaining({ threadId: GREET, tenantId: t1, userId: u1, pageChannel: "chatgpt_ads" }),
    ]);
    expect(res.statusCode).toBe(200);
    expect((res.body as { thread_id: string }).thread_id).toBe(GREET);
  });

  it("stale-thread self-heal retry: the retried turn (no thread_id, page_channel carried) stamps the replacement thread", async () => {
    const res = mockRes();
    await agentChatSend(opReq({ message: "retry me", thread_id: null, page_channel: "chatgpt_ads" }), res);
    expect(originState.calls).toEqual([expect.objectContaining({ threadId: NEW_THREAD })]);
    expect(res.statusCode).toBe(202);
  });

  it("a later page message on an existing thread also reaches the stamp (heals a stamp that failed on the first turn)", async () => {
    bearerState.rpcReturn = {
      data: [{ thread_id: THREAD, user_message_id: "22222222-2222-2222-2222-222222222222", run_id: RUN }],
      error: null,
    };
    await agentChatSend(opReq({ message: "and now?", thread_id: THREAD, page_channel: "chatgpt_ads" }), mockRes());
    expect(originState.calls).toEqual([expect.objectContaining({ threadId: THREAD })]);
  });

  it("a main-workspace turn that only TAGS the channel is never stamped, and is answered without a hold", async () => {
    defState.def = { slug: "operator", content_hash: "abc", metadata_praxis: { requires_sandbox: false } };
    serviceState.thread = { user_id: u1, agent_slug: "operator" };
    channelState.admission = { allowed: true, channel_slug: "", estimate: 0 };
    const res = mockRes();
    await agentChatSend(opReq({ message: "about chatgpt ads", channels: ["chatgpt_ads"] }, "operator"), res);
    expect(originState.calls).toHaveLength(0);
    expect(res.statusCode).toBe(202);
  });

  it("a turn to any agent other than the page channel's own is not stamped", async () => {
    defState.def = { slug: "meta_ads", content_hash: "abc", metadata_praxis: { requires_sandbox: false } };
    serviceState.thread = { user_id: u1, agent_slug: "meta_ads" };
    await agentChatSend(opReq({ message: "x", page_channel: "chatgpt_ads" }, "meta_ads"), mockRes());
    defState.def = { slug: "operator", content_hash: "abc", metadata_praxis: { requires_sandbox: false } };
    serviceState.thread = { user_id: u1, agent_slug: "operator" };
    channelState.admission = { allowed: true, channel_slug: "", estimate: 0 };
    await agentChatSend(opReq({ message: "x", page_channel: "chatgpt_ads" }, "operator"), mockRes());
    expect(originState.calls).toHaveLength(0);
  });

  it("a page turn is admitted as chat (wallet, not the channel cap) and does not pin the agent", async () => {
    await agentChatSend(opReq({ message: "x", page_channel: "chatgpt_ads" }), mockRes());
    expect(admitMock).toHaveBeenLastCalledWith(t1, "chatgpt_ads", undefined, { chat: true });
    await drain(10);
    expect(bearerState.rpcCalls.map((c) => c.name)).not.toContain("add_agent_pin");
  });

  it("a direct chat with the channel agent outside its page still pins it", async () => {
    await agentChatSend(opReq({ message: "x" }), mockRes());
    await drain(10);
    expect(bearerState.rpcCalls.map((c) => c.name)).toContain("add_agent_pin");
  });

  it("an unknown page_channel is a 400 and nothing is stamped", async () => {
    const res = mockRes();
    await agentChatSend(opReq({ message: "x", page_channel: "myspace_ads" }), res);
    expect(res.statusCode).toBe(400);
    expect(originState.calls).toHaveLength(0);
  });

  it("a failed turn (non-2xx) is answered straight away and not stamped", async () => {
    bearerState.rpcReturn = { data: [], error: { message: "rpc exploded" } };
    const res = mockRes();
    await agentChatSend(opReq({ message: "x", page_channel: "chatgpt_ads" }), res);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(originState.calls).toHaveLength(0);
  });
});
