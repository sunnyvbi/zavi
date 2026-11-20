"use client";

import { useCallback, useEffect, useState } from "react";
import { useRealtimeChannel } from "@/lib/workspace/useRealtimeChannel";
import { createBrowserSupabase } from "@/lib/supabase";
import { tenantRealtimeFilter } from "./tenantScope";
import type { PulseEvent } from "./BrainGraph";

const PULSE_BUFFER_MS = 8000;

export function useBrainPulse(
  _anchorIds: string[],
  tenantId: string | null | undefined,
): {
  pulses: PulseEvent[];
  reads24h: number;
} {
  const [pulses, setPulses] = useState<PulseEvent[]>([]);
  const [reads24h, setReads24h] = useState(0);

  useEffect(() => {
    if (typeof tenantId !== "string") return;
    let cancelled = false;
    const sb = createBrowserSupabase();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const fetchReads = async () => {
      const { count } = await sb
        .from("agent_runs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .gte("finished_at", since);
      if (!cancelled && typeof count === "number") setReads24h(count);
    };
    fetchReads();
    const t = setInterval(fetchReads, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [tenantId]);

  useRealtimeChannel<{ id?: string; tenant_id?: string }>({
    table: "memory_note",
    scopeKey: `brain:tenant:${tenantId ?? "none"}`,
    filter: typeof tenantId === "string" ? tenantRealtimeFilter(tenantId) : undefined,
    enabled: typeof tenantId === "string",
    onInsert: useCallback(
      (row: { id?: string; tenant_id?: string }) => {
        if (!row?.id) return;
        if (row.tenant_id !== tenantId) return;
        setPulses((prev) =>
          trimPulses([
            ...prev,
            { nodeId: `n:${row.id}`, kind: "write", ts: Date.now() },
          ]),
        );
      },
      [tenantId],
    ),
  });

  return { pulses, reads24h };
}

function trimPulses(list: PulseEvent[]): PulseEvent[] {
  const cutoff = Date.now() - PULSE_BUFFER_MS;
  return list.filter((p) => p.ts >= cutoff).slice(-50);
}
