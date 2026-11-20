
import { inngest } from "../client";
import { postDiscordReply } from "@/services/tools/discord/_client";
import { discordRouting, type DiscordRouting } from "@/services/connectors/chat-routing";
import { makeChatTriageReply } from "./_chat-triage-reply";

export const replyOne = makeChatTriageReply<DiscordRouting>({
  trigger: "discord",
  claimsTable: "discord_reply_claims",
  goneSkip: "channel_gone",
  routing: discordRouting,
  binding: async (svc, r, tenantId) => {
    const { data } = await svc
      .from("discord_guilds")
      .select("tenant_id")
      .eq("guild_id", r.guild_id)
      .eq("tenant_id", tenantId)
      .eq("status", "enabled")
      .maybeSingle<{ tenant_id: string }>();
    return data;
  },
  post: (r, text) =>
    postDiscordReply({ channel_id: r.channel_id, reply_to_message_id: r.message_id, text }),
});

export const discordTriageReplyFn = inngest.createFunction(
  { id: "discord-triage-reply", retries: 1, concurrency: 4 },
  { event: "agent.run.completed" },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id;
    const res = await step.run("reply", () => replyOne(run_id));
    logger.info(`discord-triage-reply ${run_id}: ${JSON.stringify(res)}`);
    return res;
  },
);
