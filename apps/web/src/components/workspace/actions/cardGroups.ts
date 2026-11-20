
import type { ActionItem } from "./types";

const NEVER_GROUPED = new Set(["queue", "other"]);

export const TARGET_WORD: Record<string, string> = {
  page: "page",
  campaign: "campaign",
  ad_set: "ad set",
  ad: "ad",
  keyword: "keyword",
  audience: "audience",
  tracking: "tracking setup",
  account: "account",
  profile: "profile",
  post: "post",
  thread: "thread",
  person: "person",
};

export type LaneEntry<T> =
  | { kind: "card"; card: T }
  | { kind: "group"; key: string; targetKind: string; members: T[] };

type WithTarget = { body?: { step?: unknown } | null };

export function targetOf(a: WithTarget): { kind: string; ref: string } | null {
  const step = a.body?.step as { target?: unknown } | undefined;
  const t = step?.target as { kind?: unknown; ref?: unknown } | undefined;
  if (!t || typeof t.kind !== "string" || typeof t.ref !== "string") return null;
  const ref = t.ref.trim().replace(/\s+/g, " ").toLowerCase();
  if (!ref || NEVER_GROUPED.has(t.kind)) return null;
  return { kind: t.kind, ref };
}

export function groupKey(a: WithTarget): string | null {
  const t = targetOf(a);
  return t ? `${t.kind}:${t.ref}` : null;
}

export function groupByTarget<T extends Pick<ActionItem, "id"> & WithTarget>(
  ranked: readonly T[],
  groupable: (c: T) => boolean = () => true,
): LaneEntry<T>[] {
  const byKey = new Map<string, T[]>();
  for (const c of ranked) {
    const key = groupable(c) ? groupKey(c) : null;
    if (key === null) continue;
    const list = byKey.get(key);
    if (list) list.push(c);
    else byKey.set(key, [c]);
  }
  const out: LaneEntry<T>[] = [];
  const placed = new Set<string>();
  for (const c of ranked) {
    const key = groupable(c) ? groupKey(c) : null;
    const members = key === null ? undefined : byKey.get(key);
    if (key === null || !members || members.length < 2) {
      out.push({ kind: "card", card: c });
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    out.push({ kind: "group", key, targetKind: targetOf(c)!.kind, members });
  }
  return out;
}

export function cardCount<T>(entries: readonly LaneEntry<T>[]): number {
  return entries.reduce((n, e) => n + (e.kind === "group" ? e.members.length : 1), 0);
}
