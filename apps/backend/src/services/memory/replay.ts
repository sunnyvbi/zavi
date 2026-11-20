
import { searchMemory } from "./index";

export const REPLAY_SCHEMA_VERSION = 1;

export type CapturedRow = {
  schema_version: number;
  tenant_id: string;
  tool_name: "search" | "query";
  query: string;
  retrieved_chunk_ids: string[];
  retrieved_note_ids: string[];
  latency_ms: number;
  k: number;
  run_id: string | null;
  agent_slug: string | null;
  created_at: string;
};

export type Regression = {
  query: string;
  jaccard: number;
  captured_top: number;
  current_top: number;
};

export type ReplayReport = {
  schema_version: 1;
  metric_name: "scrubbed_query_jaccard_at_k";
  captured_at_range: [string, string] | null;
  tenant_id: string;
  queries_replayed: number;
  queries_skipped: number;
  queries_errored: number;
  queries_rejected_cross_tenant: number;
  mean_jaccard: number;
  top1_stability: number;
  latency_delta_ms_mean: number;
  latency_delta_ms_p50: number;
  latency_delta_ms_p95: number;
  regressions: Regression[];
};

export function jaccardAtK(
  captured: string[],
  current: string[],
  k: number = 10,
): number {
  const a = new Set(captured.slice(0, k));
  const b = new Set(current.slice(0, k));
  if (a.size === 0 && b.size === 0) return 1.0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1.0;
  return inter / union.size;
}

export function top1Stable(captured: string[], current: string[]): boolean {
  if (captured.length === 0 || current.length === 0) return false;
  return captured[0] === current[0];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function parseNdjson(text: string): {
  rows: CapturedRow[];
  errors: string[];
} {
  const rows: CapturedRow[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (
        typeof obj.tenant_id === "string" &&
        typeof obj.query === "string" &&
        Array.isArray(obj.retrieved_chunk_ids) &&
        typeof obj.k === "number"
      ) {
        rows.push(obj as CapturedRow);
      } else {
        errors.push(`line ${i + 1}: missing required fields`);
      }
    } catch (e) {
      errors.push(`line ${i + 1}: ${(e as Error).message}`);
    }
  }
  return { rows, errors };
}

export type RunReplayInput = {
  tenant_id: string;
  baselineNdjson: string;
};

export async function runReplay(
  input: RunReplayInput,
): Promise<ReplayReport> {
  const { rows, errors } = parseNdjson(input.baselineNdjson);

  const matched = rows.filter((r) => r.tenant_id === input.tenant_id);
  const rejected = rows.length - matched.length;

  const jaccards: number[] = [];
  let top1Count = 0;
  const latencyDeltas: number[] = [];
  const regressions: Regression[] = [];
  let replayed = 0;
  let errored = errors.length;

  let minTs: string | null = null;
  let maxTs: string | null = null;

  for (const row of matched) {
    if (row.created_at) {
      if (!minTs || row.created_at < minTs) minTs = row.created_at;
      if (!maxTs || row.created_at > maxTs) maxTs = row.created_at;
    }
    const startedAt = Date.now();
    let currentHits: { chunk_id: string }[] = [];
    try {
      currentHits = await searchMemory(row.tenant_id, row.query, row.k);
    } catch (e) {
      errored++;
      continue;
    }
    const currentIds = currentHits
      .map((h) => h.chunk_id)
      .filter((id): id is string => typeof id === "string");
    const elapsed = Date.now() - startedAt;
    const j = jaccardAtK(row.retrieved_chunk_ids, currentIds, row.k);
    jaccards.push(j);
    if (top1Stable(row.retrieved_chunk_ids, currentIds)) top1Count++;
    latencyDeltas.push(elapsed - row.latency_ms);
    if (j < 0.5) {
      regressions.push({
        query: row.query,
        jaccard: Number(j.toFixed(3)),
        captured_top: row.retrieved_chunk_ids.length,
        current_top: currentIds.length,
      });
    }
    replayed++;
  }

  const sortedDeltas = [...latencyDeltas].sort((a, b) => a - b);
  const mean = (arr: number[]): number =>
    arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

  regressions.sort((a, b) => a.jaccard - b.jaccard);

  return {
    schema_version: 1,
    metric_name: "scrubbed_query_jaccard_at_k",
    captured_at_range: minTs && maxTs ? [minTs, maxTs] : null,
    tenant_id: input.tenant_id,
    queries_replayed: replayed,
    queries_skipped: 0,
    queries_errored: errored,
    queries_rejected_cross_tenant: rejected,
    mean_jaccard: Number(mean(jaccards).toFixed(4)),
    top1_stability: replayed > 0 ? Number((top1Count / replayed).toFixed(4)) : 0,
    latency_delta_ms_mean: Math.round(mean(latencyDeltas)),
    latency_delta_ms_p50: Math.round(percentile(sortedDeltas, 50)),
    latency_delta_ms_p95: Math.round(percentile(sortedDeltas, 95)),
    regressions: regressions.slice(0, 20),
  };
}

import { serviceClient } from "@/services/supabase";

export type ExportInput = {
  tenant_id: string;
  since_days: number;
  tool_name?: "search" | "query";
};

export type ExportResult = {
  rows_written: number;
};

export async function streamExport(
  input: ExportInput,
  writable: { write(line: string): boolean | void; end?(): void },
): Promise<ExportResult> {
  const sinceDate = new Date(
    Date.now() - input.since_days * 24 * 60 * 60 * 1000,
  ).toISOString();
  let query = serviceClient()
    .from("eval_candidates")
    .select(
      "tenant_id, tool_name, query, retrieved_chunk_ids, retrieved_note_ids, latency_ms, k, run_id, agent_slug, created_at",
    )
    .eq("tenant_id", input.tenant_id)
    .gte("created_at", sinceDate)
    .order("created_at", { ascending: true });
  if (input.tool_name) query = query.eq("tool_name", input.tool_name);

  const { data, error } = await query;
  if (error) throw new Error(`brain-eval-export query failed: ${error.message}`);
  const rows = (data ?? []) as Omit<CapturedRow, "schema_version">[];
  for (const row of rows) {
    const line =
      JSON.stringify({ schema_version: REPLAY_SCHEMA_VERSION, ...row }) + "\n";
    writable.write(line);
  }
  if (writable.end) writable.end();
  return { rows_written: rows.length };
}
