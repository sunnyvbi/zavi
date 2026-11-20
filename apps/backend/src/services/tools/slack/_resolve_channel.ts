
import { slackFetch } from "./_client";
import { ExpectedToolError } from "@/services/tools/types";

const SLACK_ID_RE = /^[CGD][A-Z0-9]{8,}$/;

export function looksLikeChannelId(s: string): boolean {
  return SLACK_ID_RE.test(s.trim());
}

type ConvListResp = {
  channels?: Array<{ id?: string; name?: string }>;
  response_metadata?: { next_cursor?: string };
};

const MAX_PAGES = 3;
const PAGE_SIZE = 1000;

export async function resolveChannelId(
  tenant_id: string,
  target: string,
  team_id?: string,
): Promise<string> {
  const raw = target.trim();
  if (looksLikeChannelId(raw)) return raw;

  const want = raw.replace(/^#/, "").trim().toLowerCase();
  if (!want) {
    throw new ExpectedToolError(
      "slack_channel_invalid",
      "Empty channel name — pass a channel name like #general or a channel id (C...).",
    );
  }

  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await slackFetch<ConvListResp>(
      tenant_id,
      "conversations.list",
      {
        types: "public_channel,private_channel",
        limit: PAGE_SIZE,
        exclude_archived: true,
        ...(cursor ? { cursor } : {}),
      },
      team_id,
    );
    for (const c of json.channels ?? []) {
      if (c.id && (c.name ?? "").toLowerCase() === want) return c.id;
    }
    cursor = json.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  throw new ExpectedToolError(
    "slack_channel_not_found",
    `No channel named "${want}" that the bot can see. Invite the bot to that channel, or pass the channel id (C...) directly. (Scanned up to ${MAX_PAGES * PAGE_SIZE} channels.)`,
    { channel_name: want },
  );
}
