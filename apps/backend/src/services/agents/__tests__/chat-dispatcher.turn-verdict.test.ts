import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  runGenericMock: vi.fn(),
  postProcessorSpy: vi.fn(async () => {}),
  getEffectiveVisibilityMock: vi.fn(async () => ({
    visible: true,
    reason: "default_enabled",
  })),
  loadReadyHtmlPreviewMock: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: mocks.fromMock, rpc: mocks.rpcMock }),
  serverClientFromBearer: () => ({}),
}));
vi.mock("../visibility", () => ({
  getEffectiveVisibility: mocks.getEffectiveVisibilityMock,
}));
vi.mock("../generic-dispatcher", () => ({ runGeneric: mocks.runGenericMock }));
vi.mock("@/agents/index", () => ({
  postProcessors: { "meta_ads": mocks.postProcessorSpy },
}));
vi.mock("../html-preview-artifacts", () => ({
  loadReadyHtmlPreview: mocks.loadReadyHtmlPreviewMock,
}));

import { runChat } from "../chat-dispatcher";
import { chatAnswerTurnEmit } from "../redo-mode";
import type { AgentContext } from "../types";

const fromMock = mocks.fromMock;
const rpcMock = mocks.rpcMock;
const runGenericMock = mocks.runGenericMock;
const postProcessorSpy = mocks.postProcessorSpy;
const getEffectiveVisibilityMock = mocks.getEffectiveVisibilityMock;
const loadReadyHtmlPreviewMock = mocks.loadReadyHtmlPreviewMock;

function makeCtx(overrides?: Partial<{ tenant_id: string; slug: string; runId: string; userId: string; runOwnerBroken: boolean }>): AgentContext {
  return {
    agent: {
      slug: overrides?.slug ?? "support-lead",
      metadata_praxis: { requires_sandbox: false },
    } as never,
    tenant_id: overrides?.tenant_id ?? "tenant-A",
    tenantConfig: {} as never,
    memory: {} as never,
    anthropic: {} as never,
    runId: overrides?.runId ?? "run-1",
    ...(overrides?.userId ? { userId: overrides.userId } : {}),
    ...(overrides?.runOwnerBroken ? { runOwnerBroken: true } : {}),
    trigger: "chat" as never,
    scanRecentRuns: vi.fn(),
    emitDecision: vi.fn(),
    emitProgress: vi.fn(),
  } as never;
}

function stubChain(rows: unknown, err: unknown = null) {
  const result = Promise.resolve({ data: rows, error: err });
  const chain: Record<string, unknown> = {};
  const allMethods = ["select", "eq", "neq", "lt", "gte", "filter", "in_", "order", "limit", "contains"];
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
  postProcessorSpy.mockReset();
  postProcessorSpy.mockResolvedValue(undefined);
  getEffectiveVisibilityMock.mockReset();
  getEffectiveVisibilityMock.mockResolvedValue({
    visible: true,
    reason: "default_enabled",
  });
  loadReadyHtmlPreviewMock.mockReset();
  loadReadyHtmlPreviewMock.mockResolvedValue(null);
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

async function turn(slug: string, text: string, payload: Record<string, unknown> = {}) {
  fromMock
    .mockImplementationOnce(() => stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: slug }))
    .mockImplementationOnce(() => stubChain({ id: "u1", body: text, created_at: "2026-10-21T00:01:00Z", sender_role: "user", thread_id: "t1" }));
  const ctx = makeCtx({ slug });
  const original = ctx.emitDecision;
  await runChat(ctx, { thread_id: "t1", user_message_id: "u1", ...payload });
  const seen = runGenericMock.mock.calls[0][0] as AgentContext;
  return { seen, original };
}

describe("channel chat turn verdict", () => {
  it("a question runs with the answer verdict and the refusing emitter", async () => {
    const { seen } = await turn("meta_ads", "why is my CPC high?");
    expect(seen.chat_turn_verdict).toBe("answer");
    expect(seen.emitDecision).toBe(chatAnswerTurnEmit);
    expect((postProcessorSpy.mock.calls[0] as unknown[])[0]).toMatchObject({ chat_turn_verdict: "answer" });
  });

  it("an order runs with the action verdict and the run's own emitter", async () => {
    const { seen, original } = await turn("meta_ads", "Raise the Meta budget to $80");
    expect(seen.chat_turn_verdict).toBe("action");
    expect(seen.emitDecision).toBe(original);
  });

  it("a payload key cannot set the verdict", async () => {
    const { seen } = await turn("meta_ads", "why is my CPC high?", { chat_turn_verdict: "action" });
    expect(seen.chat_turn_verdict).toBe("answer");
  });

  it("a non-channel agent's chat has no verdict and keeps its emitter", async () => {
    const { seen, original } = await turn("support-lead", "why is my CPC high?");
    expect(seen.chat_turn_verdict).toBeUndefined();
    expect(seen.emitDecision).toBe(original);
  });
});

it("a clarify continuation inherits the verdict of the turn that asked", async () => {
  const rowChain = (row: unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "lt", "gte", "filter", "in_", "order", "contains"]) c[m] = vi.fn(() => c);
    c.limit = vi.fn(() => Promise.resolve({ data: [], error: null }));
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: row, error: null }));
    c.single = c.maybeSingle;
    return c;
  };
  fromMock.mockImplementation((table: string) =>
    table === "agent_runs"
      ? rowChain({ agent_slug: "meta_ads", trigger: "chat", payload: { thread_id: "t1", user_message_id: "u0" } })
      : table === "agent_thread_messages"
        ? rowChain({ body: "Raise the Meta budget to $80", created_at: "2026-10-21T00:00:00Z", thread_id: "t1", sender_role: "user" })
        : stubChain([]),
  );
  const { seen } = await turn("meta_ads", "Answered the clarifying questions.", { prior_run_id: "run-0" });
  expect(seen.chat_turn_verdict).toBe("action");
});
