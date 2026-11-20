import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({ id: "stub" }), send: vi.fn() } }));
vi.mock("../founder-order-advice", () => ({ readCardTenantById: vi.fn() }));
const logs = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => logs);
const ask = vi.fn();
vi.mock("@/services/growth/open-advice", () => ({ askFounderOutsideReview: (...a: unknown[]) => ask(...a) }));
const readCard = vi.fn();
vi.mock("@/services/approvals/chat-card-attach", () => ({ attachCardToChat: vi.fn(), readCard: (...a: unknown[]) => readCard(...a) }));

import { deliverChatCard, deliverChatCardFailed } from "../chat-card-deliver";
import { chatCardEventId, handOffChatCardDelivery, requestFounderAdvice, tellFounderCardNotShown } from "@/services/approvals/chat-card-delivery";

const CARD = "8af34774-0000-4000-8000-000000000001";
const RUN = "ad315e2d-0000-4000-8000-000000000002";
const waiting = { id: CARD, table: "decisions", waiting: true, title: "Cut “Atlanta Search” from $20 to $10 a day", where: "under What needs you on the Your CGO page" };

beforeEach(() => {
  ask.mockReset().mockResolvedValue(true);
  readCard.mockReset();
  logs.logEvent.mockClear();
});

describe("deliverChatCard", () => {
  it("must-catch: re-derives the tenant from the card and the chat from the run, then shows the card", async () => {
    const attach = vi.fn(async () => ({ shown: true as const, already: false, card_id: CARD, table: "decisions" as const, what: "x" }));
    const r = await deliverChatCard(CARD, RUN, "decisions", { tenantOf: async () => "t1", chatRun: async () => "root-run", attach });
    expect(r).toMatchObject({ shown: true });
    expect(attach).toHaveBeenCalledWith({ tenant_id: "t1", run_id: "root-run", card_id: CARD, table: "decisions" });
  });

  it("must-not-touch: a missing card or a run outside that tenant's chats shows nothing", async () => {
    const attach = vi.fn();
    expect(await deliverChatCard(CARD, RUN, "decisions", { tenantOf: async () => null, chatRun: async () => "r", attach })).toEqual({ skipped: "not_found" });
    expect(await deliverChatCard(CARD, RUN, "decisions", { tenantOf: async () => "t1", chatRun: async () => null, attach })).toEqual({ skipped: "not_chat" });
    expect(await deliverChatCard("nope", RUN, "decisions", { tenantOf: async () => "t1", chatRun: async () => "r", attach })).toEqual({ skipped: "bad_event" });
    expect(attach).not.toHaveBeenCalled();
  });

  it("a read failure throws so Inngest retries", async () => {
    await expect(deliverChatCard(CARD, RUN, "decisions", { tenantOf: async () => { throw new Error("db down"); } })).rejects.toThrow("db down");
  });
});

describe("deliverChatCardFailed (out of retries)", () => {
  const base = { tenantOf: async () => "t1", read: async () => waiting as never, state: async () => ({ in_chat: false }) as never };
  it("must-catch: a decisions card still waiting and in no chat is told through the note path, once per card", async () => {
    const tell = vi.fn(async () => true);
    expect(await deliverChatCardFailed(CARD, "decisions", { ...base, tell })).toBe(true);
    expect(tell).toHaveBeenCalledWith({ tenant_id: "t1", card_id: CARD, what: waiting.title, where: waiting.where });
  });
  it("must-not-touch: decided meanwhile, or shown by a parallel retry: nobody is told twice", async () => {
    const tell = vi.fn(async () => true);
    expect(await deliverChatCardFailed(CARD, "decisions", { ...base, read: async () => ({ ...waiting, waiting: false }) as never, tell })).toBe(false);
    expect(await deliverChatCardFailed(CARD, "decisions", { ...base, state: async () => ({ in_chat: true }) as never, tell })).toBe(false);
    expect(tell).not.toHaveBeenCalled();
  });
  it("a channel card stays tile-only (Ravi 2026-10-16): logged at error, no question or email", async () => {
    const tell = vi.fn(async () => true);
    expect(await deliverChatCardFailed(CARD, "channel_actions", { ...base, tell })).toBe(false);
    expect(tell).not.toHaveBeenCalled();
    expect(logs.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "chat_card.not_shown_tile_only" }));
  });
});

describe("hand-off and warnings sends", () => {
  it("one delivery per card per chat run: the event id carries the store, the card and the run", () => {
    expect(chatCardEventId("decisions", CARD, RUN)).toBe(`chat-card:decisions:${CARD}:${RUN}`);
    expect(chatCardEventId("decisions", CARD, "other-run")).not.toBe(chatCardEventId("decisions", CARD, RUN));
  });

  it("must-catch: the runner's failed write is logged at error and queued; a send that fails twice tells the founder now", async () => {
    const send = vi.fn(async () => undefined);
    expect(await handOffChatCardDelivery({ tenant_id: "t1", run_id: RUN, card_id: CARD, decision_class: "google_ads.update_campaign_budget_review", error: "x" }, send)).toBe("queued");
    expect(send).toHaveBeenCalledWith({ id: `chat-card:decisions:${CARD}:${RUN}`, name: "chat_card/deliver.requested", data: { card_id: CARD, run_id: RUN, table: "decisions" } });
    expect(logs.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "chat_card.emit_failed" }));

    readCard.mockResolvedValue(waiting);
    const down = vi.fn(async () => { throw new Error("inngest down"); });
    expect(await handOffChatCardDelivery({ tenant_id: "t1", run_id: RUN, card_id: CARD, decision_class: "google_ads.update_campaign_budget_review", error: "x" }, down)).toBe("told");
    expect(down).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "t1", topic: `card:${CARD}` }));
  });

  it("the warnings ask is retried once and a double failure is logged at error", async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce(undefined);
    expect(await requestFounderAdvice(CARD, "t1", RUN, flaky)).toBe(true);
    const down = vi.fn(async () => { throw new Error("down"); });
    expect(await requestFounderAdvice(CARD, "t1", RUN, down)).toBe(false);
    expect(logs.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "founder_order.advice_send_failed" }));
  });

  it("the fallback note names the change and where it is", async () => {
    await tellFounderCardNotShown({ tenant_id: "t1", card_id: CARD, what: waiting.title, where: waiting.where });
    expect(ask).toHaveBeenCalledWith({ tenant_id: "t1", topic: `card:${CARD}`, ask: `"${waiting.title}" is waiting for your tap ${waiting.where}. I could not show it in the chat.` });
  });
});
