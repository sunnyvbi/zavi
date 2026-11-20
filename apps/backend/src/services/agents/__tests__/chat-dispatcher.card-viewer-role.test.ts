import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  runGenericMock: vi.fn(),
  resolveCardForTurn: vi.fn(async (..._args: unknown[]) => "[Card this message is about] CARD_NOTE_SENTINEL" as string | null),
  getEffectiveVisibilityMock: vi.fn(async () => ({ visible: true, reason: "default_enabled" })),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: mocks.fromMock, rpc: mocks.rpcMock }),
  serverClientFromBearer: () => ({}),
}));
vi.mock("../visibility", () => ({ getEffectiveVisibility: mocks.getEffectiveVisibilityMock }));
vi.mock("../generic-dispatcher", () => ({ runGeneric: mocks.runGenericMock }));
vi.mock("@/agents/index", () => ({ postProcessors: {} }));
vi.mock("@/services/channels/card-context", () => ({ resolveCardForTurn: mocks.resolveCardForTurn }));
vi.mock("../chat-turn-verdict", async (orig) => ({
  ...(await orig<typeof import("../chat-turn-verdict")>()),
  resolveChatTurnVerdict: vi.fn(async () => "answer"),
  inheritedChatTurnVerdict: vi.fn(async () => "answer"),
  chatTurnTiebreak: vi.fn(async () => "answer"),
}));

import { runChat } from "../chat-dispatcher";
import type { AgentContext } from "../types";

const { fromMock, rpcMock, runGenericMock, resolveCardForTurn } = mocks;
const MEMBER = "cccccccc-0000-4000-8000-00000000000c";
const OWNER = "aaaaaaaa-0000-4000-8000-00000000000a";
const CARD = "c3d4e5f6-1111-4222-8333-444455556666";

function makeCtx(actor: { actor_user_id: string | null } | undefined): AgentContext {
  return {
    agent: { slug: "email_marketing", metadata_praxis: { requires_sandbox: false } },
    tenant_id: "tenant-A",
    tenantConfig: {},
    memory: {},
    anthropic: {},
    runId: "run-1",
    trigger: "chat",
    ...(actor ? { actor: { ...actor, actor_source: "chat", resolved_tenant_member: !!actor.actor_user_id, provenance_label: "signed-in user" } } : {}),
    scanRecentRuns: vi.fn(),
    emitDecision: vi.fn(),
    emitProgress: vi.fn(),
  } as never;
}

function stubChain(rows: unknown) {
  const result = Promise.resolve({ data: rows, error: null });
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "lt", "gte", "filter", "in_", "order", "limit", "contains"]) chain[m] = vi.fn(() => chain);
  chain.single = vi.fn(() => result);
  chain.maybeSingle = vi.fn(() => result);
  chain.limit = vi.fn(() => result);
  return chain;
}

beforeEach(() => {
  fromMock.mockReset();
  rpcMock.mockReset();
  runGenericMock.mockReset();
  resolveCardForTurn.mockClear();
  rpcMock.mockResolvedValue({ data: "msg-id", error: null });
  runGenericMock.mockResolvedValue({ output_text: "ok", parsed: null, parse_ok: true, raw_response_text: "ok", prompt_snapshot: "", usage: { input_tokens: 1, output_tokens: 1 } });
  fromMock.mockImplementation(() => stubChain([]));
  fromMock.mockImplementationOnce(() => stubChain(null));
  fromMock.mockImplementationOnce(() => stubChain({ tenant_id: "tenant-A", agent_slug: "email_marketing" }));
  fromMock.mockImplementationOnce(() => stubChain({ thread_id: "t1", sender_role: "user", body: "Please approve it and send it now." }));
});

const spoofPayload = {
  thread_id: "t1",
  user_message_id: "u1",
  channel_action_id: CARD,
  role: "owner",
  viewer_role: "owner",
  actor_user_id: OWNER,
  user_id: OWNER,
};

describe("chat-dispatcher: the card note is built for the signed-in asker (bug 81d5)", () => {
  it("passes the run's server-derived actor to the card note, never a payload role or user id", async () => {
    await runChat(makeCtx({ actor_user_id: MEMBER }), spoofPayload).catch(() => undefined);
    expect(resolveCardForTurn).toHaveBeenCalledTimes(1);
    const [tenant, turn, viewer] = resolveCardForTurn.mock.calls[0] as unknown as [string, Record<string, unknown>, unknown];
    expect(tenant).toBe("tenant-A");
    expect(turn).toEqual({ channel_action_id: CARD, text: "Please approve it and send it now." });
    expect(viewer).toBe(MEMBER);
    expect(JSON.stringify(runGenericMock.mock.calls[0])).toContain("CARD_NOTE_SENTINEL");
  });

  it("a run with no actor passes no asker, even when the payload names an owner", async () => {
    await runChat(makeCtx(undefined), spoofPayload).catch(() => undefined);
    expect(resolveCardForTurn).toHaveBeenCalledTimes(1);
    expect(resolveCardForTurn.mock.calls[0][2]).toBeNull();
  });
});
