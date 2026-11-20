

import { normalizeForDiff } from "@/services/agents/url-watch";

export type RefetchedSource = { url: string; content: string; ok: boolean };
export type BaselineSource = { url: string; excerpt: string };

export type WatchDelta = {
  anyDelta: boolean;
  changedUrls: string[];
  uncertain: boolean;
};

export function detectResearchWatchDelta(
  baseline: BaselineSource[],
  refetched: RefetchedSource[],
): WatchDelta {
  const byUrl = new Map<string, RefetchedSource>();
  for (const r of refetched) byUrl.set(r.url, r);

  const changedUrls: string[] = [];
  let uncertain = false;

  for (const b of baseline) {
    const r = byUrl.get(b.url);
    if (!r || r.ok !== true) {
      uncertain = true;
      continue;
    }
    if (normalizeForDiff(r.content) !== normalizeForDiff(b.excerpt)) {
      changedUrls.push(b.url);
    }
  }

  return {
    anyDelta: changedUrls.length > 0,
    changedUrls,
    uncertain,
  };
}

export type ShortCircuitDeps = {
  tenant_id: string;
  topic_key: string | null;
  loadBaseline: (
    tenant_id: string,
    topic_key: string | null,
  ) => Promise<BaselineSource[]>;
  refetch: (url: string) => Promise<{ content: string; ok: boolean }>;
};

export type ShortCircuitResult = {
  shortCircuit: boolean;
  totalUrls: number;
  changedUrls: string[];
};

export async function shouldShortCircuitResearchWatch(
  deps: ShortCircuitDeps,
): Promise<ShortCircuitResult> {
  const baseline = await deps.loadBaseline(deps.tenant_id, deps.topic_key);
  const totalUrls = baseline.length;

  if (totalUrls === 0) {
    return { shortCircuit: false, totalUrls: 0, changedUrls: [] };
  }

  const refetched: RefetchedSource[] = await Promise.all(
    baseline.map(async (b) => {
      const r = await deps.refetch(b.url);
      return { url: b.url, content: r.content, ok: r.ok };
    }),
  );

  const delta = detectResearchWatchDelta(baseline, refetched);
  const shortCircuit =
    delta.anyDelta === false && delta.uncertain === false && totalUrls > 0;

  return { shortCircuit, totalUrls, changedUrls: delta.changedUrls };
}
