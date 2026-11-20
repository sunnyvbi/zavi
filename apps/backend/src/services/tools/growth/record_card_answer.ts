import { z } from "zod";
import { ExpectedToolError, type ToolContext, type ToolSpec } from "@/services/tools/types";
import { isFounderChatOrder } from "@/services/agents/untrusted-context";
import { asksFounderForAnswer } from "@/services/channels/card-presentation";

const input = z.object({
  card_id: z.string().uuid().describe("The ONE question card the founder is answering, from praxis__list_open_cards. If unclear which, ask first."),
}).strict();

export type AnswerCard = {
  id: string;
  title: string | null;
  status: string;
  card_kind: string | null;
  exec_class: string | null;
  exec_status: string | null;
  approved_by: string | null;
  body: unknown;
};
export type RecordCardAnswerDeps = {
  role: (tenant: string, user: string) => Promise<string | null>;
  founderWords: (tenant: string, run: string, user: string) => Promise<string | null>;
  card: (tenant: string, id: string) => Promise<AnswerCard | null>;
  write: (tenant: string, response: { card_id: string; user_id: string; note: string; event_key: string }) => Promise<{ ok: boolean; replayed?: boolean; status?: string; code?: string }>;
};

function isQuestion(card: AnswerCard): boolean {
  if (card.exec_class != null || card.exec_status != null || card.approved_by != null) return false;
  if (card.card_kind != null && card.card_kind !== "task") return false;
  const body = card.body as { intent?: unknown; step?: { title?: string; body?: string; intent?: unknown; how_to?: string[]; deliverable?: { content?: unknown } } } | null;
  const step = body?.step;
  if (step?.deliverable != null) return false;
  const intent = body?.intent ?? step?.intent;
  if (intent === "answer") return true;
  if (intent !== "review" && intent !== "fix_setup") return false;
  return asksFounderForAnswer({ intent: "review", hasContent: false, title: card.title ?? step?.title, body: step?.body, howTo: step?.how_to });
}

export async function runRecordCardAnswer(ctx: ToolContext, raw: unknown, deps: RecordCardAnswerDeps) {
  const user = ctx.actor?.actor_user_id;
  if (ctx.agent_slug !== "cgo" || !ctx.run_id || ctx.run_trigger !== "chat" || !user || ctx.actor?.actor_source !== "chat" ||
      ctx.writes_suppressed || !isFounderChatOrder(ctx) || ctx.founder_order_unverified === true) {
    throw new ExpectedToolError("card_answer_unavailable", "A question can be answered only from a verified owner or admin's typed Growth chat message.");
  }
  const { card_id } = input.parse(raw);
  const role = await deps.role(ctx.tenant_id, user);
  if (role !== "owner" && role !== "admin") throw new ExpectedToolError("card_answer_unavailable", "Only the workspace owner or an admin can record this answer.");
  const card = await deps.card(ctx.tenant_id, card_id);
  if (!card) throw new ExpectedToolError("card_answer_not_found", "That question card could not be found in this workspace. Read the open cards again; do not guess an id.");
  if (!isQuestion(card)) throw new ExpectedToolError("card_answer_not_question", "This tool only records answers to question cards. It cannot complete a task, approve an account change or start work.");
  if (!["pending", "snoozed", "acted"].includes(card.status)) throw new ExpectedToolError("card_answer_not_saved", "That question is no longer open. Read its current state before responding.");
  const words = await deps.founderWords(ctx.tenant_id, ctx.run_id, user);
  if (!words?.trim()) throw new ExpectedToolError("card_answer_unavailable", "The founder's own reply could not be verified. Nothing was recorded.");
  if (words.length > 1000) throw new ExpectedToolError("card_answer_too_long", "The card accepts an answer up to 1,000 characters. Ask for a shorter answer; nothing was recorded.");
  const result = await deps.write(ctx.tenant_id, { card_id, user_id: user, note: words, event_key: `chat-answer:${ctx.run_id}:${card_id}` });
  if (!result.ok || result.status !== "acted") throw new ExpectedToolError("card_answer_not_saved", "The answer was not saved because the card changed or the write failed. Read its current state; do not claim it is answered.");
  return {
    status: result.replayed ? "already_recorded" : "recorded", card_id,
    say: "Your answer is recorded and the question card is closed. No channel work was started. If you want work based on this answer, ask for that separately.",
  };
}

const realDeps: RecordCardAnswerDeps = {
  role: async (tenant, user) => {
    const { loadTenantRoleFor } = await import("@/services/auth/tenant-role");
    return loadTenantRoleFor(user, tenant);
  },
  founderWords: async (t, r, u) => (await import("@/services/growth/chat-ask")).readChatAskWords(t, r, u),
  card: async (tenant, id) => {
    const { tenantClient, asTenantId } = await import("@/services/tenant-client");
    const { data, error } = await tenantClient(asTenantId(tenant)).from("channel_actions")
      .select("id,title,status,body,card_kind,exec_class,exec_status,approved_by").eq("id", id).maybeSingle();
    if (error) throw new Error(`Question read failed: ${error.message}`);
    return data as AnswerCard | null;
  },
  write: async (tenant, response) => {
    const { tenantRpc, asTenantId } = await import("@/services/tenant-client");
    const { data, error } = await tenantRpc(asTenantId(tenant), "set_channel_action", {
      p_action_id: response.card_id, p_status: "acted", p_note: response.note,
      p_snoozed_until: null, p_event_key: response.event_key, p_actor_user_id: response.user_id,
    });
    if (error) throw new Error(`Question response failed: ${error.message}`);
    return data as { ok: boolean; replayed?: boolean; status?: string; code?: string };
  },
};

export const recordCardAnswerTool: ToolSpec = {
  name: "growth_record_card_answer", effect: "write", input_schema: input,
  description: "Record the founder's current reply to ONE identified channel question card and close it. Reads their actual words; works with Autopilot off. Starts no work, approves nothing. Use only to acknowledge a fact they supplied, not a request to act on it. Read open cards first; if the question is ambiguous, ask which one.",
  execute: (ctx, raw) => runRecordCardAnswer(ctx, raw, realDeps),
};
