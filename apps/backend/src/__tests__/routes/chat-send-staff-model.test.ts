import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const t1 = "00000000-0000-0000-0000-000000000001";
const u1 = "10000000-0000-0000-0000-000000000001";
const RUN = "33333333-3333-3333-3333-333333333333";
const THREAD = "11111111-1111-4111-8111-111111111111";

const { authState, bearerState, serviceState, gateState, order } = vi.hoisted(() => {
  const T1 = "00000000-0000-0000-0000-000000000001";
  const U1 = "10000000-0000-0000-0000-000000000001";
  return {
    authState: { value: { user_id: U1, tenant_id: T1, access_token: "fake-jwt" } },
    bearerState: { rpcCalls: [] as Array<{ name: string; args: unknown }> },
    serviceState: {
      runPayload: null as Record<string, unknown> | null,
      thread: { user_id: U1, agent_slug: "meta_ads" },
    },
    gateState: { owner: true, cap: { ok: true } as { ok: true } | { ok: false; spent: number; cap: number } },
    order: [] as string[],
  };
});

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => authState.value),
}));

vi.mock("@/services/auth/staff-model-access", () => ({
  isTenantOwnerOrAdmin: vi.fn(async () => gateState.owner),
  checkStaffModelCap: vi.fn(async () => gateState.cap),
}));

function bearerClientStub(): unknown {
  return {
    from() {
      const b = { select: () => b, eq: () => b, async maybeSingle() { return { data: null, error: null }; } };
      return b;
    },
    rpc(name: string, args: unknown) {
      bearerState.rpcCalls.push({ name, args });
      if (name === "send_agent_chat_turn") {
        return Promise.resolve({
          data: [{ thread_id: "11111111-1111-4111-8111-111111111111", user_message_id: "22222222-2222-2222-2222-222222222222", run_id: "33333333-3333-3333-3333-333333333333" }],
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
      return {
        select() {
          const inner: any = {
            eq: () => inner, order: () => inner, limit: () => inner, filter: () => inner,
            in: () => inner, neq: () => inner, is: () => inner,
            then(resolve: (v: { data: unknown[]; error: null; count: number }) => void) {
              resolve({ data: [], error: null, count: 0 });
            },
            async maybeSingle() {
              if (table === "agent_threads") return { data: serviceState.thread, error: null };
              if (table === "agent_runs") return { data: { payload: serviceState.runPayload ?? {} }, error: null };
              return { data: null, error: null };
            },
          };
          return inner;
        },
        update(patch: Record<string, unknown>) {
          if (table === "agent_runs" && patch.payload) {
            serviceState.runPayload = patch.payload as Record<string, unknown>;
            if ((patch.payload as Record<string, unknown>).staff_model) order.push("stamp");
          }
          const inner: any = { eq: () => inner, then: (r: (v: { error: null }) => void) => r({ error: null }) };
          return inner;
        },
        insert() { return Promise.resolve({ error: null }); },
      };
    },
  };
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => bearerClientStub(),
  serviceClient: () => serviceClientStub(),
}));
vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: vi.fn(async () => ({ slug: "meta_ads", content_hash: "abc123", metadata_praxis: { requires_sandbox: false } })),
}));
vi.mock("@/services/agents/ensure-runnable", () => ({
  ensureAgentRunnable: vi.fn(async () => ({ runnable: true, agent: { slug: "meta_ads", content_hash: "deadbeef" } })),
}));
vi.mock("@/services/agents/kill-switch", () => ({ isAgentKilled: vi.fn(async () => false) }));
vi.mock("@/services/sandbox/repo-picker", () => ({ parseRepoPickReply: vi.fn(() => null) }));
vi.mock("@/services/auth/members", () => ({ canUserAccessAgent: vi.fn(async () => true) }));
vi.mock("@/services/channels/direct-run", () => ({
  admitDirectChannelRun: vi.fn(async () => ({ allowed: true, channel_slug: "", estimate: 0 })),
  stampDirectChannelRun: vi.fn(async () => true),
}));
vi.mock("@/../workers/client", () => ({
  inngest: { send: vi.fn(() => { order.push("dispatch"); return Promise.resolve(); }) },
}));

import { agentChatSend } from "@/routes/agents/chat-send";

const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
afterAll(() => {
  if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
});

function mockRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = (code: number) => { res.statusCode = code; return res as Response; };
  res.json = (body: unknown) => { res.body = body; return res as Response; };
  return res as Response & { statusCode?: number; body?: unknown };
}
const req = (body: Record<string, unknown>) =>
  ({ params: { slug: "meta_ads" }, body: { message: "how are my ads doing", thread_id: THREAD, ...body } }) as unknown as Request;

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
  authState.value = { user_id: u1, tenant_id: t1, access_token: "fake-jwt" };
  bearerState.rpcCalls = [];
  serviceState.runPayload = null;
  gateState.owner = true;
  gateState.owner = true;
  gateState.cap = { ok: true };
  order.length = 0;
});

describe("chat-send staff ?model=", () => {
  it("staff owner: stamps {key} merged with the other payload keys, BEFORE dispatch", async () => {
    const res = mockRes();
    await agentChatSend(req({ model: "Qwen", channels: ["meta_ads"], depth: "deep" }), res);
    expect(res.statusCode).toBe(202);
    expect(serviceState.runPayload).toMatchObject({ staff_model: { key: "qwen" }, channels: ["meta_ads"], depth: "deep" });
    expect((serviceState.runPayload?.staff_model as { by?: string }).by).toBeTruthy();
    expect(order).toEqual(["stamp", "dispatch"]);
  });

  it("member (not owner/admin): no staff_model, run still dispatched", async () => {
    gateState.owner = false;
    const res = mockRes();
    await agentChatSend(req({ model: "qwen" }), res);
    expect(res.statusCode).toBe(202);
    expect(serviceState.runPayload?.staff_model).toBeUndefined();
    expect(order).toEqual(["dispatch"]);
  });

  it("a ?model= turn never calls enqueue_or_steer_chat_turn (barge-in skipped)", async () => {
    await agentChatSend(req({ model: "qwen" }), mockRes());
    expect(bearerState.rpcCalls.map((c) => c.name)).not.toContain("enqueue_or_steer_chat_turn");
  });

  it("harness sanity: the same turn as a member DOES reach the barge-in probe", async () => {
    gateState.owner = false;
    await agentChatSend(req({ model: "qwen" }), mockRes());
    expect(bearerState.rpcCalls.map((c) => c.name)).toContain("enqueue_or_steer_chat_turn");
  });

  it("cap reached → 429 staff_model_cap, no run created", async () => {
    gateState.cap = { ok: false, spent: 200, cap: 200 };
    const res = mockRes();
    await agentChatSend(req({ model: "qwen" }), res);
    expect(res.statusCode).toBe(429);
    expect((res.body as any).error.code).toBe("staff_model_cap");
    expect(bearerState.rpcCalls.map((c) => c.name)).not.toContain("send_agent_chat_turn");
    expect(order).toEqual([]);
  });
});

describe("chat-send staff ?model= gate placement", () => {
  const src = readFileSync(join(__dirname, "../../routes/agents/chat-send.ts"), "utf8");
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  const gateIdx = code.indexOf("decideStaffModel(");
  it("runs after the batch approval fast path and before the barge-in probe and run creation", () => {
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(code.indexOf("dispatchBatchFanout("));
    expect(gateIdx).toBeLessThan(code.indexOf("enqueue_or_steer_chat_turn"));
    expect(gateIdx).toBeLessThan(code.indexOf("\"send_agent_chat_turn\""));
  });
});
