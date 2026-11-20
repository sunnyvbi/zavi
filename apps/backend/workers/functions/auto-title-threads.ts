
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { synthMarkdown } from "@/services/llm/synthMarkdown";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

const RECENCY_HOURS = 48;
const BATCH_LIMIT = 25;
const TITLE_MAX_CHARS = 48;
const PROMPT_BODY_CHARS = 600;

const SYSTEM_PROMPT = `
You write a short title for a chat thread between a company operator and an AI agent.

INPUT: the operator's first message, then the agent's first reply.

OUTPUT: ONLY the title — no preamble, no quotes, no trailing punctuation.

RULES:
- Describe the topic/task of the conversation.
- 6 words or fewer. 48 characters or fewer.
- Title Case-ish, plain language, no emoji.
- Summarize the subject; do not echo the input verbatim. Use only names and facts the messages state: never guess a business type, place or product that is not written there.

EXAMPLES:
Trip 10927 Overcharge Investigation
Weekly Meta Ads Performance Review
Onboarding New Host From Phoenix
`.trim();

type ThreadRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
};

type MsgRow = { sender_role: string; body: string };

export function buildTitlePrompt(messages: MsgRow[]): string | null {
  const firstUser = messages.find((m) => m.sender_role === "user");
  const firstAssistant = messages.find((m) => m.sender_role === "assistant");
  if (!firstUser?.body || !firstAssistant?.body) return null;
  const trunc = (s: string) => s.slice(0, PROMPT_BODY_CHARS);
  return [
    `Operator's first message:\n${trunc(firstUser.body)}`,
    `Agent's first reply:\n${trunc(firstAssistant.body)}`,
  ].join("\n\n");
}

export function sanitizeTitle(raw: string): string {
  let t = raw.trim().replace(/\s+/g, " ");
  t = t.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  t = t.replace(/[.\s]+$/g, "").trim();
  if (t.length > TITLE_MAX_CHARS) {
    t = t.slice(0, TITLE_MAX_CHARS).trimEnd();
  }
  return t;
}

export const autoTitleThreadsFn = inngest.createFunction(
  { id: "auto-title-threads", concurrency: 1 },
  { cron: "*/30 * * * *" },
  async ({ logger }) => {
    const sb = serviceClient();
    const cutoff = new Date(Date.now() - RECENCY_HOURS * 3600 * 1000).toISOString();

    const { data: threads, error: selErr } = await sb
      .from("agent_threads")
      .select("id, tenant_id, agent_slug")
      .eq("title_source", "message")
      .eq("synthetic", false)
      .is("deleted_at", null)
      .gte("last_message_at", cutoff)
      .order("last_message_at", { ascending: false })
      .limit(BATCH_LIMIT);
    if (selErr) {
      throw new Error(`auto-title-threads: candidate select failed: ${selErr.message}`);
    }

    const rows = (threads ?? []) as ThreadRow[];
    let titled = 0;
    let skippedNoPair = 0;
    let skippedLlm = 0;

    for (const t of rows) {
      try {
        const { data: msgs, error: msgErr } = await sb
          .from("agent_thread_messages")
          .select("sender_role, body")
          .eq("thread_id", t.id)
          .eq("tenant_id", t.tenant_id)
          .order("created_at", { ascending: true })
          .limit(10);
        if (msgErr) {
          logger.warn(`auto-title-threads: message read failed for ${t.id}: ${msgErr.message}`);
          skippedLlm += 1;
          continue;
        }

        const prompt = buildTitlePrompt((msgs ?? []) as MsgRow[]);
        if (!prompt) {
          skippedNoPair += 1;
          continue;
        }

        const synth = await synthMarkdown({
          model: HAIKU_MODEL,
          system_prompt: SYSTEM_PROMPT,
          user_prompt: prompt,
          max_tokens: 32,
        });
        const title = sanitizeTitle(synth.markdown);
        if (!title) {
          skippedLlm += 1;
          continue;
        }

        const { error: updErr } = await sb
          .from("agent_threads")
          .update({ title, title_source: "auto" })
          .eq("id", t.id)
          .eq("title_source", "message");
        if (updErr) {
          logger.warn(`auto-title-threads: update failed for ${t.id}: ${updErr.message}`);
          skippedLlm += 1;
          continue;
        }
        titled += 1;
      } catch (err: unknown) {
        logger.warn(
          `auto-title-threads: skipped ${t.id}: ${(err as Error)?.message ?? "unknown"}`,
        );
        skippedLlm += 1;
      }
    }

    logger.info(
      `auto-title-threads: candidates=${rows.length} titled=${titled} ` +
        `skipped(no-pair)=${skippedNoPair} skipped(llm)=${skippedLlm}`,
    );
    return { candidates: rows.length, titled, skippedNoPair, skippedLlm };
  },
);
