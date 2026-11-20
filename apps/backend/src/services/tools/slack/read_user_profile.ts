
import { z } from "zod";
import { slackFetch } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  user_id: z
    .string()
    .min(1)
    .describe("Slack user_id, e.g. U01ABCDEF (from search_users)."),
});

type SlackUserProfile = {
  display_name?: string;
  real_name?: string;
  email?: string;
  title?: string;
  status_text?: string;
  status_emoji?: string;
};

type SlackUser = {
  id?: string;
  profile?: SlackUserProfile;
  is_bot?: boolean;
  deleted?: boolean;
  tz?: string;
};

type UsersInfoResp = {
  user?: SlackUser;
};

export const readUserProfileTool: ToolSpec = {
  name: "slack_read_user_profile",
  effect: "read",
  description:
    "Fetch a Slack user's full profile by user_id — display_name, real_name, email, title, status, timezone, is_bot, deleted. Use after slack_search_users has resolved a display name to user_id, OR when a tool result (channel history, thread, reactions) hands you a user_id you want to attribute.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const { user_id } = inputSchema.parse(input);
    const json = await slackFetch<UsersInfoResp>(
      ctx.tenant_id,
      "users.info",
      { user: user_id },
      ctx.slack_team_id,
    );
    const u = json.user ?? {};
    const p = u.profile ?? {};
    return {
      user_id: u.id ?? user_id,
      display_name: p.display_name ?? "",
      real_name: p.real_name ?? "",
      email: p.email ?? null,
      title: p.title ?? "",
      status_text: p.status_text ?? "",
      status_emoji: p.status_emoji ?? "",
      tz: u.tz ?? "",
      is_bot: !!u.is_bot,
      deleted: !!u.deleted,
    };
  },
};
