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

describe("channel chat audit: card failure reporting", () => {
  it("reports failure consistently in the reply and envelope", async () => {
    fromMock
      .mockImplementationOnce(() => stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "meta_ads" }))
      .mockImplementationOnce(() => stubChain({ id: "u1", body: "Please make that card", created_at: "2026-05-10T00:01:00Z", sender_role: "user", thread_id: "t1" }));
    const claim = "I created the requested card. You can review it on the channel page.";
    const ctx = makeCtx({ slug: "meta_ads" });
    ctx.agent.metadata_praxis.output_envelope = "digest";
    runGenericMock.mockResolvedValueOnce({ output_text: claim, parsed: { rendered_markdown: claim, steps: [{ title: "Pause campaign" }] }, parse_ok: true, raw_response_text: claim, prompt_snapshot: "", usage: { input_tokens: 1, output_tokens: 1 } });
    postProcessorSpy.mockRejectedValueOnce(new Error("channel stamp not confirmed; cards not filed"));
    const result = await runChat(ctx, { thread_id: "t1", user_message_id: "u1" });
    expect(result.parse_error).toContain("post_process_threw");
    expect(rpcMock).toHaveBeenCalledWith("record_agent_chat_reply", expect.objectContaining({
      p_body: expect.stringContaining("couldn't finish saving"),
      p_meta: expect.objectContaining({
        envelope: expect.objectContaining({ rendered_markdown: expect.stringContaining("couldn't finish saving"), steps: [] }),
      }),
    }));
  });
});
