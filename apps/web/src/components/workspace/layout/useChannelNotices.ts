"use client";

import { useCallback, useEffect, useState } from "react";

const EMPTY_COUNTS: Record<string, number> = {};
const HISTORY_MAX_ENTRIES = 500;

type SeenMap = Record<string, number>;

function useSeenStore(key: string) {
  const [seen, setSeen] = useState<SeenMap>({});

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      setSeen(stored ? JSON.parse(stored) as SeenMap : {});
    } catch {
      setSeen({});
    }
  }, [key]);

  const update = useCallback((change: (previous: SeenMap) => SeenMap) => {
    setSeen((previous) => {
      const next = change(previous);
      if (next !== previous) {
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {}
      }
      return next;
    });
  }, [key]);

  return [seen, update] as const;
}

export function useChannelNotices(
  userId?: string,
  tenantName?: string,
  counts: Record<string, number> = EMPTY_COUNTS,
) {
  const [seen, update] = useSeenStore(
    `zavi:channel-notices:${userId ?? "anonymous"}:${tenantName ?? "workspace"}`,
  );

  useEffect(() => {
    update((previous) => {
      let next = previous;
      for (const [slug, count] of Object.entries(counts)) {
        if (count < (previous[slug] ?? 0)) next = { ...next, [slug]: count };
      }
      return next;
    });
  }, [counts, update]);

  const markSeen = useCallback((slug: string, count: number) => {
    update((previous) => previous[slug] === count ? previous : { ...previous, [slug]: count });
  }, [update]);

  const unseen = useCallback((slug: string, count: number) =>
    Math.max(0, count - (seen[slug] ?? 0)), [seen]);

  return { unseen, markSeen };
}

export function useHistorySeen(userId?: string, tenantName?: string) {
  const [seen, update] = useSeenStore(
    `zavi:history-seen:${userId ?? "anonymous"}:${tenantName ?? "workspace"}`,
  );

  const markSeen = useCallback((id: string, at: number) => {
    update((previous) => {
      if ((previous[id] ?? 0) >= at) return previous;
      return Object.fromEntries(
        Object.entries({ ...previous, [id]: at })
          .sort((a, b) => b[1] - a[1])
          .slice(0, HISTORY_MAX_ENTRIES),
      );
    });
  }, [update]);

  return { seen, markSeen };
}
