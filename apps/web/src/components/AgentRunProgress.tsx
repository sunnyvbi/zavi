"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { realtimeAuthReady } from "@/lib/realtimeAuth";
import { humanizeToolName } from "@/lib/workspace/humanizeToolName";

type Stage =
  | "enqueued"
  | "claimed"
  | "loaded_context"
  | "tool_use_started"
  | "tool_use_completed"
  | "tool_use_errored"
  | "iter_cap_summarize"
  | "envelope_extracted"
  | "parsed"
  | "parse_failed"
  | "persisted"
  | "completed"
  | "failed";

type Meta = {
  tool_name?: string;
  ms?: number;
  code?: string;
  iter?: number;
};

type EventRow = {
  id: number;
  agent_run_id: string;
  stage: Stage;
  meta: Meta | null;
  created_at: string;
};

const STAGE_LABELS: Record<Stage, string> = {
  enqueued: "QUEUED",
  claimed: "CLAIMED",
  loaded_context: "LOAD CONTEXT",
  tool_use_started: "TOOL CALL",
  tool_use_completed: "TOOL OK",
  tool_use_errored: "TOOL ERR",
  iter_cap_summarize: "ITER CAP: SUMMARIZE",
  envelope_extracted: "PARSING",
  parsed: "PARSED",
  parse_failed: "PARSE FAIL",
  persisted: "PERSISTED",
  completed: "DONE",
  failed: "FAILED",
};

const TERMINAL: Set<Stage> = new Set(["completed", "failed", "parse_failed"]);

function pillClass(stage: Stage): string {
  const base =
    "inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-mono tracking-[0.08em] uppercase";
  if (stage === "completed" || stage === "persisted" || stage === "parsed") {
    return `${base} bg-emerald-100 text-emerald-800`;
  }
  if (stage === "failed" || stage === "parse_failed" || stage === "tool_use_errored") {
    return `${base} bg-rose-100 text-rose-800`;
  }
  if (stage === "tool_use_started" || stage === "tool_use_completed") {
    return `${base} bg-sky-100 text-sky-800`;
  }
  if (stage === "iter_cap_summarize") {
    return `${base} bg-amber-100 text-amber-800`;
  }
  return `${base} bg-slate-100 text-slate-700`;
}

export function AgentRunProgress({ run_id }: { run_id: string }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const supabase = useMemo(() => createBrowserSupabase(), []);

  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    async function init() {
      const { data: existing } = await supabase
        .from("agent_run_events")
        .select("id, agent_run_id, stage, meta, created_at")
        .eq("agent_run_id", run_id)
        .order("created_at", { ascending: true })
        .limit(200);
      if (cancelled) return;
      if (existing) {
        setEvents(existing as EventRow[]);
      }

      await realtimeAuthReady();
      if (cancelled) return;
      channel = supabase
        .channel(`agent_run_events:${run_id}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "agent_run_events",
            filter: `agent_run_id=eq.${run_id}`,
          },
          (payload) => {
            const row = payload.new as EventRow;
            setEvents((prev) => [...prev, row]);
          },
        )
        .subscribe();
    }

    init();
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [run_id, supabase]);

  if (events.length === 0) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-slate-500">
        <span className="inline-flex gap-0.5" aria-hidden="true">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-pulse [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-pulse [animation-delay:200ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-pulse [animation-delay:400ms]" />
        </span>
        <span className="italic">Waiting for first event…</span>
      </div>
    );
  }

  const headline = computeHeadline(events);

  return (
    <div className="space-y-3">
      <div className="text-[13px] text-slate-700">{headline}</div>
      <div className="flex flex-wrap gap-2">
        {events.map((e) => (
          <span key={e.id} className={pillClass(e.stage)}>
            {STAGE_LABELS[e.stage] ?? e.stage}
            {e.meta?.tool_name ? <span className="ml-1 text-[11px] opacity-70">{humanizeToolName(e.meta.tool_name)}</span> : null}
            {typeof e.meta?.ms === "number" ? <span className="ml-1 text-[11px] opacity-60">{e.meta.ms}ms</span> : null}
            {e.meta?.code ? <span className="ml-1 text-[11px] opacity-60">{e.meta.code}</span> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function computeHeadline(events: EventRow[]): string {
  if (events.length === 0) return "Waiting…";
  const last = events[events.length - 1];
  const elapsed = elapsedSeconds(events[0].created_at, last.created_at);

  if (last.stage === "completed" || last.stage === "persisted" || last.stage === "parsed") {
    return `Done · ${elapsed}s`;
  }
  if (last.stage === "failed") return `Failed · ${elapsed}s`;
  if (last.stage === "parse_failed") return `Output didn't fit schema · ${elapsed}s`;
  if (last.stage === "tool_use_started" || last.stage === "tool_use_completed") {
    const toolName = last.meta?.tool_name;
    return `Running · using ${toolName ? humanizeToolName(toolName) : "a tool"} · ${elapsed}s elapsed`;
  }
  if (last.stage === "tool_use_errored") {
    return `Tool error · retrying · ${elapsed}s elapsed`;
  }
  if (last.stage === "iter_cap_summarize") {
    return `Hit iteration cap · summarizing · ${elapsed}s elapsed`;
  }
  if (last.stage === "envelope_extracted") return `Almost done · parsing output · ${elapsed}s elapsed`;
  if (last.stage === "loaded_context") return `Loaded context · thinking · ${elapsed}s elapsed`;
  if (last.stage === "claimed") return `Claimed by worker · starting · ${elapsed}s elapsed`;
  if (last.stage === "enqueued") return `Queued · waiting for worker · ${elapsed}s elapsed`;
  return `Running · ${elapsed}s elapsed`;
}

function elapsedSeconds(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}

export function isTerminalStage(s: Stage): boolean {
  return TERMINAL.has(s);
}
