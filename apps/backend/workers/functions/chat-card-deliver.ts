
import { inngest } from "../client";
import { readCardTenantById } from "./founder-order-advice";
import { attachCardToChat, readCard, type AttachResult, type CardTable } from "@/services/approvals/chat-card-attach";
import { chatRunForCard, tellFounderCardNotShown } from "@/services/approvals/chat-card-delivery";
import { readCardState } from "@/services/approvals/card-location";
import { logEvent } from "@/services/logging/logEvent";

const UUID = /^[0-9a-f-]{36}$/i;

export type DeliverDeps = {
  tenantOf: typeof readCardTenantById;
  chatRun: typeof chatRunForCard;
  attach: typeof attachCardToChat;
};

export type DeliverResult = { skipped: "bad_event" | "not_found" | "not_chat" } | AttachResult;

const tableOf = (v: unknown): CardTable => (v === "channel_actions" ? "channel_actions" : "decisions");

export async function deliverChatCard(card_id: string, run_id: string, table: CardTable, deps: Partial<DeliverDeps> = {}): Promise<DeliverResult> {
  const d: DeliverDeps = { tenantOf: readCardTenantById, chatRun: chatRunForCard, attach: attachCardToChat, ...deps };
  if (!UUID.test(card_id) || !UUID.test(run_id)) return { skipped: "bad_event" };
  const tenant_id = await d.tenantOf(table, card_id);
  if (!tenant_id) return { skipped: "not_found" };
  const chatRun = await d.chatRun(tenant_id, run_id);
  if (!chatRun) return { skipped: "not_chat" };
  const r = await d.attach({ tenant_id, run_id: chatRun, card_id, table });
  void logEvent({
    level: "info",
    source: "workers/chat-card-deliver",
    code: r.shown ? "chat_card.delivered" : "chat_card.delivery_skipped",
    tenant_id,
    meta: { table, outcome: r.shown ? (r.already ? "already" : "shown") : r.reason },
  });
  return r;
}

export type FailedDeps = {
  tenantOf: typeof readCardTenantById;
  read: typeof readCard;
  state: typeof readCardState;
  tell: typeof tellFounderCardNotShown;
};

export async function deliverChatCardFailed(card_id: string, table: CardTable, deps: Partial<FailedDeps> = {}): Promise<boolean> {
  const d: FailedDeps = { tenantOf: readCardTenantById, read: readCard, state: readCardState, tell: tellFounderCardNotShown, ...deps };
  try {
    if (!UUID.test(card_id)) return false;
    const tenant_id = await d.tenantOf(table, card_id);
    if (!tenant_id) return false;
    const card = await d.read(tenant_id, card_id, table);
    if (!card || !card.waiting) return false;
    const state = await d.state(tenant_id, card_id, table);
    if (state?.in_chat) return false;
    if (table === "channel_actions") {
      void logEvent({ level: "error", source: "workers/chat-card-deliver", code: "chat_card.not_shown_tile_only", tenant_id, meta: { table } });
      return false;
    }
    return d.tell({ tenant_id, card_id, what: card.title, where: card.where });
  } catch (e) {
    void logEvent({ level: "error", source: "workers/chat-card-deliver", code: "chat_card.fallback_not_told", message: `card ${card_id}: ${(e as Error).message}`.slice(0, 300) });
    return false;
  }
}

export const chatCardDeliverFn = inngest.createFunction(
  {
    id: "chat-card-deliver",
    retries: 4,
    concurrency: [{ key: "event.data.card_id", limit: 1 }],
    onFailure: async ({ event }) => {
      const data = (event.data as { event?: { data?: { card_id?: unknown; table?: unknown } } }).event?.data;
      if (typeof data?.card_id === "string") await deliverChatCardFailed(data.card_id, tableOf(data.table));
    },
  },
  { event: "chat_card/deliver.requested" },
  async ({ event, step }) => {
    const card_id = typeof event.data?.card_id === "string" ? event.data.card_id : "";
    const run_id = typeof event.data?.run_id === "string" ? event.data.run_id : "";
    const table = tableOf(event.data?.table);
    const r = await step.run("deliver", () => deliverChatCard(card_id, run_id, table));
    const unreachable = ("skipped" in r && r.skipped === "not_chat") || ("reason" in r && r.reason === "not_chat");
    if (unreachable) await step.run("tell-founder", () => deliverChatCardFailed(card_id, table));
    return r;
  },
);
