
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

function makeCtx(slug = "performance-marketer"): AgentContext {
  return {
    agent: {
      slug,
      metadata_praxis: { requires_sandbox: false, output_envelope: "digest" },
    },
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

function persistedMeta(): Record<string, unknown> {
  const call = rpcMock.mock.calls.find((c) => c[0] === "record_agent_chat_reply");
  if (!call) throw new Error("record_agent_chat_reply was never called");
  return (call[1] as { p_meta: Record<string, unknown> }).p_meta;
}
function persistedBody(): string {
  const call = rpcMock.mock.calls.find((c) => c[0] === "record_agent_chat_reply");
  return (call![1] as { p_body: string }).p_body;
}

function arrangeThread(slug: string): void {
  fromMock.mockReset();
  fromMock.mockImplementation(() => stubChain([]));
  fromMock.mockImplementationOnce(() => stubChain(null));
  fromMock.mockImplementationOnce(() =>
    stubChain({ tenant_id: "tenant-A", agent_slug: slug }),
  );
  fromMock.mockImplementationOnce(() =>
    stubChain({ thread_id: "t1", sender_role: "user", body: "the ask" }),
  );
}

beforeEach(() => {
  fromMock.mockReset();
  rpcMock.mockReset();
  runGenericMock.mockReset();
  getEffectiveVisibilityMock.mockReset();
  getEffectiveVisibilityMock.mockResolvedValue({ visible: true, reason: "default_enabled" });
  rpcMock.mockResolvedValue({ data: "msg-id", error: null });
  arrangeThread("performance-marketer");
});

describe("chat-dispatcher — collapsed-reply overflow persistence", () => {
  it("SCRUBS PII out of the overflow body before persisting it (E3)", async () => {
    runGenericMock.mockResolvedValueOnce({
      output_text: "Short lead.",
      parsed: {
        metadata: {
          report_lead_collapsed: true,
          full_reply_markdown: "Full digest. Reach the buyer at jane.doe@example.com about it.",
        },
      },
      parse_ok: true,
      raw_response_text: "Short lead.",
      prompt_snapshot: "",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    const meta = persistedMeta();
    const overflow = JSON.stringify(meta);
    expect(overflow).not.toContain("jane.doe@example.com");
    expect(String(meta.full_reply_markdown)).toContain("Full digest.");
  });

  it("stamps the proof-of-scrub marker the web reader gates on (E3)", async () => {
    runGenericMock.mockResolvedValueOnce({
      output_text: "Short lead.",
      parsed: {
        metadata: { report_lead_collapsed: true, full_reply_markdown: "The complete answer." },
      },
      parse_ok: true,
      raw_response_text: "Short lead.",
      prompt_snapshot: "",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    expect(persistedMeta().overflow_scrubbed).toBe(true);
  });

  it("writes the overflow to a TOP-LEVEL meta key, not only inside meta.envelope", async () => {
    runGenericMock.mockResolvedValueOnce({
      output_text: "Short lead.",
      parsed: {
        metadata: { report_lead_collapsed: true, full_reply_markdown: "The complete answer." },
      },
      parse_ok: true,
      raw_response_text: "Short lead.",
      prompt_snapshot: "",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    expect(persistedMeta().full_reply_markdown).toBe("The complete answer.");
  });

  it("KEEPS the overflow when a clarify envelope overwrites meta.envelope (data-loss guard)", async () => {
    runGenericMock.mockResolvedValueOnce({
      output_text: "Short lead.",
      parsed: {
        metadata: { report_lead_collapsed: true, full_reply_markdown: "The complete answer." },
      },
      clarify_envelope: { envelope_kind: "clarifying_questions", questions: [] },
      parse_ok: true,
      raw_response_text: "Short lead.",
      prompt_snapshot: "",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    const meta = persistedMeta();
    expect((meta.envelope as { envelope_kind?: string })?.envelope_kind).toBe(
      "clarifying_questions",
    );
    expect(meta.full_reply_markdown).toBe("The complete answer.");
  });

  it("leaves a normal (non-collapsed) reply's meta free of overflow keys", async () => {
    runGenericMock.mockResolvedValueOnce({
      output_text: "Just a normal reply.",
      parsed: { metadata: {} },
      parse_ok: true,
      raw_response_text: "Just a normal reply.",
      prompt_snapshot: "",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    const meta = persistedMeta();
    expect(meta.full_reply_markdown).toBeUndefined();
    expect(meta.body_truncated).toBeUndefined();
  });
});

describe("chat-dispatcher — over-cap body is marked, never silently sliced", () => {
  it("stamps meta.body_truncated and preserves the full text on the overflow channel", async () => {
    arrangeThread("engineer");
    const huge = "x".repeat(40_000);
    runGenericMock.mockResolvedValueOnce({
      output_text: huge,
      parsed: null,
      parse_ok: true,
      raw_response_text: huge,
      prompt_snapshot: "",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await runChat(makeCtx("engineer"), { thread_id: "t1", user_message_id: "u1" });

    const meta = persistedMeta();
    expect(persistedBody().length).toBeLessThanOrEqual(32_000);
    expect(meta.body_truncated).toBe(true);
    expect(String(meta.full_reply_markdown).length).toBeGreaterThan(32_000);
  });
});
