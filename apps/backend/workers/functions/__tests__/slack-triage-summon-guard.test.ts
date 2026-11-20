import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state: { ingestedRow: Record<string, unknown> | null } = { ingestedRow: null };
  const rpc = vi.fn(async () => ({ data: "ok" }));
  const enqueueAgentRun = vi.fn(async () => ({ run_id: "r1" }));
  const dispatchOperatorOnLowConf = vi.fn(async () => ({ kind: "enqueued", run_id: "r1" }));
  const addReaction = vi.fn(async () => {});
  const swapReaction = vi.fn(async () => {});
  function from(table: string) {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      update: () => chain,
      insert: async () => ({ error: null }),
      maybeSingle:
        table === "ingested_events"
          ? async () => ({ data: state.ingestedRow })
          : async () => ({ data: { bot_user_id: "UBOT" } }),
    };
    return chain;
  }
  return { state, rpc, enqueueAgentRun, dispatchOperatorOnLowConf, addReaction, swapReaction, from };
});

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: h.from, rpc: h.rpc }) }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: h.enqueueAgentRun }));
vi.mock("@/services/slack/dispatch-operator-on-low-conf", () => ({
  dispatchOperatorOnLowConf: h.dispatchOperatorOnLowConf,
  LOW_CONF_PLACEHOLDER: "x",
}));
vi.mock("@/services/tools/slack/_reactions", () => ({
  ACK_EMOJI: "eyes",
  addReaction: h.addReaction,
  swapReaction: h.swapReaction,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn(async () => ({ is_error: false })) }));

import { triageOne } from "../slack-triage";

function slackRow(text: string): Record<string, unknown> {
  return {
    id: "ing-1",
    tenant_id: "t1",
    provider: "slack",
    external_event_id: "Ev1",
    payload: {
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "UHUMAN",
        ts: "1781285566.363199",
        text,
      },
    },
  };
}

beforeEach(() => {
  h.rpc.mockClear();
  h.enqueueAgentRun.mockClear();
  h.dispatchOperatorOnLowConf.mockClear();
  h.addReaction.mockClear();
  h.swapReaction.mockClear();
  h.rpc.mockResolvedValue({ data: "ok" });
});

describe("slack-triage summon guard — no operator side effects on a summon", () => {
  it("summon message → skip notetaker_summon, zero producing side effects", async () => {
    h.state.ingestedRow = slackRow(
      "can you join <https://meet.google.com/eox-aobn-kaz?authuser=0>",
    );
    const res = await triageOne("ing-1", "trace");
    expect(res).toEqual({ skip: "notetaker_summon" });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.addReaction).not.toHaveBeenCalled();
    expect(h.enqueueAgentRun).not.toHaveBeenCalled();
    expect(h.dispatchOperatorOnLowConf).not.toHaveBeenCalled();
  });

  it("non-summon message → guard does NOT fire (consume runs)", async () => {
    h.rpc.mockResolvedValueOnce({ data: "rate_limited" });
    h.state.ingestedRow = slackRow("hey can you pull the latest ad numbers");
    const res = await triageOne("ing-1", "trace");
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(res).not.toEqual({ skip: "notetaker_summon" });
  });

  it("image file_share message → DELIBERATELY skipped here (ack handled by webhook; images flow via direct-wake)", async () => {
    const row = slackRow("Can you fix this issue");
    (row.payload as { event: Record<string, unknown> }).event.subtype = "file_share";
    h.state.ingestedRow = row;
    const res = await triageOne("ing-1", "trace");
    expect(res).toEqual({ skip: "subtype:file_share" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("message_changed subtype → STILL skipped at subtype guard (edits not reprocessed)", async () => {
    const row = slackRow("edited");
    (row.payload as { event: Record<string, unknown> }).event.subtype = "message_changed";
    h.state.ingestedRow = row;
    const res = await triageOne("ing-1", "trace");
    expect(res).toEqual({ skip: "subtype:message_changed" });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
