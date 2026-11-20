
import { useState, useCallback, useRef, useEffect } from "react";
import { getBrowserSupabaseSingleton } from "@/lib/realtimeAuth";
import { useRealtimeChannel } from "./useRealtimeChannel";

export interface StreamDraftRow {
  run_id: string;
  tenant_id: string;
  seq: number | string;
  text: string;
  status: string;
}

export interface RunStreamDraft {
  text: string;
  status: string;
}

export interface StreamDraftAccum {
  text: string;
  status: string;
  lastSeq: number;
}

export const EMPTY_DRAFT_ACCUM: StreamDraftAccum = {
  text: "",
  status: "",
  lastSeq: -1,
};

export function applyStreamDraftUpdate(
  prev: StreamDraftAccum,
  row: { seq: number | string; text?: string; status?: string },
): StreamDraftAccum {
  const seq = typeof row.seq === "string" ? Number(row.seq) : row.seq;
  if (!Number.isFinite(seq) || seq <= prev.lastSeq) return prev;
  return {
    text: row.text ?? "",
    status: row.status ?? "streaming",
    lastSeq: seq,
  };
}

export function useRunStreamDraft(
  runId: string | null,
  enabled: boolean,
): RunStreamDraft {
  const [state, setState] = useState<{ runId: string | null; accum: StreamDraftAccum }>({ runId: null, accum: EMPTY_DRAFT_ACCUM });
  const currentRun = useRef(runId);
  currentRun.current = enabled ? runId : null;
  const lastUpdate = useRef(0);
  const terminal = useRef(false);
  const readLatest = useRef<() => void>(() => {});
  const onChange = useCallback((row: StreamDraftRow) => {
    if (!enabled || !runId || currentRun.current !== runId || !row || row.run_id !== runId) return;
    lastUpdate.current = Date.now();
    setState(prev => {
      const base = prev.runId === runId ? prev.accum : EMPTY_DRAFT_ACCUM;
      const accum = applyStreamDraftUpdate(base, row);
      if (accum === base) return prev;
      return { runId, accum };
    });
  }, [runId, enabled]);

  useEffect(() => {
    if (!enabled || !runId) return;
    let cancelled = false;
    terminal.current = false;
    lastUpdate.current = 0;
    const requests = new Set<AbortController>();
    const read = async () => {
      if (cancelled || document.visibilityState === "hidden" || requests.size >= 2) return;
      const controller = new AbortController();
      requests.add(controller);
      const deadline = setTimeout(() => controller.abort(), 5000);
      try {
        const query = getBrowserSupabaseSingleton().from("agent_run_stream_drafts")
          .select("run_id,seq,text,status").eq("run_id", runId).maybeSingle();
        const { data, error } = await (query.abortSignal?.(controller.signal) ?? query);
        if (!cancelled && !error && data) onChange(data as StreamDraftRow);
      } catch {  }
      finally { clearTimeout(deadline); requests.delete(controller); }
    };
    readLatest.current = () => { void read(); };
    void read();
    const visible = () => { if (document.visibilityState !== "hidden") void read(); };
    document.addEventListener("visibilitychange", visible);
    const poll = setInterval(() => {
      if (!terminal.current && Date.now() - lastUpdate.current >= 5000) void read();
    }, 5000);
    return () => {
      cancelled = true;
      readLatest.current = () => {};
      clearInterval(poll);
      document.removeEventListener("visibilitychange", visible);
      for (const request of requests) request.abort();
    };
  }, [runId, enabled, onChange]);

  useEffect(() => {
    terminal.current = enabled && state.runId === runId &&
      ["complete", "failed", "cancelled"].includes(state.accum.status);
  }, [state, runId, enabled]);

  useRealtimeChannel<StreamDraftRow>({
    table: "agent_run_stream_drafts",
    scopeKey: `run:${runId ?? "none"}`,
    filter: runId ? `run_id=eq.${runId}` : undefined,
    event: "*",
    onInsert: onChange,
    onSubscribed: () => readLatest.current(),
    enabled: enabled && !!runId,
  });

  if (!enabled || state.runId !== runId) return { text: "", status: "" };
  return { text: state.accum.text, status: state.accum.status };
}
