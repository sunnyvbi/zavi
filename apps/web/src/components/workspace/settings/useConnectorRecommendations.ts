import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export type Recommendation = {
  slug: string;
  name?: string;
  rationale?: string;
  connected: boolean;
  agents_unlocked?: string[];
  new_agents_unlocked?: string[];
  recommended: boolean;
};

export function rankRecommendationRows(recs: Recommendation[]): Recommendation[] {
  const score = (r: Recommendation) =>
    (r.recommended ? 2 : 0) +
    ((r.new_agents_unlocked ?? r.agents_unlocked ?? []).length > 0 ? 1 : 0);
  return recs
    .filter((r) => !r.connected)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => score(b.r) - score(a.r) || a.i - b.i)
    .map(({ r }) => r);
}

export function rankRecommendations(recs: Recommendation[]): string[] {
  return rankRecommendationRows(recs).map((r) => r.slug);
}

export function useConnectorRecommendations(reloadKey: number = 0): string[] {
  const [slugs, setSlugs] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/connectors/recommendations");
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { recommendations?: Recommendation[] };
        if (!cancelled && Array.isArray(json.recommendations)) {
          setSlugs(rankRecommendations(json.recommendations));
        }
      } catch {
        if (!cancelled) setSlugs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);
  return slugs;
}

export function useConnectorRecommendationRows(
  reloadKey: number = 0,
): Recommendation[] | null {
  const [rows, setRows] = useState<Recommendation[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/connectors/recommendations");
        if (cancelled) return;
        if (!res.ok) {
          setRows([]);
          return;
        }
        const json = (await res.json()) as { recommendations?: Recommendation[] };
        if (cancelled) return;
        setRows(
          Array.isArray(json.recommendations)
            ? rankRecommendationRows(json.recommendations)
            : [],
        );
      } catch {
        if (!cancelled) setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);
  return rows;
}
