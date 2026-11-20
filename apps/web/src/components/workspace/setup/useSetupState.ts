import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { isStaleSetup, type SetupResponse } from "./setupState";

export type Mark =
  | { step: "docs" | "connectors"; outcome: "done" | "skipped" }
  | { step: "done" | "home" };

export function useSetupState() {
  const [state, setState] = useState<SetupResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const refreshSequence = useRef(0);
  const appliedRefresh = useRef(0);
  const progressVersion = useRef(0);
  const accept = useCallback((next: SetupResponse) => {
    setState((prev) => (isStaleSetup(prev, next) ? prev : next));
  }, []);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const version = progressVersion.current;
    try {
      const res = await apiFetch("/api/workspace/setup");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as SetupResponse;
      if (version !== progressVersion.current || sequence < appliedRefresh.current) return;
      appliedRefresh.current = sequence;
      accept(next);
      setLoadError(false);
    } catch {
      if (version !== progressVersion.current || sequence < appliedRefresh.current) return;
      appliedRefresh.current = sequence;
      setLoadError(true);
    }
  }, [accept]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mark = useCallback(async (m: Mark) => {
    const sequence = ++refreshSequence.current;
    const res = await apiFetch("/api/workspace/setup/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(m),
    });
    if (!res.ok) throw new Error(`Could not save that step (HTTP ${res.status}).`);
    const next = (await res.json()) as SetupResponse;
    progressVersion.current += 1;
    if (sequence < appliedRefresh.current) {
      setState((prev) => {
        if (!prev || prev.enabled !== true || next.enabled !== true) return prev;
        return {
          ...prev,
          docs: prev.docs.status === "pending" ? next.docs : prev.docs,
          connectors: prev.connectors.status === "pending" ? next.connectors : prev.connectors,
          done: prev.done || next.done,
          home_seen: prev.home_seen || next.home_seen,
        };
      });
    } else {
      appliedRefresh.current = sequence;
      accept(next);
    }
    return next.enabled ? next : null;
  }, [accept]);

  return { state, loadError, refresh, mark };
}
