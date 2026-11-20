
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  runGenericMock: vi.fn(),
  buildOpenActionsBlockMock: vi.fn(),
  isUrgentFlagsAsCardsEnabledMock: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: mocks.fromMock, rpc: mocks.rpcMock }),
  serverClientFromBearer: () => ({}),
}));
vi.mock("../generic-dispatcher", () => ({ runGeneric: mocks.runGenericMock }));
vi.mock("@/agents/index", () => ({ postProcessors: {} }));
vi.mock("../visibility", () => ({
  getEffectiveVisibility: async () => ({
    visible: true,
    reason: "default_enabled",
  }),
}));
vi.mock("../open-actions", () => ({
  buildOpenActionsBlock: mocks.buildOpenActionsBlockMock,
}));
vi.mock("../_urgent-cards-flag-check", () => ({
  isUrgentFlagsAsCardsEnabled: mocks.isUrgentFlagsAsCardsEnabledMock,
}));

import { runChat } from "../chat-dispatcher";
import type { AgentContext } from "../types";

const { fromMock, rpcMock, runGenericMock } = mocks;
const OPEN_ACTIONS_SENTINEL = "OPEN-URGENT-ACTIONS-SENTINEL-BLOCK";

function stubChain(rows: unknown, err: unknown = null) {
  const result = Promise.resolve({ data: rows, error: err });
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "lt", "gte", "filter", "in_", "order", "limit", "contains"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => result);
  chain.maybeSingle = vi.fn(() => result);
  chain.limit = vi.fn(() => result);
  return chain;
}

function makeCtx(): AgentContext {
  return {
    agent: { slug: "support-lead", metadata_praxis: { requires_sandbox: false } } as never,
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

beforeEach(() => {
  fromMock.mockReset();
  rpcMock.mockReset();
  runGenericMock.mockReset();
  mocks.buildOpenActionsBlockMock.mockReset();
  mocks.isUrgentFlagsAsCardsEnabledMock.mockReset();

  runGenericMock.mockResolvedValue({
    output_text: "ok",
    parsed: null,
    parse_ok: true,
    raw_response_text: "ok",
    prompt_snapshot: "",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  rpcMock.mockResolvedValue({ data: "msg-id", error: null });
  mocks.buildOpenActionsBlockMock.mockResolvedValue(OPEN_ACTIONS_SENTINEL);

  fromMock.mockImplementation(() => stubChain([]));
  fromMock.mockImplementationOnce(() => stubChain(null));
  fromMock.mockImplementationOnce(() =>
    stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "support-lead" }),
  );
  fromMock.mockImplementationOnce(() =>
    stubChain({
      id: "u1",
      body: "now what?",
      created_at: "2026-05-10T00:01:00Z",
      sender_role: "user",
      thread_id: "t1",
    }),
  );
});

function messageSeenByRunGeneric(): string {
  const [, payloadArg] = runGenericMock.mock.calls[0] as [
    AgentContext,
    { current_message: string },
  ];
  return payloadArg.current_message;
}

describe("open-actions text-nag suppression (urgent_flags_as_cards_enabled)", () => {
  it("flag OFF → open-actions block IS injected (today's behavior)", async () => {
    mocks.isUrgentFlagsAsCardsEnabledMock.mockResolvedValue(false);

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    expect(mocks.buildOpenActionsBlockMock).toHaveBeenCalledOnce();
    expect(messageSeenByRunGeneric()).toContain(OPEN_ACTIONS_SENTINEL);
  });

  it("flag ON → open-actions block is NOT injected (cards replace the text nag)", async () => {
    mocks.isUrgentFlagsAsCardsEnabledMock.mockResolvedValue(true);

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    expect(mocks.buildOpenActionsBlockMock).not.toHaveBeenCalled();
    expect(messageSeenByRunGeneric()).not.toContain(OPEN_ACTIONS_SENTINEL);
  });
});
