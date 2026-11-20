
import { z } from "zod";
import { slackFetch } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Display name, real name, or email substring to match (case-insensitive).",
    ),
  max_results: z.number().int().min(1).max(50).default(10),
});

type SlackUserProfile = {
  display_name?: string;
  real_name?: string;
  email?: string;
  title?: string;
};

type SlackUser = {
  id?: string;
  profile?: SlackUserProfile;
  is_bot?: boolean;
  deleted?: boolean;
  name?: string;
};

type UsersListResp = {
  members?: SlackUser[];
};

export const searchUsersTool: ToolSpec = {
  name: "slack_search_users",
  effect: "read",
  description:
    "Resolve a person's display name, real name, or email substring to one or more Slack `user_id` values. ALWAYS call this BEFORE writing any Slack API call that filters by user — Slack silently ignores display-name strings. Returns active non-bot matches first, ranked by Slack's user-list order. Example: user asks 'find Jemis in Slack' → call slack_search_users(query='Jemis') → take user_id (e.g. U01ABCDEF) → use with slack_read_user_profile, slack_list_channel_members, etc. The display-name-as-filter mistake is the #1 silent failure on Slack — same shape as Jira's accountId requirement post-GDPR.",
  input_schema: inputSchema,
  async execute(ctx, input: unknown) {
    const { query, max_results } = inputSchema.parse(input);
    const json = await slackFetch<UsersListResp>(
      ctx.tenant_id,
      "users.list",
      { limit: 200 },
      ctx.slack_team_id,
    );
    const all = json.members ?? [];
    const q = query.toLowerCase();
    const matches: Array<{
      user_id: string;
      display_name: string;
      real_name: string;
      email: string | null;
      is_bot: boolean;
      deleted: boolean;
      title: string;
    }> = [];
    for (const u of all) {
      const display_name = u.profile?.display_name ?? "";
      const real_name = u.profile?.real_name ?? u.name ?? "";
      const email = u.profile?.email ?? "";
      const hit =
        display_name.toLowerCase().includes(q) ||
        real_name.toLowerCase().includes(q) ||
        email.toLowerCase().includes(q);
      if (!hit) continue;
      matches.push({
        user_id: u.id ?? "",
        display_name,
        real_name,
        email: email || null,
        is_bot: !!u.is_bot,
        deleted: !!u.deleted,
        title: u.profile?.title ?? "",
      });
      if (matches.length >= max_results) break;
    }
    return {
      users: matches,
      total_scanned: all.length,
    };
  },
};
