
import { inngest } from "../client";
import { postTelegramReply } from "@/services/tools/telegram/_client";
import { telegramRouting, type TelegramRouting } from "@/services/connectors/chat-routing";
import { makeChatTriageReply } from "./_chat-triage-reply";

export const replyOne = makeChatTriageReply<TelegramRouting>({
  trigger: "telegram",
  claimsTable: "telegram_reply_claims",
  goneSkip: "chat_gone",
  routing: telegramRouting,
  binding: async (svc, r, tenantId) => {
    const { data } = await svc
      .from("telegram_chats")
      .select("tenant_id")
      .eq("chat_id", r.chat_id)
      .eq("tenant_id", tenantId)
      .eq("status", "enabled")
      .maybeSingle<{ tenant_id: string }>();
    return data;
  },
  post: (r, text) =>
    postTelegramReply({ chat_id: r.chat_id, reply_to_message_id: r.message_id, text }),
  onGone: async (svc, r, tenantId) => {
    await svc
      .from("telegram_chats")
      .update({ status: "deleted", updated_at: new Date().toISOString() })
      .eq("chat_id", r.chat_id)
      .eq("tenant_id", tenantId);
  },
});

export const telegramTriageReplyFn = inngest.createFunction(
  { id: "telegram-triage-reply", retries: 1, concurrency: 4 },
  { event: "agent.run.completed" },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id;
    const res = await step.run("reply", () => replyOne(run_id));
    logger.info(`telegram-triage-reply ${run_id}: ${JSON.stringify(res)}`);
    return res;
  },
);
