import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

type ScopeStatus = { connected: boolean; missing?: string[] };

export function useSlackScopeStatus(enabled: boolean, reloadKey: number = 0): string[] {
  return useSlackScopeState(enabled, reloadKey).missing;
}

export function useSlackScopeState(
  enabled: boolean,
  reloadKey: number = 0,
): { missing: string[]; settled: boolean } {
  const [missing, setMissing] = useState<string[]>([]);
  const [answered, setAnswered] = useState<{ enabled: boolean; reloadKey: number } | null>(null);
  useEffect(() => {
    if (!enabled) {
      setMissing([]);
      setAnswered({ enabled, reloadKey });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/connectors/slack/scope-status");
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as ScopeStatus;
        if (!cancelled) setMissing(json.connected ? json.missing ?? [] : []);
      } catch {
        if (!cancelled) setMissing([]);
      } finally {
        if (!cancelled) setAnswered({ enabled, reloadKey });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, reloadKey]);
  return { missing, settled: answered?.enabled === enabled && answered.reloadKey === reloadKey };
}
