
import { logEvent } from "@/services/logging/logEvent";
import { resolveFounderChatOrder } from "@/services/growth/founder-order";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { SupabaseClient } from "@supabase/supabase-js";

export const chatCardEventId = (table: "decisions" | "channel_actions", card_id: string, run_id: string) => `chat-card:${table}:${card_id}:${run_id}`;
export const founderAdviceEventId = (decision_id: string) => `founder-advice:${decision_id}`;

type Send = (e: { id: string; name: string; data: Record<string, unknown> }) => Promise<unknown>;

async function defaultSend(): Promise<Send> {
  const { inngest } = await import("@/../workers/client");
  return (e) => inngest.send(e as Parameters<typeof inngest.send>[0]);
}

async function sendTwice(e: { id: string; name: string; data: Record<string, unknown> }, send?: Send): Promise<{ ok: true } | { ok: false; error: string }> {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await (send ?? (await defaultSend()))(e);
      return { ok: true };
    } catch (err) {
      last = (err as Error).message;
    }
  }
  return { ok: false, error: last };
}

export async function requestFounderAdvice(decision_id: string, tenant_id: string, run_id?: string, send?: Send): Promise<boolean> {
  const r = await sendTwice({ id: founderAdviceEventId(decision_id), name: "founder_order/advise.requested", data: { decision_id } }, send);
  if (!r.ok) {
    void logEvent({
      level: "error",
      source: "chat-card-delivery",
      code: "founder_order.advice_send_failed",
      tenant_id,
      ...(run_id ? { run_id } : {}),
      message: `advice event not sent for decision ${decision_id}: ${r.error}`.slice(0, 300),
    });
  }
  return r.ok;
}

export type HandOffOutcome = "queued" | "told" | "not_told";

export async function handOffChatCardDelivery(
  args: { tenant_id: string; run_id: string; card_id: string; decision_class: string; error: string; table?: "decisions" | "channel_actions" },
  send?: Send,
): Promise<HandOffOutcome> {
  void logEvent({
    level: "error",
    source: "chat-card-delivery",
    code: "chat_card.emit_failed",
    tenant_id: args.tenant_id,
    run_id: args.run_id,
    message: `chat card for decision ${args.card_id} not written: ${args.error}`.slice(0, 300),
    meta: { decision_class: args.decision_class, table: args.table ?? "decisions" },
  });
  const table = args.table ?? "decisions";
  const r = await sendTwice({ id: chatCardEventId(table, args.card_id, args.run_id), name: "chat_card/deliver.requested", data: { card_id: args.card_id, run_id: args.run_id, table } }, send);
  if (!r.ok) {
    const told = table === "decisions" && (await tellFounderAboutCard(args.tenant_id, args.card_id));
    void logEvent({
      level: "error",
      source: "chat-card-delivery",
      code: "chat_card.handoff_failed",
      tenant_id: args.tenant_id,
      run_id: args.run_id,
      message: `chat card delivery for decision ${args.card_id} not queued: ${r.error}`.slice(0, 300),
      meta: { decision_class: args.decision_class },
    });
    return told ? "told" : "not_told";
  }
  return "queued";
}

export async function chatRunForCard(tenant_id: string, run_id: string): Promise<string | null> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db.from("agent_runs").select("id, trigger, payload, enqueued_by, agent_slug").eq("tenant_id", tenant_id).eq("id", run_id).maybeSingle();
  if (error) throw new Error(`run read failed: ${error.message}`);
  const r = data as { id: string; trigger: string | null; payload: unknown; enqueued_by: string | null; agent_slug: string | null } | null;
  if (!r) return null;
  if (r.trigger === "chat") return r.id;
  if (r.trigger !== "handoff") return null;
  const order = await resolveFounderChatOrder(db as unknown as Pick<SupabaseClient, "from">, {
    id: r.id,
    tenant_id,
    trigger: r.trigger,
    payload: r.payload,
    enqueued_by: r.enqueued_by,
    agent_slug: r.agent_slug,
  });
  if (order.founder) return order.card_run_id;
  const { chatCardTarget } = await import("./chat-card-attach");
  return (await chatCardTarget(tenant_id, r.id))?.run_id ?? null;
}

export async function tellFounderAboutCard(tenant_id: string, card_id: string, table: "decisions" | "channel_actions" = "decisions"): Promise<boolean> {
  try {
    const { readCard } = await import("./chat-card-attach");
    const card = await readCard(tenant_id, card_id, table);
    return !!card?.waiting && (await tellFounderCardNotShown({ tenant_id, card_id, what: card.title, where: card.where }));
  } catch (e) {
    void logEvent({ level: "error", source: "chat-card-delivery", code: "chat_card.fallback_not_told", tenant_id, message: `card ${card_id}: ${(e as Error).message}`.slice(0, 300) });
    return false;
  }
}

export function cardNotShownAsk(what: string, where: string): string {
  return `"${what.slice(0, 160)}" is waiting for your tap ${where}. I could not show it in the chat.`;
}

export async function tellFounderCardNotShown(args: { tenant_id: string; card_id: string; what: string; where: string }): Promise<boolean> {
  try {
    const { askFounderOutsideReview } = await import("@/services/growth/open-advice");
    const told = await askFounderOutsideReview({ tenant_id: args.tenant_id, topic: `card:${args.card_id}`, ask: cardNotShownAsk(args.what, args.where) });
    void logEvent({
      level: told ? "warn" : "error",
      source: "chat-card-delivery",
      code: told ? "chat_card.fallback_told" : "chat_card.fallback_not_told",
      tenant_id: args.tenant_id,
      message: `chat card for ${args.card_id} not shown; founder ${told ? "told by note" : "NOT told"}`,
    });
    return told;
  } catch (e) {
    void logEvent({ level: "error", source: "chat-card-delivery", code: "chat_card.fallback_not_told", tenant_id: args.tenant_id, message: `fallback failed: ${(e as Error).message}`.slice(0, 300) });
    return false;
  }
}
