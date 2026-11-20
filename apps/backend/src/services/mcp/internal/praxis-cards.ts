
import { z } from "zod";
import type { McpCallResult } from "../types";
import { attachCardToChat, listOpenCards, type AttachResult } from "@/services/approvals/chat-card-attach";
import { logEvent } from "@/services/logging/logEvent";

type Ctx = { tenant_id: string; run_id?: string; writes_suppressed?: boolean };

const ShowCardArgs = z.object({ card_id: z.string().uuid() });

function result(start: number, ok: boolean, payload: Record<string, unknown>): McpCallResult {
  return { ok, is_error: !ok, content: JSON.stringify(payload), ms: Date.now() - start };
}

export function showCardTellFounder(r: AttachResult): string {
  if (r.shown) {
    return "The card is shown in this chat. Tell the founder to tap Approve on it.";
  }
  switch (r.reason) {
    case "not_waiting":
      return r.approved_by_source === "cgo"
        ? "Autopilot already approved this change. There is nothing for the founder to tap."
        : "This change is no longer waiting for the founder. There is nothing to tap.";
    case "growth_page_only":
      return "This is an Autopilot goal move; the founder approves it under its goal on the Your CGO page.";
    case "not_chat":
      return "This turn is not a chat, so no card can be shown here. Say where the card is instead.";
    default:
      return "No waiting card has that id. Call praxis__list_open_cards for the ids.";
  }
}

export async function callCardTool(ctx: Ctx, tool_name: "list_open_cards" | "show_card", args: unknown, start: number): Promise<McpCallResult> {
  if (tool_name === "list_open_cards") {
    try {
      const cards = await listOpenCards(ctx.tenant_id);
      return result(start, true, {
        cards,
        note: cards.length === 0
          ? "Nothing is waiting for the founder."
          : "To put one of these in this chat for the founder to tap, call praxis__show_card with its card_id.",
      });
    } catch {
      return result(start, false, { error: "cards_unreadable", message: "Could not read the waiting cards just now. Do not say whether a change is done." });
    }
  }
  const parsed = ShowCardArgs.safeParse(args ?? {});
  if (!parsed.success) {
    return result(start, false, { error: "tool_input_invalid", message: "card_id must be the waiting card's id (a uuid)." });
  }
  if (!ctx.run_id || ctx.writes_suppressed) return result(start, false, { error: "not_chat", message: showCardTellFounder({ shown: false, reason: "not_chat", card_id: parsed.data.card_id }) });
  try {
    const r = await attachCardToChat({ tenant_id: ctx.tenant_id, run_id: ctx.run_id, card_id: parsed.data.card_id, bringToLatest: true });
    return result(start, true, { ...r, tell_founder: showCardTellFounder(r) });
  } catch (e) {
    void logEvent({
      level: "warn",
      source: "praxis-cards",
      code: "chat_card.show_failed",
      tenant_id: ctx.tenant_id,
      run_id: ctx.run_id,
      message: `show_card failed: ${(e as Error).message}`.slice(0, 300),
    });
    return result(start, false, { error: "show_card_failed", retryable: true, message: "The card could not be shown just now. Try once more; if it fails again, say where the card is." });
  }
}
