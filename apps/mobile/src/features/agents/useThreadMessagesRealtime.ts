import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { realtimeReady } from "../../lib/realtimeReady";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { NEW_THREAD_SLOT, agentQueryKeys } from "./hooks";

let joinSeq = 0;

export function useThreadMessagesRealtime(slug: string, slot: string): void {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const [generation, setGeneration] = useState(0);
  const live = tenant !== "none" && !!slug && !!slot && slot !== NEW_THREAD_SLOT;

  useEffect(() => {
    if (!live) return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      void qc.invalidateQueries({ queryKey: agentQueryKeys.history(tenant, slug, slot) });
      setGeneration((g) => g + 1);
    });
    return () => sub.remove();
  }, [live, qc, tenant, slug, slot]);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    void realtimeReady().then(() => {
      if (cancelled) return;
      channel = supabase
        .channel(`thread-msgs:${slot}:${generation}:${++joinSeq}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "agent_thread_messages", filter: `thread_id=eq.${slot}` },
          () => {
            void qc.invalidateQueries({ queryKey: agentQueryKeys.history(tenant, slug, slot) });
          },
        )
        .subscribe();
    });
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [live, qc, tenant, slug, slot, generation]);
}
