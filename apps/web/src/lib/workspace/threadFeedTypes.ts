
import { stripChannelMention } from "./channelMention";

export type ThreadFeedItem = {
  id: string;
  title: string | null;
  last_message_at: string | null;
  created_at: string | null;
  last_message: string | null;
  run_status: string | null;
  pending: boolean | null;
  reply_count: number;
  first_user_message: string | null;
  presentation_status: "answered" | "failed" | "running" | "cancelled" | null;
};

export type ThreadFeedPage = {
  threads: ThreadFeedItem[];
  next_before: string | null;
};

export function isThreadInFlight(t: ThreadFeedItem): boolean {
  return t.presentation_status === "running";
}

export function feedRowBody(t: ThreadFeedItem): string {
  const first = stripChannelMention(t.first_user_message?.trim() ?? null);
  if (first) return first;
  const title = stripChannelMention(t.title?.trim() ?? null);
  if (title) return title;
  return "(no message)";
}

export function feedRowTimestamp(t: ThreadFeedItem): string | null {
  return t.created_at ?? t.last_message_at;
}

export function threadLineLabel(
  t: ThreadFeedItem,
  agentName: string,
): string {
  if (isThreadInFlight(t)) {
    return `${agentName} is working on this thread. Open it.`;
  }
  const n = t.reply_count;
  const replies = n === 1 ? "1 reply" : `${n} replies`;
  return `Open thread with ${agentName}, ${replies}`;
}

export function groupByDay(
  threads: ThreadFeedItem[],
): Array<{ dayIso: string | null; threads: ThreadFeedItem[] }> {
  const groups: Array<{ dayIso: string | null; threads: ThreadFeedItem[] }> = [];
  let currentKey: string | null | undefined;

  for (const t of threads) {
    const iso = feedRowTimestamp(t);
    let key: string | null = null;
    if (iso) {
      const d = new Date(iso);
      key = Number.isNaN(d.getTime()) ? null : d.toDateString();
    }
    if (groups.length === 0 || key !== currentKey) {
      groups.push({ dayIso: key ? iso : null, threads: [t] });
      currentKey = key;
    } else {
      groups[groups.length - 1].threads.push(t);
    }
  }
  return groups;
}
