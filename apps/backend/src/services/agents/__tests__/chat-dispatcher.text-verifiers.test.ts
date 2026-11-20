import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  runGenericMock: vi.fn(),
  getEffectiveVisibilityMock: vi.fn(async () => ({
    visible: true,
    reason: "default_enabled",
  })),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: mocks.fromMock, rpc: mocks.rpcMock }),
  serverClientFromBearer: () => ({}),
}));
vi.mock("../visibility", () => ({
  getEffectiveVisibility: mocks.getEffectiveVisibilityMock,
}));
vi.mock("../generic-dispatcher", () => ({ runGeneric: mocks.runGenericMock }));
vi.mock("@/agents/index", () => ({ postProcessors: {} }));

import { runChat } from "../chat-dispatcher";
import type { AgentContext } from "../types";

const { fromMock, rpcMock, runGenericMock, getEffectiveVisibilityMock } = mocks;

function makeCtx(slug: string): AgentContext {
  return {
    agent: { slug, metadata_praxis: { requires_sandbox: false } },
    tenant_id: "tenant-A",
    tenantConfig: {},
    memory: {},
    anthropic: {},
    runId: "run-1",
    trigger: "chat",
    scanRecentRuns: vi.fn(),
    emitDecision: vi.fn(),
    emitProgress: vi.fn(),
  } as never;
}

function stubChain(rows: unknown, err: unknown = null) {
  const result = Promise.resolve({ data: rows, error: err });
  const chain: Record<string, unknown> = {};
  for (const m of [
    "select", "eq", "neq", "lt", "gte", "filter", "in_", "order", "limit", "contains",
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => result);
  chain.maybeSingle = vi.fn(() => result);
  chain.limit = vi.fn(() => result);
  return chain;
}

function persistedBody(): string | undefined {
  const call = rpcMock.mock.calls.find((c) => c[0] === "record_agent_chat_reply");
  return call?.[1]?.p_body as string | undefined;
}

function persistedMeta(): Record<string, unknown> | undefined {
  const call = rpcMock.mock.calls.find((c) => c[0] === "record_agent_chat_reply");
  return call?.[1]?.p_meta as Record<string, unknown> | undefined;
}

function primeChain(slug: string) {
  fromMock.mockImplementation(() => stubChain([]));
  fromMock.mockImplementationOnce(() => stubChain(null));
  fromMock.mockImplementationOnce(() =>
    stubChain({ tenant_id: "tenant-A", agent_slug: slug, id: "t1" }),
  );
  fromMock.mockImplementationOnce(() =>
    stubChain({
      id: "u1",
      thread_id: "t1",
      sender_role: "user",
      body: "what's the cap?",
    }),
  );
}

async function runTurn(slug: string, text: string) {
  primeChain(slug);
  runGenericMock.mockResolvedValue({
    output_text: text,
    parsed: null,
    parse_ok: true,
    raw_response_text: text,
    prompt_snapshot: "",
    usage: { input_tokens: 1, output_tokens: 1 },
    tool_calls: [],
  });
  await runChat(makeCtx(slug), { thread_id: "t1", user_message_id: "u1" });
}

beforeEach(() => {
  fromMock.mockReset();
  rpcMock.mockReset();
  runGenericMock.mockReset();
  getEffectiveVisibilityMock.mockReset();
  getEffectiveVisibilityMock.mockResolvedValue({
    visible: true,
    reason: "default_enabled",
  });
  rpcMock.mockResolvedValue({ data: "msg-id", error: null });
  fromMock.mockImplementation(() => stubChain([]));
});

describe("chat seam — text verifiers run BEFORE the bubble persists", () => {
  it("flags an ungrounded cap as TELEMETRY on the persisted bubble — no banner (reply-truth Slice 3)", async () => {
    const lie = "Host campaigns are capped at $50/week.";
    await runTurn("performance-marketer", lie);

    expect(persistedBody()).toBe(lie);
    expect(persistedMeta()).toMatchObject({ cap_grounding_fired: true });
  });

  it("leaves a grounded reply byte-identical", async () => {
    const clean = "I pulled the last 7 days of spend and nothing looks off.";
    await runTurn("performance-marketer", clean);

    expect(persistedBody()).toBe(clean);
    expect(persistedMeta()?.cap_grounding_fired).toBeUndefined();
  });

  it("does not arm a check for an agent outside its allowlist", async () => {
    const text = "Host campaigns are capped at $50/week.";
    await runTurn("qa", text);

    expect(persistedBody()).toBe(text);
  });
});
