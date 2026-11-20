import { describe, it, expect, vi, beforeEach } from "vitest";

const attach = vi.fn();
const list = vi.fn();
vi.mock("@/services/approvals/chat-card-attach", () => ({
  attachCardToChat: (...a: unknown[]) => attach(...a),
  listOpenCards: (...a: unknown[]) => list(...a),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
const decide = vi.fn();
vi.mock("@/services/approvals/decide-service", () => ({ decideDecision: decide, default: decide }));

import { callCardTool, showCardTellFounder } from "../praxis-cards";

const ID = "8af34774-0000-4000-8000-000000000001";
const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;

beforeEach(() => {
  attach.mockReset();
  list.mockReset();
  decide.mockReset();
});

describe("praxis__show_card", () => {
  it("must-catch: shows the waiting card in this chat, moved down to this reply, and tells the founder to tap its Approve", async () => {
    attach.mockResolvedValue({ shown: true, already: true, card_id: ID, table: "decisions", what: "Cut “Atlanta Search” from $20 to $10 a day" });
    const r = await callCardTool({ tenant_id: "t1", run_id: "run-1" }, "show_card", { card_id: ID }, Date.now());
    expect(r.ok).toBe(true);
    expect(attach).toHaveBeenCalledWith({ tenant_id: "t1", run_id: "run-1", card_id: ID, bringToLatest: true });
    expect(parse(r).tell_founder).toMatch(/Approve/);
    expect(decide).not.toHaveBeenCalled();
  });

  it("must-not-touch: a shadow/draft run, a bad id, or a missing run writes nothing", async () => {
    expect(parse(await callCardTool({ tenant_id: "t1", run_id: "r", writes_suppressed: true }, "show_card", { card_id: ID }, 0)).error).toBe("not_chat");
    expect(parse(await callCardTool({ tenant_id: "t1", run_id: "r" }, "show_card", { card_id: "not-a-uuid" }, 0)).error).toBe("tool_input_invalid");
    expect(parse(await callCardTool({ tenant_id: "t1" }, "show_card", { card_id: ID }, 0)).error).toBe("not_chat");
    expect(attach).not.toHaveBeenCalled();
  });

  it("a read/write failure is a retryable tool error, never a throw", async () => {
    attach.mockRejectedValue(new Error("db down"));
    const r = await callCardTool({ tenant_id: "t1", run_id: "r" }, "show_card", { card_id: ID }, 0);
    expect(r.is_error).toBe(true);
    expect(parse(r)).toMatchObject({ error: "show_card_failed", retryable: true });
  });

  it("says plainly when there is nothing to tap", () => {
    expect(showCardTellFounder({ shown: false, reason: "not_waiting", card_id: ID, approved_by_source: "cgo" })).toMatch(/^Autopilot already approved/);
    expect(showCardTellFounder({ shown: false, reason: "not_waiting", card_id: ID, approved_by_source: null })).toMatch(/no longer waiting/);
    expect(showCardTellFounder({ shown: false, reason: "not_found", card_id: ID })).toMatch(/praxis__list_open_cards/);
  });
});

describe("praxis__list_open_cards", () => {
  it("lists the waiting cards with how to show one; an unreadable list says not to claim done", async () => {
    list.mockResolvedValue([{ card_id: ID, table: "decisions", what: "Cut", where: "under What needs you on the Your CGO page", filed_at: null, move_key: null }]);
    const r = parse(await callCardTool({ tenant_id: "t1" }, "list_open_cards", {}, 0));
    expect(r.cards).toHaveLength(1);
    expect(r.note).toMatch(/praxis__show_card/);
    list.mockRejectedValue(new Error("down"));
    expect(parse(await callCardTool({ tenant_id: "t1" }, "list_open_cards", {}, 0)).message).toMatch(/Do not say whether a change is done/);
  });
});
