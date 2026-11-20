import { attachCardToChat } from "@/services/approvals/chat-card-attach";
import { handOffChatCardDelivery } from "@/services/approvals/chat-card-delivery";
import { FOUNDER_REF_UNREADABLE, parseFounderMessageRef } from "@/services/approvals/founder-message";
import { asTenantId, tenantClient } from "@/services/tenant-client";

export type VideoCardInChat = "shown" | "not_chat" | "not_shown";

export const CARD_IN_CHAT_NEXT =
  "Tell the founder the video card is here in this chat with its price, and that the video starts when they press Make video on it, right here. It plays in the same card when it is ready, and credits are charged only when it arrives. Do not send them to the AI UGC Videos channel or any other page. Do not name this tool.";

const MAX_HANDOFF_HOPS = 16;

export async function chatRunBehindHandoff(tenantId: string, runId: string): Promise<string | null> {
  const db = tenantClient(asTenantId(tenantId));
  let id = runId;
  for (let hop = 0; hop <= MAX_HANDOFF_HOPS; hop++) {
    const { data, error } = await db.from("agent_runs").select("trigger, parent_run_id, payload").eq("id", id).maybeSingle();
    if (error) throw new Error(`run read failed: ${error.message}`);
    const row = data as { trigger?: unknown; parent_run_id?: unknown; payload?: Record<string, unknown> | null } | null;
    if (row?.trigger === "chat") return id;
    if (row?.trigger !== "handoff") return null;
    const payload = row.payload ?? {};
    if (payload[FOUNDER_REF_UNREADABLE] === true) throw new Error("handoff founder message unreadable");
    const ref = parseFounderMessageRef(payload.founder_message_ref);
    if (ref && ref.kind !== "chat") return null;
    const next = ref?.run_id ?? row.parent_run_id;
    if (typeof next === "string") {
      id = next;
      continue;
    }
    if (typeof payload.operator_thread_id === "string" && payload.operator_thread_id) throw new Error("handoff from a web thread has no chat run");
    return null;
  }
  throw new Error("handoff chain too deep to read");
}

export const ONE_CARD_NEXT =
  "This chat already has its one video card, so no second card was written. Write no more cards. Tell the founder the card is here in this chat and that they can ask for another video with a new message.";

export async function chatVideoCardFiled(tenantId: string, runId: string, execClass: string): Promise<boolean> {
  try {
    const chatRun = await chatRunBehindHandoff(tenantId, runId);
    if (!chatRun) return false;
    const { data, error } = await tenantClient(asTenantId(tenantId)).from("channel_actions").select("id").in("run_id", [runId, chatRun]).eq("exec_class", execClass).limit(1);
    if (error) return false;
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

export async function showVideoCardInChat(
  tenantId: string,
  runId: string,
  actionId: string,
  deps: { attach?: typeof attachCardToChat; handOff?: typeof handOffChatCardDelivery; chatRun?: typeof chatRunBehindHandoff } = {},
): Promise<VideoCardInChat> {
  const attach = deps.attach ?? attachCardToChat;
  const handOff = deps.handOff ?? handOffChatCardDelivery;
  const chatRun = deps.chatRun ?? chatRunBehindHandoff;
  try {
    const chatRunId = await chatRun(tenantId, runId);
    if (!chatRunId) return "not_chat";
    const out = await attach({ tenant_id: tenantId, run_id: chatRunId, card_id: actionId, table: "channel_actions", bringToLatest: true });
    if (out.shown) return "shown";
    return out.reason === "not_chat" ? "not_chat" : "not_shown";
  } catch (e) {
    await handOff({ tenant_id: tenantId, run_id: runId, card_id: actionId, decision_class: "channel.recipe_step", error: (e as Error).message, table: "channel_actions" }).catch(() => undefined);
    return "not_shown";
  }
}
