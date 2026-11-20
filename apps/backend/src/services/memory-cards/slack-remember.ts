
import { slackFetch } from "@/services/tools/slack/_client";
import { loadThreadExcerpt } from "@/services/slack/load-thread-excerpt";
import { enqueueSlackOutbox } from "@/services/slack/outbox";
import { distillCard } from "./distill";
import { createCard } from "./store";

export { detectRemember } from "./remember-detect";

export async function handleRemember(args: {
  tenant_id: string;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  event_ts: string;
  requested_by?: string | null;
}): Promise<void> {
  let reply: string;
  try {
    const excerpt = await loadThreadExcerpt({
      tenant_id: args.tenant_id,
      team_id: args.team_id,
      channel: args.channel_id,
      thread_ts: args.thread_ts,
      event_ts: args.event_ts,
    });
    if (!excerpt || excerpt.text.trim().length < 10) {
      reply = "I couldn't read that conversation to remember it — try again from inside the thread.";
    } else {
      const card = await distillCard({
        text: excerpt.text,
        context: "a Slack conversation a teammate asked Zavi to remember",
      });
      if (!card) {
        reply = "Nothing durable to save from that one — skipped.";
      } else {
        const permalink = await slackPermalink(args.tenant_id, args.team_id, args.channel_id, args.event_ts);
        const r = await createCard({
          tenant_id: args.tenant_id,
          source_kind: "slack",
          source_ref: `slack:${args.channel_id}:${args.thread_ts}`,
          source_url: permalink,
          title: card.title,
          body: card.body,
          source_excerpt: card.source_excerpt,
          confidence: card.confidence,
          requested_by_external: args.requested_by ?? null,
          slack_team_id: args.team_id,
          slack_channel_id: args.channel_id,
          slack_thread_ts: args.thread_ts,
        });
        reply = r.ok
          ? r.deduped
            ? "Already in your Memory Inbox 🧠"
            : `🧠 Saved to your Memory Inbox for review: *${truncate(card.title, 120)}*`
          : `Couldn't save that: ${r.reason}`;
      }
    }
  } catch (e) {
    reply = `Couldn't save that: ${(e as Error).message.slice(0, 160)}`;
  }

  await enqueueSlackOutbox({
    tenant_id: args.tenant_id,
    team_id: args.team_id,
    channel_id: args.channel_id,
    thread_ts: args.thread_ts,
    kind: "remember",
    body: reply,
    depends_on_answer: true,
    idempotency_key: `remember:${args.channel_id}:${args.event_ts}`,
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

async function slackPermalink(
  tenant_id: string,
  team_id: string,
  channel: string,
  message_ts: string,
): Promise<string | null> {
  if (!message_ts) return null;
  try {
    const r = (await slackFetch(
      tenant_id,
      "chat.getPermalink",
      { channel, message_ts },
      team_id,
    )) as { permalink?: string };
    return r.permalink ?? null;
  } catch {
    return null;
  }
}
