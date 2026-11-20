
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  runGenericMock: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: mocks.fromMock, rpc: mocks.rpcMock }),
  serverClientFromBearer: () => ({}),
}));
vi.mock("../generic-dispatcher", () => ({ runGeneric: mocks.runGenericMock }));
vi.mock("@/agents/index", () => ({
  postProcessors: {},
}));

import { runChat } from "../chat-dispatcher";
import type { AgentContext } from "../types";

const fromMock = mocks.fromMock;
const rpcMock = mocks.rpcMock;
const runGenericMock = mocks.runGenericMock;

function makeCtx(slug = "engineer"): AgentContext {
  return {
    agent: {
      slug,
      metadata_praxis: { requires_sandbox: true },
    } as never,
    tenant_id: "tenant-A",
    tenantConfig: {} as never,
    memory: {} as never,
    anthropic: {} as never,
    runId: "run-1",
    trigger: "chat" as never,
    scanRecentRuns: vi.fn(),
    emitDecision: vi.fn(),
    emitProgress: vi.fn(),
  } as never;
}

function stubChain(rows: unknown, err: unknown = null) {
  const result = Promise.resolve({ data: rows, error: err });
  const chain: Record<string, unknown> = {};
  const allMethods = [
    "select", "eq", "neq", "lt", "gte", "filter", "in_",
    "order", "limit", "contains", "update",
  ];
  for (const m of allMethods) chain[m] = vi.fn(() => chain);
  chain.single = vi.fn(() => result);
  chain.maybeSingle = vi.fn(() => result);
  chain.limit = vi.fn(() => result);
  return chain;
}

beforeEach(() => {
  fromMock.mockReset();
  rpcMock.mockReset();
  runGenericMock.mockReset();
  runGenericMock.mockResolvedValue({
    output_text: "ok",
    parsed: null,
    parse_ok: true,
    raw_response_text: "ok",
    prompt_snapshot: "",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  rpcMock.mockResolvedValue({ data: "msg-id", error: null });
  fromMock.mockImplementation(() => stubChain([]));
  fromMock.mockImplementationOnce(() => stubChain(null));
});

function setupThreadChain(threadOverrides: Record<string, unknown>) {
  fromMock
    .mockImplementationOnce(() =>
      stubChain({
        id: "t1",
        tenant_id: "tenant-A",
        agent_slug: "engineer",
        sdk_session_id: null,
        ...threadOverrides,
      }),
    )
    .mockImplementationOnce(() =>
      stubChain({
        id: "u1",
        body: "fix the login bug",
        created_at: "2026-05-10T00:01:00Z",
        sender_role: "user",
        thread_id: "t1",
      }),
    )
    .mockImplementationOnce(() => stubChain([]))
    .mockImplementationOnce(() => stubChain([]))
    .mockImplementationOnce(() => stubChain([]))
    .mockImplementationOnce(() => stubChain([]))
    .mockImplementationOnce(() => stubChain([]));
}

describe("chat-dispatcher — per-thread repo fallback (Slice 2)", () => {
  it("(a) thread has repo_full_name + no payload repo_hint → dispatched payload carries thread's repo", async () => {
    setupThreadChain({ repo_full_name: "rravi149/praxis" });

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    expect(runGenericMock).toHaveBeenCalledOnce();
    const [, dispatchedPayload] = runGenericMock.mock.calls[0] as [
      AgentContext,
      Record<string, unknown>,
    ];
    expect(dispatchedPayload.repo_hint).toBe("rravi149/praxis");
  });

  it("(a) thread repo set → awaiting_repo_pick RPC is NOT called (no re-ask)", async () => {
    setupThreadChain({ repo_full_name: "rravi149/praxis" });

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    for (const call of rpcMock.mock.calls) {
      const [, args] = call as [string, Record<string, unknown>];
      const meta = (args?.p_meta ?? {}) as Record<string, unknown>;
      expect(meta.awaiting_repo_pick).not.toBe(true);
    }
  });

  it("(b) explicit payload repo_hint wins over thread's repo_full_name", async () => {
    setupThreadChain({ repo_full_name: "rravi149/praxis" });

    await runChat(makeCtx(), {
      thread_id: "t1",
      user_message_id: "u1",
      repo_hint: "rravi149/upcar",
    });

    expect(runGenericMock).toHaveBeenCalledOnce();
    const [, dispatchedPayload] = runGenericMock.mock.calls[0] as [
      AgentContext,
      Record<string, unknown>,
    ];
    expect(dispatchedPayload.repo_hint).toBe("rravi149/upcar");
  });

  it("(c) thread repo null + no payload repo_hint → repo_hint stays absent (resolver handles it)", async () => {
    setupThreadChain({ repo_full_name: null });

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    expect(runGenericMock).toHaveBeenCalledOnce();
    const [, dispatchedPayload] = runGenericMock.mock.calls[0] as [
      AgentContext,
      Record<string, unknown>,
    ];
    expect(dispatchedPayload.repo_hint == null || dispatchedPayload.repo_hint === "").toBe(true);
  });

  it("(c-variant) thread repo_full_name field absent entirely → repo_hint stays absent", async () => {
    setupThreadChain({});

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    const [, dispatchedPayload] = runGenericMock.mock.calls[0] as [
      AgentContext,
      Record<string, unknown>,
    ];
    expect(dispatchedPayload.repo_hint == null || dispatchedPayload.repo_hint === "").toBe(true);
  });
});
