"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "@/lib/api";

export type BuildSuggestion = {
  key: string;
  label: string;
  prompt: string;
};

type SuggestionState = {
  suggestions: BuildSuggestion[];
  loading: boolean;
  loadingMore?: boolean;
  exhausted?: boolean;
  moreFailed?: boolean;
};

export type BuildSuggestionsState = SuggestionState & {
  more: () => Promise<void>;
};

const EMPTY_STATE: SuggestionState = { suggestions: [], loading: false };
export const MAX_SUGGESTIONS = 30;

export function moreSuggestionsUrl(sessionId: string, shown: readonly BuildSuggestion[]): string {
  const q = new URLSearchParams({ session_id: sessionId, more: "1" });
  for (const s of shown.slice(-40)) q.append("exclude", s.label);
  return `/api/workspace/autopilot/chips?${q.toString()}`;
}

export function mergeSuggestions(shown: readonly BuildSuggestion[], next: readonly BuildSuggestion[]): BuildSuggestion[] {
  const keys = new Set(shown.map((s) => s.key));
  const labels = new Set(shown.map((s) => s.label.toLowerCase()));
  const out = [...shown];
  for (const s of next) {
    if (out.length >= MAX_SUGGESTIONS) break;
    if (keys.has(s.key) || labels.has(s.label.toLowerCase())) continue;
    keys.add(s.key);
    labels.add(s.label.toLowerCase());
    out.push(s);
  }
  return out;
}

function readSuggestions(value: unknown): BuildSuggestion[] {
  if (!value || typeof value !== "object") return [];
  const chips = (value as { chips?: unknown }).chips;
  if (!Array.isArray(chips)) return [];
  return chips
    .filter(
      (chip): chip is BuildSuggestion =>
        !!chip &&
        typeof chip === "object" &&
        typeof (chip as BuildSuggestion).key === "string" &&
        typeof (chip as BuildSuggestion).label === "string" &&
        typeof (chip as BuildSuggestion).prompt === "string",
    )
    .slice(0, 5);
}

export function useBuildSuggestions(
  enabled: boolean,
  sessionId: string | null,
  revisionKey: string | null,
): BuildSuggestionsState {
  const [state, setState] = useState<SuggestionState>(EMPTY_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const genRef = useRef(0);

  useEffect(() => {
    genRef.current++;
    if (!enabled || !sessionId || !revisionKey) {
      setState(EMPTY_STATE);
      return;
    }

    let cancelled = false;
    setState({ suggestions: [], loading: true });
    void apiFetch(`/api/workspace/autopilot/chips?session_id=${encodeURIComponent(sessionId)}`)
      .then(async (response) => {
        if (!response.ok) return [];
        return readSuggestions(await response.json());
      })
      .catch(() => [])
      .then((suggestions) => {
        if (!cancelled) setState({ suggestions, loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, revisionKey, sessionId]);

  const more = useCallback(async () => {
    const cur = stateRef.current;
    if (!enabled || !sessionId || cur.loading || cur.loadingMore || cur.suggestions.length >= MAX_SUGGESTIONS) return;
    const gen = genRef.current;
    setState((s) => ({ ...s, loadingMore: true, moreFailed: false }));
    const { next, capped, failed } = await apiFetch(moreSuggestionsUrl(sessionId, cur.suggestions))
      .then(async (response) => {
        const body = response.ok ? ((await response.json().catch(() => null)) as { more_capped?: unknown } | null) : null;
        if (!body) return { next: [] as BuildSuggestion[], capped: false, failed: true };
        return { next: readSuggestions(body), capped: body.more_capped === true, failed: false };
      })
      .catch(() => ({ next: [] as BuildSuggestion[], capped: false, failed: true }));
    if (gen !== genRef.current) return;
    if (failed) {
      setState((s) => ({ ...s, loadingMore: false, moreFailed: true }));
      return;
    }
    setState((s) => {
      const merged = mergeSuggestions(s.suggestions, next);
      const exhausted = capped || merged.length === s.suggestions.length || merged.length >= MAX_SUGGESTIONS;
      return { ...s, suggestions: merged, loadingMore: false, exhausted };
    });
  }, [enabled, sessionId]);

  return { ...state, more };
}
