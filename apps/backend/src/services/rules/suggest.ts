
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { proposeRule, type ProposedRule } from "./propose";

export const RULE_SUGGESTION_META = "rule_suggestion";

export type RuleSuggestionMeta = {
  rule_id: string;
  text: string;
  scope_kind: ProposedRule["scope_kind"];
  scope_slug: string | null;
  agent_slug: string | null;
};

export async function postRuleCardInThread(args: {
  tenantId: string;
  threadId: string;
  agentSlug: string | null;
  rule: ProposedRule;
}): Promise<void> {
  const db = tenantClient(asTenantId(args.tenantId));
  const meta: RuleSuggestionMeta = {
    rule_id: args.rule.rule_id,
    text: args.rule.text,
    scope_kind: args.rule.scope_kind,
    scope_slug: args.rule.scope_slug,
    agent_slug: args.agentSlug,
  };
  const { error } = await db.from("agent_thread_messages").insert({
    thread_id: args.threadId,
    tenant_id: args.tenantId,
    sender_role: "assistant",
    body: `Keep this as a rule? "${args.rule.text}" You can save it in Settings → Rules.`,
    meta: { [RULE_SUGGESTION_META]: meta },
    agent_run_id: null,
  });
  if (error) throw new Error(error.message);
}

export async function suggestRuleFromChatTurn(tenantId: string, runId: string): Promise<ProposedRule | null> {
  try {
    const db = tenantClient(asTenantId(tenantId));
    const { data: run } = await db
      .from("agent_runs")
      .select("id, agent_slug, trigger, payload")
      .eq("id", runId)
      .maybeSingle();
    const r = run as {
      agent_slug: string;
      trigger: string;
      payload: { thread_id?: string; user_message_id?: string; message_origin?: string } | null;
    } | null;
    if (!r || r.trigger !== "chat" || !r.payload?.thread_id || !r.payload.user_message_id) return null;
    if (r.payload.message_origin === "app_action") return null;
    const { data: msg } = await db
      .from("agent_thread_messages")
      .select("id, body, sender_role")
      .eq("id", r.payload.user_message_id)
      .maybeSingle();
    const m = msg as { id: string; body: string | null; sender_role: string } | null;
    if (!m || m.sender_role !== "user" || !m.body) return null;
    const rule = await proposeRule({
      tenantId,
      sourceKind: "chat_message",
      sourceId: m.id,
      sourceText: m.body,
      agentSlug: r.agent_slug,
      runId,
    });
    if (rule) {
      await postRuleCardInThread({ tenantId, threadId: r.payload.thread_id, agentSlug: r.agent_slug, rule });
    }
    return rule;
  } catch (e) {
    console.warn(`[rules] chat suggestion for run ${runId} failed: ${(e as Error).message}`);
    return null;
  }
}

const FOREIGN_START =
  /^\s*((-{2,}|={2,}|_{2,}|\*{2,}).*|.*\b(forwarded|original)\s+(message|note|email)\b.*|on\s.+\swrote:\s*|>.*|(from|sent|to|cc|subject|date):\s.*)$/im;

export function ownWordsOnly(text: string): string {
  const m = FOREIGN_START.exec(text);
  return (m ? text.slice(0, m.index) : text).trim();
}

export async function suggestRuleFromEmailReply(args: {
  tenantId: string;
  runId: string;
  payload: unknown;
  ownText: string;
}): Promise<ProposedRule | null> {
  try {
    const id = (args.payload as { email?: { email_message_id?: unknown } } | null)?.email?.email_message_id;
    if (typeof id !== "string" || !id) return null;
    const { data } = await tenantClient(asTenantId(args.tenantId))
      .from("email_messages")
      .select("id, body_text")
      .eq("id", id)
      .maybeSingle();
    const m = data as { id: string; body_text: string | null } | null;
    if (!m?.body_text) return null;
    const own = ownWordsOnly(args.ownText);
    const start = own ? m.body_text.indexOf(own) : -1;
    if (start < 0) return null;
    return await proposeRule({
      tenantId: args.tenantId,
      sourceKind: "email_message",
      sourceId: m.id,
      sourceText: m.body_text,
      detectText: own,
      ownRange: [start, start + own.length],
      agentSlug: "cgo",
      runId: args.runId,
    });
  } catch (e) {
    console.warn(`[rules] email-reply suggestion for run ${args.runId} failed: ${(e as Error).message}`);
    return null;
  }
}

export async function suggestRuleFromReject(args: {
  tenantId: string;
  actionId: string;
  eventKey: string;
}): Promise<ProposedRule | null> {
  try {
    const { data } = await tenantClient(asTenantId(args.tenantId))
      .from("channel_action_events")
      .select("id, note, event")
      .eq("action_id", args.actionId)
      .eq("event_key", args.eventKey)
      .maybeSingle();
    const ev = data as { id: number; note: string | null; event: string } | null;
    if (!ev || ev.event !== "rejected" || !ev.note) return null;
    return await proposeRule({
      tenantId: args.tenantId,
      sourceKind: "channel_reject",
      sourceId: String(ev.id),
      sourceText: ev.note,
    });
  } catch (e) {
    console.warn(`[rules] reject suggestion for action ${args.actionId} failed: ${(e as Error).message}`);
    return null;
  }
}
