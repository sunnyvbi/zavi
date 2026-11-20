
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  runGenericMock: vi.fn(),
  saveCopyMock: vi.fn(async (_ctx: unknown, _body: string) => 1),
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
vi.mock("../copy-block-artifacts", () => ({ saveCopyBlockArtifacts: mocks.saveCopyMock }));

import { runChat } from "../chat-dispatcher";
import type { AgentContext } from "../types";

const { fromMock, rpcMock, runGenericMock, getEffectiveVisibilityMock, saveCopyMock } = mocks;

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
  saveCopyMock.mockClear();
  getEffectiveVisibilityMock.mockReset();
  getEffectiveVisibilityMock.mockResolvedValue({ visible: true, reason: "default_enabled" });
  rpcMock.mockResolvedValue({ data: "msg-id", error: null });
  arrangeThread("performance-marketer");
});

function reply(text: string) {
  return {
    output_text: text,
    parsed: null,
    parse_ok: true,
    raw_response_text: text,
    prompt_snapshot: "",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function serveStoredReply(stored?: { body: string; meta: Record<string, unknown> }) {
  const base = fromMock.getMockImplementation();
  fromMock.mockImplementation((table: string) => {
    if (table !== "agent_thread_messages") return base!(table);
    const call = rpcMock.mock.calls.find((c) => c[0] === "record_agent_chat_reply");
    const row = stored ?? (call ? { body: (call[1] as { p_body: string }).p_body, meta: (call[1] as { p_meta: Record<string, unknown> }).p_meta } : null);
    return stubChain(row ? [row] : []);
  });
}

describe("chat-dispatcher — copy blocks to Artifacts", () => {
  it("saves from the scrubbed body the bubble shows, for this run and thread", async () => {
    serveStoredReply();
    runGenericMock.mockResolvedValueOnce(
      reply("```copy Reply\nThanks! Write to jane.doe@example.com for a refund.\n```\n\nKept it short."),
    );

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    expect(saveCopyMock).toHaveBeenCalledTimes(1);
    const [ctxArg, savedBody] = saveCopyMock.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(ctxArg).toEqual({
      tenant_id: "tenant-A",
      run_id: "run-1",
      agent_slug: "performance-marketer",
      thread_id: "t1",
    });
    expect(savedBody).toBe(persistedBody());
    expect(savedBody).not.toContain("jane.doe@example.com");
    expect(savedBody).toContain("```copy Reply");
  });

  it("on a retry, saves the reply already in the bubble, not the new attempt's text", async () => {
    serveStoredReply({ body: "```copy\nFirst attempt\n```", meta: {} });
    runGenericMock.mockResolvedValueOnce(reply("```copy\nSecond attempt\n```"));

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    expect(saveCopyMock.mock.calls[0][1]).toBe("```copy\nFirst attempt\n```");
  });

  it("on a retry with no copy in the new attempt, still saves the stored reply's copy", async () => {
    serveStoredReply({ body: "```copy\nFirst attempt\n```", meta: {} });
    runGenericMock.mockResolvedValueOnce(reply("Plain answer, no copy."));

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    expect(saveCopyMock.mock.calls[0][1]).toBe("```copy\nFirst attempt\n```");
  });

  it("reads an over-cap reply from the full overflow the bubble renders", async () => {
    serveStoredReply({
      body: "cut",
      meta: { body_truncated: true, full_reply_markdown: "long...\n```copy\nTail copy\n```" },
    });
    runGenericMock.mockResolvedValueOnce(reply("```copy\nx\n```"));

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    expect(saveCopyMock.mock.calls[0][1]).toContain("Tail copy");
  });

  it("still writes the reply when saving the copy fails", async () => {
    serveStoredReply();
    saveCopyMock.mockRejectedValueOnce(new Error("storage down"));
    runGenericMock.mockResolvedValueOnce(reply("```copy\nHello\n```"));

    await expect(runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" })).resolves.toBeDefined();
    expect(persistedBody()).toContain("Hello");
  });
});
