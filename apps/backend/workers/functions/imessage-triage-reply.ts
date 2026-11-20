
import { inngest } from "../client";
import { postIMessageReply } from "@/services/tools/imessage/_client";
import { imessageRouting, type IMessageRouting } from "@/services/connectors/chat-routing";
import { findEnabledIMessageBinding } from "@/services/connectors/imessage/binding";
import { imessageEnabled, imessageOwnsLine } from "@/services/connectors/imessage/sendblue";
import { makeChatTriageReply } from "./_chat-triage-reply";

export const replyOne = makeChatTriageReply<IMessageRouting>({
  trigger: "imessage",
  claimsTable: "imessage_reply_claims",
  goneSkip: "recipient_gone",
  routing: imessageRouting,
  canSend: (r) => !imessageEnabled() || imessageOwnsLine(r.line),
  binding: (_svc, r, tenantId) => findEnabledIMessageBinding({ line: r.line, handle: r.handle, tenant_id: tenantId }),
  post: (r, text) => postIMessageReply({ handle: r.handle, text }),
  onGone: async (svc, r, tenantId) => {
    await svc
      .from("imessage_threads")
      .update({ status: "deleted", updated_at: new Date().toISOString() })
      .eq("line", r.line)
      .eq("handle", r.handle)
      .eq("tenant_id", tenantId);
  },
});

export const imessageTriageReplyFn = inngest.createFunction(
  { id: "imessage-triage-reply", retries: 1, concurrency: 4 },
  { event: "agent.run.completed" },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id;
    const res = await step.run("reply", () => replyOne(run_id));
    logger.info(`imessage-triage-reply ${run_id}: ${JSON.stringify(res)}`);
    return res;
  },
);
