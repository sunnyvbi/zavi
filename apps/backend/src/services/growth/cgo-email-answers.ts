
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { AnswerOutcome } from "./cgo-answers";

export type OneTapEmailMsg = {
  id: string;
  tenant_id: string;
  thread_id: string;
  from_address: string | null;
  envelope_to: string | null;
  subject: string | null;
  rfc_message_id: string | null;
};

export type OneTapEmailDeps = {
  founderText?: (tenant_id: string, email_message_id: string) => Promise<string | null>;
  answer?: typeof import("./cgo-answers").answerQuestions;
  undo?: typeof import("./cgo-answers").undoAnsweredQuestion;
  send?: (msg: { tenant_id: string; to: string; subject: string; body_text: string; reply_to: string; in_reply_to?: string; references?: string[] }) => Promise<unknown>;
};

export async function handleOneTapEmailReply(
  msg: OneTapEmailMsg,
  thread: { root_message_id: string | null },
  deps: OneTapEmailDeps = {},
): Promise<"handled" | "free"> {
  const { parseAnswerReply, mapAnswers, confirmationText } = await import("./cgo-answers");
  const founderText = deps.founderText ?? (await import("./cgo-reply")).verifiedFounderEmailText;
  const own = await founderText(msg.tenant_id, msg.id);
  if (!own) return "free";
  const parsed = parseAnswerReply(own);
  if (parsed.kind === "free") return "free";

  const db = tenantClient(asTenantId(msg.tenant_id));
  const { data: root } = await db
    .from("email_messages")
    .select("created_at, subject, body_text")
    .eq("tenant_id", msg.tenant_id)
    .eq("thread_id", msg.thread_id)
    .eq("direction", "out")
    .eq("rfc_message_id", thread.root_message_id ?? "")
    .maybeSingle<{ created_at: string; subject: string | null; body_text: string | null }>();
  if (!root) return "free";
  const confirm = async (body: string): Promise<void> => {
    const to = msg.from_address ?? "";
    if (body && to && msg.envelope_to) {
      const send = deps.send ?? (await import("@/email/sendAgentMailReply")).sendAgentMailReply;
      const subject = (root.subject ?? msg.subject ?? "Your growth note").replace(/^\s*(re:\s*)+/i, "").replace(/\s*\[ref [0-9a-f]{12}\]/i, "");
      try {
        await send({
          tenant_id: msg.tenant_id,
          to,
          subject: `Re: ${subject}`,
          body_text: body,
          reply_to: msg.envelope_to,
          ...(msg.rfc_message_id ? { in_reply_to: `<${msg.rfc_message_id}>` } : {}),
          references: [thread.root_message_id, msg.rfc_message_id].filter((x): x is string => !!x).map((x) => `<${x}>`),
        });
      } catch (e) {
        console.warn(`[cgo-email-answers] confirmation send failed: ${(e as Error).message}`);
      }
    }
  };

  const rootLines = (root.body_text ?? "").split(/\r?\n/).map((l) => l.trim());
  const lineShows = (head: string) => rootLines.some((l) => l === head || l.startsWith(`${head} `));
  const numbered = rootLines.some((l) => /^- \d{1,2}\. /.test(l));
  let single: ((q: { ask: string }) => boolean) | null = null;
  const shownIn = (q: { ordinal: number | null; ask: string }) => {
    if (q.ordinal != null && lineShows(`- ${q.ordinal}. ${q.ask}`)) return true;
    return !!single && single(q);
  };

  let outcomes: AnswerOutcome[] = [];
  const undone: string[] = [];
  if (parsed.kind === "answers") {
    const { data: open, error } = await db
      .from("cgo_questions")
      .select("id, ordinal, ask, topic_key")
      .eq("tenant_id", msg.tenant_id)
      .eq("status", "open")
      .lte("asked_at", root.created_at)
      .limit(20);
    if (error) return "free";
    const { isYesNoAsk, HYPOTHESIS_TOPIC } = await import("./cgo-questions");
    const toAll = parsed.answers.some((x) => x.ordinal === "all");
    const openQs = (open ?? []) as Array<{ id: string; ordinal: number | null; ask: string; topic_key: string | null }>;
    const unnumbered = numbered ? [] : openQs.filter((q) => lineShows(`- ${q.ask}`));
    if (unnumbered.length === 1) single = (q) => q.ask === unnumbered[0]!.ask;
    const shown = openQs.filter((q) => isYesNoAsk(q.ask) && shownIn(q));
    const fact = shown.find((q) => (q.topic_key ?? "").startsWith(HYPOTHESIS_TOPIC) && q.ordinal != null);
    if (toAll && fact) {
      await confirm(`Nothing changed yet. Question ${fact.ordinal} asks about your own records, so I need it by number: reply \`${fact.ordinal} yes\` or \`${fact.ordinal} no\`${shown.length > 1 ? ", and number the others too (for example `1 yes, 2 no`)" : ""}.`);
      return "handled";
    }
    const candidates = shown;
    const mapped = mapAnswers(parsed, candidates);
    if (!mapped) return "free";
    const answer = deps.answer ?? (await import("./cgo-answers")).answerQuestions;
    outcomes = await answer({ tenant_id: msg.tenant_id, answers: mapped, via: "email", actor_user_id: null });
  } else {
    const { data: done } = await db
      .from("cgo_questions")
      .select("id, ordinal, ask, answered_at")
      .eq("tenant_id", msg.tenant_id)
      .eq("status", "answered")
      .lte("asked_at", root.created_at)
      .not("applied_line", "is", null)
      .in("ordinal", parsed.ordinals)
      .order("answered_at", { ascending: false })
      .limit(10);
    const undo = deps.undo ?? (await import("./cgo-answers")).undoAnsweredQuestion;
    for (const n of parsed.ordinals) {
      const q = ((done ?? []) as Array<{ id: string; ordinal: number; ask: string }>).find((r) => r.ordinal === n && shownIn(r));
      const line = q ? await undo(msg.tenant_id, q.id) : null;
      undone.push(line ?? `I couldn't undo ${n}: there is no change from it left to reverse.`);
    }
  }

  await confirm(confirmationText(outcomes, undone));
  return "handled";
}
