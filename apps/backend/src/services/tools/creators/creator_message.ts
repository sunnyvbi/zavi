import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ensureCreatorThread, postCreatorThreadMessage, MAX_CREATOR_MESSAGE_LEN } from "@/services/creators/thread";
import { assertWithinOutreachCap, loadHireableCreator, onCreatorChannel } from "./shared";

export const CREATOR_MESSAGE_CLASS = "creator.message";

const inputSchema = z.object({
  human_member_id: z.string().uuid().describe("The creator, from growth__search_human_members (bookable=true)."),
  body: z
    .string()
    .trim()
    .min(1)
    .max(MAX_CREATOR_MESSAGE_LEN)
    .describe("The message, as the business. Plain text. Contact details are removed before it is sent."),
});

export const creatorMessageTool: ToolSpec = {
  name: "creator_message",
  effect: "write",
  description:
    "Send a message to an approved Zavi creator in the business's thread with them, as the business. Use it to ask a question or agree details before proposing a hire. It hires and pays no one.",
  input_schema: inputSchema,
  async execute(ctx, rawInput) {
    const input = inputSchema.parse(rawInput);
    const out = await onCreatorChannel(ctx, CREATOR_MESSAGE_CLASS, "creator_message_wrong_run", async ({ tenant_id }) => {
      const creator = await loadHireableCreator(input.human_member_id);
      await assertWithinOutreachCap(tenant_id);
      const thread = await ensureCreatorThread({
        tenant_id,
        human_member_id: creator.id,
        started_by: "tenant",
        started_by_user_id: null,
      });
      const message = await postCreatorThreadMessage({
        access: { tenant_id, thread_id: thread.id, human_member_id: creator.id, sender_kind: "tenant" },
        sender_user_id: null,
        body: input.body,
      });
      return { message_id: message.id, creator_name: creator.display_name };
    });
    if (out.suppressed) return { sent: false, note: "Draft run: nothing was sent." };
    return {
      sent: true,
      message_id: out.result.message_id,
      note: `Message sent to ${out.result.creator_name}. Their reply arrives in the thread on the UGC page.`,
    };
  },
};
