
import { slackFetch } from "@/services/tools/slack/_client";
import type { DiscoveredIdentity } from "./types";

const MAX_ACTIVE_MEMBERS = 200;

type SlackUser = {
  id?: string;
  name?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
    image_72?: string;
    image_48?: string;
  };
  is_bot?: boolean;
  deleted?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
};

type UsersListResp = {
  members?: SlackUser[];
  response_metadata?: {
    next_cursor?: string;
  };
};

export async function discoverSlackMembers(
  tenant_id: string,
  team_id?: string,
): Promise<DiscoveredIdentity[]> {
  const out: DiscoveredIdentity[] = [];
  let cursor: string | undefined;
  do {
    const resp = await slackFetch<UsersListResp>(
      tenant_id,
      "users.list",
      {
        limit: 200,
        ...(cursor ? { cursor } : {}),
      },
      team_id,
    );
    const batch = resp.members ?? [];
    for (const u of batch) {
      if (u.deleted) continue;
      if (u.is_restricted || u.is_ultra_restricted) continue;
      if (!u.id) continue;
      const display_name =
        u.profile?.real_name?.trim() ||
        u.profile?.display_name?.trim() ||
        u.name ||
        u.id;
      const isSlackbot = u.id === "USLACKBOT";
      out.push({
        provider: "slack",
        external_id: u.id,
        external_display_name: display_name,
        external_email: u.profile?.email?.trim().toLowerCase() || null,
        is_bot: u.is_bot === true || isSlackbot,
        team_id: team_id ?? null,
        avatar_url: u.profile?.image_72 || u.profile?.image_48 || null,
      });
      if (out.length >= MAX_ACTIVE_MEMBERS) break;
    }
    if (out.length >= MAX_ACTIVE_MEMBERS) break;
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}
