import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/approvals/chat-card-attach", () => ({ attachCardToChat: vi.fn() }));
vi.mock("@/services/approvals/chat-card-delivery", () => ({ handOffChatCardDelivery: vi.fn() }));

const runs = vi.hoisted(() => ({ rows: {} as Record<string, unknown>, cards: [] as Array<{ id: string; run_id: string; exec_class: string }>, cardError: null as { message: string } | null, tenants: [] as string[], error: null as { message: string } | null }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (t: string) => {
    runs.tenants.push(t);
    return {
      from: (table: string) => ({
        select: () => ({
          in: (_c: string, ids: string[]) => ({
            eq: (_c2: string, cls: string) => ({
              limit: async () => ({ data: table === "channel_actions" ? runs.cards.filter((c) => ids.includes(c.run_id) && c.exec_class === cls) : [], error: runs.cardError }),
            }),
          }),
          eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: runs.rows[id] ?? null, error: runs.error }) }),
        }),
      }),
    };
  },
}));

import { chatRunBehindHandoff, chatVideoCardFiled, showVideoCardInChat } from "../chat-card";

const shown = { shown: true, already: false, card_id: "c", table: "channel_actions", what: "t" } as const;
const refused = (reason: "not_chat" | "not_found" | "not_waiting" | "growth_page_only") => ({ shown: false, reason, card_id: "c" }) as const;

describe("showVideoCardInChat", () => {
  it("attaches the channel card to the run's own chat and brings it to the latest turn", async () => {
    const attach = vi.fn().mockResolvedValue(shown);
    await expect(showVideoCardInChat("t", "r", "c", { attach, handOff: vi.fn(), chatRun: async () => "r" })).resolves.toBe("shown");
    expect(attach).toHaveBeenCalledWith({ tenant_id: "t", run_id: "r", card_id: "c", table: "channel_actions", bringToLatest: true });
  });

  it("only a run that is no chat at all answers not_chat, the one answer that may auto-start", async () => {
    const answer = (reason: Parameters<typeof refused>[0]) =>
      showVideoCardInChat("t", "r", "c", { attach: vi.fn().mockResolvedValue(refused(reason)), handOff: vi.fn(), chatRun: async () => "r" });
    await expect(answer("not_chat")).resolves.toBe("not_chat");
    await expect(answer("not_waiting")).resolves.toBe("not_shown");
    await expect(answer("not_found")).resolves.toBe("not_shown");
    await expect(answer("growth_page_only")).resolves.toBe("not_shown");
  });

  it("a failed write is handed off for retry and never reads as not_chat", async () => {
    const handOff = vi.fn().mockRejectedValue(new Error("queue down"));
    const out = await showVideoCardInChat("t", "r", "c", { attach: vi.fn().mockRejectedValue(new Error("db down")), handOff, chatRun: async () => "r" });
    expect(out).toBe("not_shown");
    expect(handOff).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "t", run_id: "r", card_id: "c", error: "db down", table: "channel_actions" }));
  });

  it("a run handed off from a web chat shows the card in the chat it came from", async () => {
    const attach = vi.fn().mockResolvedValue(shown);
    await expect(showVideoCardInChat("t", "child", "c", { attach, handOff: vi.fn(), chatRun: async () => "chat-run" })).resolves.toBe("shown");
    expect(attach.mock.calls[0][0]).toMatchObject({ run_id: "chat-run", card_id: "c" });
  });

  it("a run with no chat behind it is not_chat and attaches nothing", async () => {
    const attach = vi.fn();
    await expect(showVideoCardInChat("t", "r", "c", { attach, handOff: vi.fn(), chatRun: async () => null })).resolves.toBe("not_chat");
    expect(attach).not.toHaveBeenCalled();
  });

  it("a run that cannot be read is not_shown, never not_chat, so it cannot auto-start", async () => {
    const out = await showVideoCardInChat("t", "r", "c", { attach: vi.fn(), handOff: vi.fn().mockResolvedValue(undefined), chatRun: vi.fn().mockRejectedValue(new Error("db down")) });
    expect(out).toBe("not_shown");
  });
});

describe("chatRunBehindHandoff", () => {
  it("walks handoffs to the chat, through the run's own tenant", async () => {
    runs.error = null;
    runs.tenants.length = 0;
    runs.rows = { c2: { trigger: "handoff", parent_run_id: "c1" }, c1: { trigger: "handoff", parent_run_id: "chat" }, chat: { trigger: "chat", parent_run_id: null } };
    await expect(chatRunBehindHandoff("t", "c2")).resolves.toBe("chat");
    expect(runs.tenants).toEqual(["t"]);
  });

  it("stops at a Slack parent, a missing row and a handoff with no parent", async () => {
    runs.rows = { a: { trigger: "handoff", parent_run_id: "s" }, s: { trigger: "slack", parent_run_id: null }, b: { trigger: "handoff", parent_run_id: "gone" }, d: { trigger: "handoff", parent_run_id: null } };
    await expect(chatRunBehindHandoff("t", "a")).resolves.toBeNull();
    await expect(chatRunBehindHandoff("t", "b")).resolves.toBeNull();
    await expect(chatRunBehindHandoff("t", "d")).resolves.toBeNull();
  });

  it("reaches the chat of a real operator handoff, which has no parent_run_id and only the server-set message ref", async () => {
    runs.rows = {
      child: { trigger: "handoff", parent_run_id: null, payload: { operator_thread_id: "thread", founder_message_ref: { kind: "chat", id: "msg", author_user_id: "u", run_id: "chat" } } },
      chat: { trigger: "chat", parent_run_id: null, payload: { thread_id: "thread", user_message_id: "msg" } },
    };
    await expect(chatRunBehindHandoff("t", "child")).resolves.toBe("chat");
    const attach = vi.fn().mockResolvedValue(shown);
    await expect(showVideoCardInChat("t", "child", "c", { attach, handOff: vi.fn() })).resolves.toBe("shown");
    expect(attach.mock.calls[0][0]).toMatchObject({ run_id: "chat" });
  });

  it("a handoff from Slack or email stays outside chat", async () => {
    runs.rows = {
      sl: { trigger: "handoff", parent_run_id: null, payload: { founder_message_ref: { kind: "slack", id: "ev", author_user_id: "U1", run_id: "s" } } },
      em: { trigger: "handoff", parent_run_id: null, payload: { founder_message_ref: { kind: "email", id: "m", author_user_id: null, run_id: "e" } } },
    };
    await expect(chatRunBehindHandoff("t", "sl")).resolves.toBeNull();
    await expect(chatRunBehindHandoff("t", "em")).resolves.toBeNull();
  });

  it("a web thread handoff with no way back to its chat can never read as no chat, so it cannot auto-start", async () => {
    const handOff = vi.fn().mockResolvedValue(undefined);
    runs.rows = { lost: { trigger: "handoff", parent_run_id: null, payload: { operator_thread_id: "thread" } }, blind: { trigger: "handoff", parent_run_id: null, payload: { founder_message_ref_unreadable: true } } };
    await expect(showVideoCardInChat("t", "lost", "c", { attach: vi.fn(), handOff })).resolves.toBe("not_shown");
    await expect(showVideoCardInChat("t", "blind", "c", { attach: vi.fn(), handOff })).resolves.toBe("not_shown");
  });

  it("reaches the chat through nine handoffs, past the delegation limit", async () => {
    runs.rows = { chat: { trigger: "chat", parent_run_id: null } };
    for (let i = 0; i < 9; i++) runs.rows[`h${i}`] = { trigger: "handoff", parent_run_id: i === 0 ? "chat" : `h${i - 1}` };
    await expect(chatRunBehindHandoff("t", "h8")).resolves.toBe("chat");
  });

  it("a parent cycle throws rather than reading as no chat, so it cannot auto-start", async () => {
    runs.rows = { x: { trigger: "handoff", parent_run_id: "y" }, y: { trigger: "handoff", parent_run_id: "x" } };
    await expect(chatRunBehindHandoff("t", "x")).rejects.toThrow("too deep");
    await expect(showVideoCardInChat("t", "x", "c", { attach: vi.fn(), handOff: vi.fn().mockResolvedValue(undefined) })).resolves.toBe("not_shown");
  });

  it("a read error throws so the caller cannot mistake it for no chat", async () => {
    runs.rows = {};
    runs.error = { message: "down" };
    await expect(chatRunBehindHandoff("t", "x")).rejects.toThrow("run read failed");
    runs.error = null;
  });
});

describe("chatVideoCardFiled", () => {
  const cls = "generated_video.render.v1";
  const chatChild = { trigger: "handoff", parent_run_id: null, payload: { founder_message_ref: { kind: "chat", id: "m", author_user_id: "u", run_id: "chat" } } };

  it("a chat ask that already has its card is filed, whatever run filed it first", async () => {
    runs.rows = { child: chatChild, chat: { trigger: "chat", parent_run_id: null } };
    runs.cards = [{ id: "a", run_id: "child", exec_class: cls }];
    await expect(chatVideoCardFiled("t", "child", cls)).resolves.toBe(true);
    runs.cards = [];
    await expect(chatVideoCardFiled("t", "child", cls)).resolves.toBe(false);
  });

  it("a handoff sees the card its chat run already filed, so the handoff writes no second one", async () => {
    runs.rows = { child: chatChild, chat: { trigger: "chat", parent_run_id: null } };
    runs.cards = [{ id: "a", run_id: "chat", exec_class: cls }];
    await expect(chatVideoCardFiled("t", "child", cls)).resolves.toBe(true);
  });

  it("another video class on the run does not use up the chat's card", async () => {
    runs.rows = { chat: { trigger: "chat", parent_run_id: null } };
    runs.cards = [{ id: "a", run_id: "chat", exec_class: "other" }];
    await expect(chatVideoCardFiled("t", "chat", cls)).resolves.toBe(false);
  });

  it("the channel's own run keeps its five cards", async () => {
    runs.rows = { cron: { trigger: "schedule", parent_run_id: null } };
    runs.cards = [{ id: "a", run_id: "cron", exec_class: cls }];
    await expect(chatVideoCardFiled("t", "cron", cls)).resolves.toBe(false);
  });

  it("a failed read files the card rather than losing it", async () => {
    runs.rows = { chat: { trigger: "chat", parent_run_id: null } };
    runs.cards = [{ id: "a", run_id: "chat", exec_class: cls }];
    runs.cardError = { message: "down" };
    await expect(chatVideoCardFiled("t", "chat", cls)).resolves.toBe(false);
    runs.cardError = null;
  });
});
