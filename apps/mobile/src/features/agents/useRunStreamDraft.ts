import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { realtimeReady } from "../../lib/realtimeReady";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { EMPTY_DRAFT, applyStreamDraftUpdate, type StreamDraftRow } from "./streamDraftState";

export type RunStreamDraft = {
  text: string;
  status: string;
};

const POLL_MS = 1500;

let joinSeq = 0;

async function fetchRunStreamDraft(runId: string): Promise<StreamDraftRow | null> {
  const { data, error } = await supabase
    .from("agent_run_stream_drafts")
    .select("seq, text, status, updated_at")
    .eq("run_id", runId)
    .maybeSingle();

  if (error || !data) return null;
  return data as StreamDraftRow;
}

export function useRunStreamDraft(runId: string | null, enabled: boolean): RunStreamDraft {
  const tenant = useActiveTenant();
  const active = enabled && tenant !== "none" && !!runId;
  const [accum, setAccum] = useState(EMPTY_DRAFT);

  const apply = useCallback(
    (row: StreamDraftRow) => {
      if (runId) setAccum((prev) => applyStreamDraftUpdate(prev, runId, row));
    },
    [runId],
  );

  const poll = useQuery({
    queryKey: ["run-stream-draft", tenant, runId ?? "none"],
    queryFn: () => fetchRunStreamDraft(runId as string),
    enabled: active,
    retry: false,
    refetchInterval: active ? POLL_MS : false,
  });
  useEffect(() => {
    if (poll.data) apply(poll.data);
  }, [poll.data, apply]);

  useEffect(() => {
    if (!active || !runId) return;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    void realtimeReady().then(() => {
      if (cancelled) return;
      channel = supabase
        .channel(`stream-draft:${runId}:${++joinSeq}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "agent_run_stream_drafts", filter: `run_id=eq.${runId}` },
          (payload) => {
            const row = payload.new as Partial<StreamDraftRow> | null;
            if (row && row.seq !== undefined) apply(row as StreamDraftRow);
          },
        )
        .subscribe();
    });
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [active, runId, apply]);

  if (!active || accum.runId !== runId) return { text: "", status: "" };
  return { text: accum.text, status: accum.status || "streaming" };
}
