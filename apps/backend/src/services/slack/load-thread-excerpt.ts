
import { slackFetch } from "@/services/tools/slack/_client";
import { serviceClient } from "@/services/supabase";
import { flattenSlackBlocks, hasStructuralBlocks } from "@/services/slack/flatten-blocks";
import { mrkdwnActionLinksToMarkdown } from "@/services/tools/slack/mrkdwn";

const TEXT_CAP = 500;
const PAGE_LIMIT = 200;
const MAX_PAGES = 8;
const EXCERPT_BYTE_CAP = 4 * 1024;
const KEEP_TAIL = 40;
const TARGETED_NEIGHBORS = 5;

type SlackFile = {
  id?: string;
  name?: string;
  filetype?: string;
};

type SlackReply = {
  ts?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  files?: SlackFile[];
  blocks?: unknown;
  attachments?: unknown;
};

function hasFiles(m: SlackReply): boolean {
  return Array.isArray(m.files) && m.files.length > 0;
}

function displayText(m: SlackReply): string {
  const text = m.text ?? "";
  if (text.trim() && !hasStructuralBlocks(m.blocks)) {
    return mrkdwnActionLinksToMarkdown(text);
  }
  const flat = flattenSlackBlocks(m.blocks, m.attachments);
  return mrkdwnActionLinksToMarkdown(flat || text);
}

function hasContent(m: SlackReply): boolean {
  return displayText(m).trim().length > 0 || hasFiles(m);
}

function attachmentSuffix(m: SlackReply): string {
  if (!hasFiles(m)) return "";
  const refs = (m.files ?? [])
    .filter((f) => typeof f?.id === "string" && f.id)
    .map((f) => `${f.name ?? "file"} (${f.id})`);
  if (refs.length === 0) return "";
  return ` [attachment: ${refs.join(", ")} — read with slack_read_file]`;
}

type RepliesResp = {
  messages?: SlackReply[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

export type ThreadExcerpt = {
  text: string;
  messageCount: number;
  truncated: boolean;
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

async function resolveBotUserId(
  tenant_id: string,
  team_id: string,
): Promise<string | null> {
  try {
    const { data } = await serviceClient()
      .from("slack_workspaces")
      .select("bot_user_id")
      .eq("tenant_id", tenant_id)
      .eq("team_id", team_id)
      .maybeSingle<{ bot_user_id: string | null }>();
    return data?.bot_user_id ?? null;
  } catch {
    return null;
  }
}

export async function loadThreadExcerpt(args: {
  tenant_id: string;
  team_id: string;
  channel: string;
  thread_ts: string;
  event_ts?: string;
}): Promise<ThreadExcerpt | null> {
  const { tenant_id, team_id, channel, thread_ts, event_ts } = args;
  if (!tenant_id || !team_id || !channel || !thread_ts) return null;

  const messages: SlackReply[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const resp = await slackFetch<RepliesResp>(
        tenant_id,
        "conversations.replies",
        { channel, ts: thread_ts, limit: PAGE_LIMIT, cursor },
        team_id,
        { noLegacyFallback: true },
      );
      for (const m of resp.messages ?? []) messages.push(m);
      cursor = resp.response_metadata?.next_cursor;
      if (!resp.has_more || !cursor) break;
    }
  } catch {
    return null;
  }

  const all = messages.filter(hasContent);
  if (all.length <= 1) return null;

  const botUserId = await resolveBotUserId(tenant_id, team_id);
  const participantLabels = new Map<string, string>();
  let nextParticipant = 0;
  const label = (m: SlackReply): string => {
    const isBot = (botUserId && m.user === botUserId) || !!m.bot_id;
    if (isBot) return "Zavi";
    const uid = typeof m.user === "string" && m.user ? m.user : "";
    if (!uid) return "User";
    let l = participantLabels.get(uid);
    if (!l) {
      nextParticipant += 1;
      l = `User ${nextParticipant}`;
      participantLabels.set(uid, l);
    }
    return l;
  };

  const root = all[0];
  let rest = all.slice(1);

  let truncated = false;
  if (rest.length > KEEP_TAIL) {
    rest = rest.slice(rest.length - KEEP_TAIL);
    truncated = true;
  }

  const lineFor = (m: SlackReply): string =>
    `${label(m)}: ${truncate(displayText(m), TEXT_CAP)}${attachmentSuffix(m)}`;
  const render = (mid: SlackReply[]): string =>
    [lineFor(root), ...mid.map(lineFor)].join("\n");

  let included = rest.slice();
  while (
    included.length > 1 &&
    Buffer.byteLength(render(included), "utf-8") > EXCERPT_BYTE_CAP
  ) {
    included.shift();
    truncated = true;
  }

  if (event_ts) {
    const appendCurrentToTail = (current: SlackReply) => {
      included.push(current);
      truncated = true;
      while (
        included.length > 1 &&
        Buffer.byteLength(render(included), "utf-8") > EXCERPT_BYTE_CAP
      ) {
        included.shift();
      }
    };

    const hasCurrent = included.some((m) => m.ts === event_ts);
    if (!hasCurrent) {
      let current = all.find((m) => m.ts === event_ts);

      if (!current) {
        try {
          const targeted = await slackFetch<RepliesResp>(
            tenant_id,
            "conversations.replies",
            { channel, ts: thread_ts, oldest: event_ts, inclusive: true, limit: TARGETED_NEIGHBORS },
            team_id,
            { noLegacyFallback: true },
          );
          const found = (targeted.messages ?? []).filter(hasContent);
          current = found.find((m) => m.ts === event_ts);
          for (const m of found) {
            if (
              m.ts &&
              m.ts !== root.ts &&
              m.ts !== event_ts &&
              !included.some((x) => x.ts === m.ts)
            ) {
              included.push(m);
            }
          }
        } catch {
        }
      }

      if (current && current.ts !== root.ts) {
        appendCurrentToTail(current);
      } else {
        truncated = true;
      }
    }
  }

  const text = render(included);
  return {
    text,
    messageCount: 1 + included.length,
    truncated,
  };
}

export function renderThreadExcerptBlock(excerpt: ThreadExcerpt): string {
  return [
    "## Slack thread so far (most recent last)",
    excerpt.truncated ? "(older replies trimmed)" : "",
    excerpt.text,
  ]
    .filter(Boolean)
    .join("\n");
}
