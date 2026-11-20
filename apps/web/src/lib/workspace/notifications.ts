import { getChannel } from "@zavi/shared";
import type { WorkspaceThreadMeta } from "@/components/workspace/useAgentThreads";
import { needsYouItems, type getNeedsYouSnapshot } from "./needsYou";

type Snapshot = ReturnType<typeof getNeedsYouSnapshot>;

export type NotificationTarget =
  | { kind: "channel"; slug: string }
  | { kind: "growth" }
  | { kind: "decision"; id: string }
  | { kind: "question"; threadId: string; agentSlug: string };

export type NotificationRow = {
  key: string;
  title: string;
  text: string;
  at: string | null;
  count: number;
  mark: string | null;
  target: NotificationTarget;
};

const NONE: ReadonlySet<string> = new Set();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function notificationRows(
  snap: Snapshot,
  threads: readonly WorkspaceThreadMeta[],
  channelCounts: Readonly<Record<string, number>> | null,
): NotificationRow[] {
  const items = needsYouItems(snap.decisions, threads, NONE);
  const homes = new Map(snap.decisions.map((d) => [d.id, d]));
  const newest = (match: (id: string) => boolean) => items.find((i): i is Extract<typeof i, { kind: "approval" }> => i.kind === "approval" && match(i.id)) ?? null;
  const rows: NotificationRow[] = [];

  for (const [slug, count] of Object.entries(channelCounts ?? {})) {
    if (count <= 0) continue;
    const top = newest((id) => {
      const d = homes.get(id);
      return d?.home === "channel" && (d.home_channel ?? d.channel_slug) === slug;
    });
    rows.push({
      key: `channel:${slug}`,
      title: `${getChannel(slug)?.name ?? slug}: ${plural(count, "action", "actions")} waiting`,
      text: top?.text ?? "Open the channel to review.",
      at: top?.at ?? null,
      count,
      mark: top?.id ?? null,
      target: { kind: "channel", slug },
    });
  }

  const growth = snap.totals?.growth ?? 0;
  if (growth > 0) {
    const top = newest((id) => homes.get(id)?.home === "growth");
    rows.push({
      key: "growth",
      title: `Your CGO: ${plural(growth, "decision", "decisions")} waiting`,
      text: top?.text ?? "Open your growth plan to review.",
      at: top?.at ?? null,
      count: growth,
      mark: top?.id ?? null,
      target: { kind: "growth" },
    });
  }

  for (const item of items) {
    if (item.kind === "question") {
      rows.push({ key: item.key, title: `${item.who} has a question`, text: item.text, at: item.at, count: 1, mark: item.key, target: { kind: "question", threadId: item.threadId, agentSlug: item.agentSlug } });
    } else if (homes.get(item.id)?.home === "needs_you") {
      rows.push({ key: item.key, title: `${item.who} needs you`, text: item.text, at: item.at, count: 1, mark: item.key, target: { kind: "decision", id: item.id } });
    }
  }

  return rows.sort((a, b) => (a.at === b.at ? 0 : a.at === null ? 1 : b.at === null ? -1 : a.at < b.at ? 1 : -1));
}

export function notificationAge(at: string | null, now: number): string {
  if (!at) return "";
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

export type NotificationsSeen = Readonly<Record<string, string>>;

const SEEN_PREFIX = "zavi:notifications-seen:";

export const seenStamp = (row: NotificationRow): string => `${row.count}|${row.mark}`;

export function unseenNotifications(rows: readonly NotificationRow[], seen: NotificationsSeen): NotificationRow[] {
  return rows.filter((row) => {
    const stamp = seen[row.key];
    if (row.mark === null || !stamp) return true;
    const cut = stamp.indexOf("|");
    return stamp.slice(cut + 1) !== row.mark || Number(stamp.slice(0, cut)) < row.count;
  });
}

export function readNotificationsSeen(tenantId: string): NotificationsSeen {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEEN_PREFIX + tenantId) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

export function writeNotificationsSeen(tenantId: string, seen: NotificationsSeen): void {
  try {
    window.localStorage.setItem(SEEN_PREFIX + tenantId, JSON.stringify(seen));
  } catch {
    return;
  }
}
