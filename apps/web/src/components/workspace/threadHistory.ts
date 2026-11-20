
export const OPEN_THREAD_HISTORY_EVENT = "zavi:open-thread-history";

export type ThreadMeta = {
  id: string;
  title: string | null;
  last_message_at: string | null;
  created_at: string | null;
  last_message: string | null;
  run_status: string | null;
  presentation_status?: "answered" | "failed" | "running" | "cancelled" | null;
  pending: boolean | null;
  unread?: boolean;
  unread_reply?: { head: string; kind: "question" | "reply"; at: string } | null;
};

export function threadRunning(t: ThreadMeta): boolean {
  if (t.presentation_status) return t.presentation_status === "running";
  return t.run_status === "running" || t.run_status === "queued";
}

export function threadsNeedPoll(threads: ThreadMeta[]): boolean {
  return threads.some(threadRunning);
}

function toEpoch(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

export function sortByRecency(threads: ThreadMeta[]): ThreadMeta[] {
  return [...threads].sort((a, b) => {
    const la = toEpoch(a.last_message_at);
    const lb = toEpoch(b.last_message_at);
    if (la !== lb) {
      if (la === null) return 1;
      if (lb === null) return -1;
      return lb - la;
    }
    const ca = toEpoch(a.created_at);
    const cb = toEpoch(b.created_at);
    if (ca !== cb) {
      if (ca === null) return 1;
      if (cb === null) return -1;
      return cb - ca;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function cleanPreview(raw: string | null): string {
  if (!raw) return "";
  return (
    raw
      .replace(/```[a-zA-Z0-9]*\n?/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/`/g, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}(?:>|[-*+]|\d+\.)\s+/gm, "")
      .replace(/(\*\*|__|\*|_|~~)/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function liveUnreadThreadIds(
  tabs: ReadonlyArray<{ id: string; kind: string; payload: unknown }>,
  unreadTabIds: Record<string, true>,
  slug: string,
): Set<string> {
  const ids = new Set<string>();
  for (const tab of tabs) {
    if (tab.kind !== "agent" || unreadTabIds[tab.id] !== true) continue;
    const p = tab.payload as { slug?: unknown; threadId?: unknown };
    if (p?.slug !== slug || typeof p?.threadId !== "string") continue;
    ids.add(p.threadId);
  }
  return ids;
}
