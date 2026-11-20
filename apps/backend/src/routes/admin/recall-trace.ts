
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RECALL_TRACE_LEGEND = {
  recalled_notes:
    "Notes auto-recalled into the agent's context (the '## Relevant prior context' block). The agent had these in front of it.",
  brain_citations:
    "Notes the agent EXPLICITLY searched for via the memory tool during the run. Empty when the run only used auto-recall (the common case) — not an error.",
} as const;

export type RecallTraceRunRow = {
  id: string;
  agent_slug: string | null;
  status: string | null;
};

export type RecallTraceTraceRow = {
  query_hash: string | null;
  returned_count: number | null;
  retrieval_mode: string | null;
  rerank_status: string | null;
  status: string | null;
  latency_ms: number | null;
  created_at: string | null;
  rank_components: Record<string, unknown> | null;
};

export type RecallTraceDecisionRow = {
  body: Record<string, unknown> | null;
};

export type RecalledNote = { note_id: string; title: string; score: number | null };

export type RecallTraceResponse = {
  run_id: string;
  agent_slug: string | null;
  status: string | null;
  recalled_notes: RecalledNote[];
  recalled_note_ids: string[];
  brain_citations: Array<{ note_id: string; title: string }>;
  search_traces: Array<Omit<RecallTraceTraceRow, "rank_components">>;
  legend: typeof RECALL_TRACE_LEGEND;
};

export function extractRecalledNotes(traces: RecallTraceTraceRow[]): Array<{ note_id: string; score: number | null }> {
  const out: Array<{ note_id: string; score: number | null }> = [];
  const seen = new Set<string>();
  const push = (id: unknown, score: unknown) => {
    if (typeof id !== "string" || seen.has(id)) return;
    seen.add(id);
    out.push({ note_id: id, score: typeof score === "number" ? score : null });
  };
  for (const t of traces) {
    const rc = t.rank_components;
    if (!rc) continue;
    const pairs = rc.returned_notes;
    if (Array.isArray(pairs)) {
      for (const p of pairs) {
        if (p && typeof p === "object") push((p as { id?: unknown }).id, (p as { score?: unknown }).score);
      }
      continue;
    }
    const ids = rc.returned_note_ids;
    if (Array.isArray(ids)) for (const id of ids) push(id, undefined);
  }
  return out;
}

export function shapeRecallTrace(
  run: RecallTraceRunRow,
  traces: RecallTraceTraceRow[],
  decisions: RecallTraceDecisionRow[],
  titleById: Map<string, string> = new Map(),
): RecallTraceResponse {
  const recalled = extractRecalledNotes(traces);
  const recalled_notes: RecalledNote[] = recalled.map((r) => ({
    note_id: r.note_id,
    title: titleById.get(r.note_id) ?? "",
    score: r.score,
  }));
  const recalled_note_ids = recalled.map((r) => r.note_id);

  const citeSeen = new Set<string>();
  const brain_citations: Array<{ note_id: string; title: string }> = [];
  for (const d of decisions) {
    const cites = d.body?.brain_citations;
    if (!Array.isArray(cites)) continue;
    for (const c of cites) {
      if (!c || typeof c !== "object") continue;
      const noteId = (c as { note_id?: unknown }).note_id;
      if (typeof noteId !== "string" || citeSeen.has(noteId)) continue;
      citeSeen.add(noteId);
      const title = (c as { title?: unknown }).title;
      brain_citations.push({ note_id: noteId, title: typeof title === "string" ? title : "" });
    }
  }

  const search_traces = traces.map((t) => ({
    query_hash: t.query_hash,
    returned_count: t.returned_count,
    retrieval_mode: t.retrieval_mode,
    rerank_status: t.rerank_status,
    status: t.status,
    latency_ms: t.latency_ms,
    created_at: t.created_at,
  }));

  return {
    run_id: run.id,
    agent_slug: run.agent_slug,
    status: run.status,
    recalled_notes,
    recalled_note_ids,
    brain_citations,
    search_traces,
    legend: RECALL_TRACE_LEGEND,
  };
}

export async function staffRunRecallTrace(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const runId = req.params.run_id;
  if (!UUID_RE.test(runId)) {
    res.status(400).json({ error: { code: "invalid_run_id", message: "run_id must be a UUID" } });
    return;
  }
  const sb = serviceClient();

  const { data: run, error: runErr } = await sb
    .from("agent_runs")
    .select("id, agent_slug, status")
    .eq("id", runId)
    .maybeSingle();
  if (runErr) {
    res.status(500).json({ error: { code: "run_query_failed", message: runErr.message } });
    return;
  }
  if (!run) {
    res.status(404).json({ error: { code: "not_found", message: "agent_run not found" } });
    return;
  }

  const { data: traces, error: trErr } = await sb
    .from("memory_search_trace")
    .select("query_hash, returned_count, retrieval_mode, rerank_status, status, latency_ms, created_at, rank_components")
    .eq("run_id", runId)
    .order("created_at", { ascending: true })
    .limit(50);
  if (trErr) {
    res.status(500).json({ error: { code: "trace_query_failed", message: trErr.message } });
    return;
  }

  const { data: decisions, error: decErr } = await sb
    .from("decisions")
    .select("body")
    .eq("agent_run_id", runId);
  if (decErr) {
    res.status(500).json({ error: { code: "decisions_query_failed", message: decErr.message } });
    return;
  }

  const traceRows = (traces ?? []) as RecallTraceTraceRow[];

  const recalledIds = extractRecalledNotes(traceRows).map((r) => r.note_id);
  const titleById = new Map<string, string>();
  if (recalledIds.length > 0) {
    const { data: notes } = await sb
      .from("memory_note")
      .select("id, title")
      .in("id", recalledIds);
    for (const n of (notes ?? []) as Array<{ id: string; title: string | null }>) {
      titleById.set(n.id, n.title ?? "");
    }
  }

  res.json(
    shapeRecallTrace(
      run as RecallTraceRunRow,
      traceRows,
      (decisions ?? []) as RecallTraceDecisionRow[],
      titleById,
    ),
  );
}
