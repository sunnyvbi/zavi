import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  claimLost: false,
  rows: {} as Record<string, unknown>,
  replies: [] as unknown[],
  queries: [] as Array<{ table: string; op: string; filters: Array<[string, unknown]>; payload?: unknown }>,
  distillCalls: [] as Array<Record<string, unknown>>,
  distillResult: { written: 1, skipped: 0, failed: 0, tokens: { input: 0, output: 0 } },
  logged: [] as unknown[],
  writeNoteCalls: 0,
  proposals: [] as Array<{ id: string; title: string; body: string; tags: string[] }>,
  ledger: 1,
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const rec = { table, op: "select", filters: [] as Array<[string, unknown]>, payload: undefined as unknown };
      H.queries.push(rec);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      for (const f of ["eq", "gte", "lt", "order", "limit", "like", "in", "is", "or", "not"]) {
        b[f] = (col: string, val: unknown) => {
          rec.filters.push([`${f}:${col}`, val]);
          return b;
        };
      }
      b.update = (p: unknown) => {
        rec.op = "update";
        rec.payload = p;
        return b;
      };
      b.maybeSingle = async () => ({ data: H.rows[table] ?? null, error: null });
      b.then = (res: (v: unknown) => unknown) => {
        if (table === "agent_thread_messages" && rec.op === "select") return res({ data: H.replies, error: null });
        if (table === "agent_thread_messages" && (rec.payload as { distill_claimed_at?: unknown })?.distill_claimed_at) {
          const has = (k: string) => rec.filters.some(([f]) => f === k);
          const won =
            has("eq:tenant_id") &&
            has("is:distilled_at") &&
            rec.filters.some(([f]) => f.startsWith("or:distill_claimed_at.is.null,distill_claimed_at.lt."));
          return res({ data: won && !H.claimLost ? [{ id: "claimed" }] : [], error: null });
        }
        return res({ data: [], error: null });
      };
      return b;
    },
    rpc: async () => ({ data: H.ledger, error: null }),
  }),
}));
vi.mock("@/services/memory/distill", () => ({
  CHAT_DISTILL_SYSTEM_PROMPT: "chat",
  AGENT_RUN_DISTILL_SYSTEM_PROMPT: "run",
  runDistill: vi.fn(async (input: Record<string, unknown>) => {
    H.distillCalls.push(input);
    return H.distillResult;
  }),
}));
vi.mock("@/services/memory/write-path", () => ({
  recordWrites: vi.fn(async (_t: string, entries: unknown[]) => {
    H.logged.push(...entries);
  }),
  loadPendingProposals: vi.fn(async () => H.proposals),
  MAX_PROPOSALS_PER_RUN: 10,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/memory", () => ({
  writeNote: vi.fn(async () => {
    H.writeNoteCalls += 1;
    return { note_id: "x", chunks: 0, entities: 0 };
  }),
}));
vi.mock("@/services/memory/live-connectors", () => ({ liveConnectorsForTenant: vi.fn(async () => []) }));
vi.mock("@/services/agents/should-distill", () => ({ shouldDistillRun: vi.fn(() => ({ ok: true })) }));
vi.mock("@/services/agents/connector-skill", () => ({ recordConnectorSkillForRun: vi.fn(async () => {}) }));

import { distillChatTurn } from "../distill-chat-turn";
import { distillAgentRun } from "../distill-agent-run";

const T = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";

function stamped(table: string) {
  return H.queries.some((q) => q.table === table && q.op === "update" && (q.payload as { distilled_at?: string })?.distilled_at);
}

beforeEach(() => {
  H.rows = {};
  H.replies = [];
  H.queries = [];
  H.distillCalls = [];
  H.distillResult = { written: 1, skipped: 0, failed: 0, tokens: { input: 0, output: 0 } };
  H.logged = [];
  H.writeNoteCalls = 0;
  H.proposals = [];
  H.ledger = 1;
  H.claimLost = false;
});

describe("distill-chat-turn", () => {
  beforeEach(() => {
    H.rows.agent_runs = {
      id: RUN, tenant_id: T, agent_slug: "operator", trigger: "chat",
      payload: { thread_id: "th-1", user_message_id: "um-1" }, tool_calls: [],
    };
    H.rows.agent_thread_messages = { id: "um-1", sender_role: "user", body: "our take rate is now 18%", created_at: "2026-09-29T00:00:00Z", distilled_at: null };
    H.replies = [{ id: "reply-of-this-run", sender_role: "assistant", body: "Noted.", created_at: "x", distilled_at: null, agent_run_id: RUN }];
  });

  it("pairs the reply by agent_run_id, not by 'first assistant message after'", async () => {
    await distillChatTurn(RUN);
    const replyQuery = H.queries.find(
      (q) => q.table === "agent_thread_messages" && q.filters.some(([k, v]) => k === "eq:sender_role" && v === "assistant"),
    )!;
    expect(replyQuery.filters).toContainEqual(["in:agent_run_id", [RUN]]);
    expect(replyQuery.filters).toContainEqual(["eq:tenant_id", T]);
    expect(replyQuery.filters.some(([k]) => k === "gte:created_at")).toBe(false);
  });

  it("passes the gate: tier-0 ceiling, the turn text, the run and the reply message", async () => {
    await distillChatTurn(RUN);
    expect(H.distillCalls[0].gate).toEqual({
      ceiling: 0,
      queryText: "our take rate is now 18%\n\nNoted.",
      run_id: RUN,
      thread_message_id: "reply-of-this-run",
    });
  });

  it("a turn carrying captured page content can be tier 2 at best", async () => {
    (H.rows.agent_runs as Record<string, unknown>).payload = {
      thread_id: "th-1", user_message_id: "um-1", page_context: { mode: "text", text: "page" },
    };
    await distillChatTurn(RUN);
    expect((H.distillCalls[0].gate as { ceiling: number }).ceiling).toBe(2);
  });

  it("claims the turn with tenant, not-yet-distilled and empty-or-stale lease conditions", async () => {
    await distillChatTurn(RUN);
    const claim = H.queries.find(
      (q) => q.table === "agent_thread_messages" && (q.payload as { distill_claimed_at?: unknown } | undefined)?.distill_claimed_at,
    )!;
    expect(claim.filters).toContainEqual(["eq:tenant_id", T]);
    expect(claim.filters).toContainEqual(["is:distilled_at", null]);
    expect(claim.filters.some(([k]) => k.startsWith("or:distill_claimed_at.is.null,distill_claimed_at.lt."))).toBe(true);
    expect(H.distillCalls).toHaveLength(1);
  });

  it("a claim another worker holds: no extractor call and nothing stamped", async () => {
    H.claimLost = true;
    await distillChatTurn(RUN);
    expect(H.distillCalls).toHaveLength(0);
    expect(stamped("agent_runs")).toBe(false);
  });

  it("a failed note write throws and leaves the turn un-stamped for the retry", async () => {
    H.distillResult = { ...H.distillResult, failed: 1 };
    await expect(distillChatTurn(RUN)).rejects.toThrow(/note write/);
    expect(stamped("agent_runs")).toBe(false);
  });
});

describe("distill-agent-run", () => {
  beforeEach(() => {
    H.rows.agent_runs = {
      id: RUN, tenant_id: T, agent_slug: "cgo", trigger: "cron", status: "success",
      output_text: "Reviewed Meta ads. The Meta pixel ID is 1234567890.", distilled_at: null,
      parsed: null, payload: null, tool_calls: [],
    };
  });

  it("writes no task card and passes the gate with an agent-run ceiling", async () => {
    await distillAgentRun(RUN);
    expect(H.writeNoteCalls).toBe(0);
    expect(H.distillCalls[0].gate).toEqual({
      ceiling: 2,
      queryText: "Reviewed Meta ads. The Meta pixel ID is 1234567890.",
      run_id: RUN,
    });
    expect(stamped("agent_runs")).toBe(true);
  });

  it("skips the extractor for an output that is an agent envelope, and logs the skip", async () => {
    (H.rows.agent_runs as Record<string, unknown>).output_text = '<goal_moves> {"move":"raise","by":20}';
    const r = await distillAgentRun(RUN);
    expect(H.distillCalls).toHaveLength(0);
    expect(H.logged).toEqual([expect.objectContaining({ action: "junk", run_id: RUN, reason: "junk:tagged_envelope" })]);
    expect(r).toEqual({ written: 0, skipped: 1 });
    expect(stamped("agent_runs")).toBe(true);
  });

  it("a failed note write throws and does not stamp distilled_at", async () => {
    H.distillResult = { ...H.distillResult, failed: 2 };
    await expect(distillAgentRun(RUN)).rejects.toThrow(/2 note write/);
    expect(stamped("agent_runs")).toBe(false);
  });
});

describe("memory_write proposals reach the extractor", () => {
  const PROP = { id: "prop-1", title: "Take rate", body: "Take rate is 15%.", tags: [] };
  const TRANSCRIPT_OFF = "not used for memory here";

  describe("distill-agent-run", () => {
    beforeEach(() => {
      H.proposals = [PROP];
      H.rows.agent_runs = {
        id: RUN, tenant_id: T, agent_slug: "c-aaaaaaaa01", trigger: "cron", status: "success",
        output_text: "Reviewed pricing. Take rate looks like 15% now.", distilled_at: null,
        parsed: null, payload: null, tool_calls: [],
      };
    });

    it("passes the run's pending proposals and its agent", async () => {
      await distillAgentRun(RUN);
      expect(H.distillCalls[0].proposals).toEqual({ agent_slug: "c-aaaaaaaa01", items: [PROP] });
      expect(H.distillCalls[0].userPrompt).toContain("Reviewed pricing");
    });

    it("a junk output with proposals still runs the extractor on the proposals only", async () => {
      (H.rows.agent_runs as Record<string, unknown>).output_text = '<goal_moves> {"move":"raise","by":20}';
      await distillAgentRun(RUN);
      expect(H.logged).toEqual([expect.objectContaining({ action: "junk" })]);
      expect(H.distillCalls).toHaveLength(1);
      expect(H.distillCalls[0].userPrompt).toContain(TRANSCRIPT_OFF);
      expect(H.distillCalls[0].userPrompt).not.toContain("goal_moves");
      expect(stamped("agent_runs")).toBe(true);
    });

    it("a channel recipe run with proposals judges only the proposals", async () => {
      (H.rows.agent_runs as Record<string, unknown>).trigger = "channel_recipe";
      await distillAgentRun(RUN);
      expect(H.distillCalls).toHaveLength(1);
      expect(H.distillCalls[0].userPrompt).toContain(TRANSCRIPT_OFF);
      expect(H.distillCalls[0].userPrompt).not.toContain("Reviewed pricing");
    });

    it("over the daily cap, proposals are still judged (transcript skipped)", async () => {
      H.ledger = 999;
      await distillAgentRun(RUN);
      expect(H.distillCalls).toHaveLength(1);
      expect(H.distillCalls[0].userPrompt).toContain(TRANSCRIPT_OFF);
    });

    it("an already-distilled run with pending proposals (a re-queue) judges only the proposals", async () => {
      (H.rows.agent_runs as Record<string, unknown>).distilled_at = "2026-09-29T00:00:00Z";
      await distillAgentRun(RUN);
      expect(H.distillCalls).toHaveLength(1);
      expect(H.distillCalls[0].userPrompt).toContain(TRANSCRIPT_OFF);
    });

    it("an already-distilled run with nothing pending is a no-op", async () => {
      H.proposals = [];
      (H.rows.agent_runs as Record<string, unknown>).distilled_at = "2026-09-29T00:00:00Z";
      await distillAgentRun(RUN);
      expect(H.distillCalls).toHaveLength(0);
    });

    it("tells the length gate that proposals are pending", async () => {
      const { shouldDistillRun } = await import("@/services/agents/should-distill");
      await distillAgentRun(RUN);
      expect(shouldDistillRun).toHaveBeenCalledWith(expect.objectContaining({ has_pending_proposals: true }));
    });
  });

  describe("distill-chat-turn", () => {
    beforeEach(() => {
      H.proposals = [PROP];
      H.rows.agent_runs = {
        id: RUN, tenant_id: T, agent_slug: "operator", trigger: "chat",
        payload: { thread_id: "th-1", user_message_id: "um-1" }, tool_calls: [],
      };
      H.rows.agent_thread_messages = { id: "um-1", sender_role: "user", body: "what is our take rate?", created_at: "2026-09-29T00:00:00Z", distilled_at: null };
      H.replies = [{ id: "reply-of-this-run", sender_role: "assistant", body: "15%.", created_at: "x", distilled_at: null, agent_run_id: RUN }];
    });

    it("passes the run's pending proposals with the turn", async () => {
      await distillChatTurn(RUN);
      expect(H.distillCalls[0].proposals).toEqual({ agent_slug: "operator", items: [PROP] });
      expect((H.distillCalls[0].gate as { ceiling: number }).ceiling).toBe(0);
    });

    it("an already-distilled turn with pending proposals judges only them, at agent trust", async () => {
      (H.rows.agent_thread_messages as Record<string, unknown>).distilled_at = "2026-09-29T00:00:00Z";
      await distillChatTurn(RUN);
      expect(H.distillCalls).toHaveLength(1);
      expect(H.distillCalls[0].userPrompt).toContain(TRANSCRIPT_OFF);
      expect(H.distillCalls[0].userPrompt).not.toContain("what is our take rate");
      expect((H.distillCalls[0].gate as { ceiling: number }).ceiling).toBe(2);
    });

    it("an already-distilled turn with nothing pending is a no-op", async () => {
      H.proposals = [];
      (H.rows.agent_thread_messages as Record<string, unknown>).distilled_at = "2026-09-29T00:00:00Z";
      await distillChatTurn(RUN);
      expect(H.distillCalls).toHaveLength(0);
    });
  });
});
