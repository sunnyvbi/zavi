
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { aggregateGaps, type GapEpisode } from "@/services/memory/gap-aggregate";
import { OPERATOR_FAILURE_SHAPES } from "@/agents/operator/failure-shapes";

const FAILED_STATUSES = ["failed", "parse_failed", "dispatch_error"];

export type GapSignalRow = {
  tenant_id: string;
  agent_slug: string;
  status: string;
  created_at: string;
  redacted_trajectory: { question?: unknown } | null;
  trust_tier?: number | null;
};

export function extractGapEpisodes(rows: GapSignalRow[]): {
  episodes: GapEpisode[];
  withQuestion: number;
} {
  const episodes: GapEpisode[] = [];
  let withQuestion = 0;
  for (const r of rows) {
    if (r.trust_tier === 3) continue;
    const question = r.redacted_trajectory?.question;
    if (typeof question === "string" && question.trim()) {
      withQuestion += 1;
      episodes.push({
        tenant_id: r.tenant_id,
        agent_slug: r.agent_slug,
        status: r.status,
        created_at: r.created_at,
        question,
      });
    }
  }
  return { episodes, withQuestion };
}

export async function staffGaps(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 14)));
  const minCount = Math.max(1, Number(req.query.min_count ?? 1));
  const tenantFilter = typeof req.query.tenant_id === "string" ? req.query.tenant_id : null;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let q = serviceClient()
    .from("memory_signal")
    .select("tenant_id, agent_slug, status, created_at, redacted_trajectory")
    .in("status", FAILED_STATUSES)
    .lt("trust_tier", 3)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (tenantFilter) q = q.eq("tenant_id", tenantFilter);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ error: { code: "gaps_query_failed", message: error.message } });
    return;
  }

  const { episodes, withQuestion } = extractGapEpisodes(
    (data ?? []) as GapSignalRow[],
  );

  const gaps = aggregateGaps(episodes, minCount);
  res.json({
    window_days: days,
    min_count: minCount,
    total_failed_episodes: (data ?? []).length,
    with_question: withQuestion,
    gap_count: gaps.length,
    gaps: gaps.slice(0, 200),
  });
}

export type OperatorShapeRow = {
  status: string;
  created_at: string;
  trust_tier?: number | null;
  provenance: { failure_shapes?: unknown } | null;
};

export function aggregateOperatorShapes(
  rows: OperatorShapeRow[],
  knownShapes: readonly string[],
): {
  tagged_episodes: number;
  by_shape: Array<{ shape: string; count: number; last_seen: string }>;
} {
  const known = new Set(knownShapes);
  const counts = new Map<string, { count: number; last_seen: string }>();
  let tagged = 0;
  for (const r of rows) {
    if (r.trust_tier === 3) continue;
    const shapes = r.provenance?.failure_shapes;
    if (!Array.isArray(shapes) || shapes.length === 0) continue;
    let rowCounted = false;
    for (const raw of shapes) {
      if (typeof raw !== "string" || !known.has(raw)) continue;
      if (!rowCounted) {
        tagged += 1;
        rowCounted = true;
      }
      const prev = counts.get(raw);
      if (!prev) {
        counts.set(raw, { count: 1, last_seen: r.created_at });
      } else {
        prev.count += 1;
        if (r.created_at > prev.last_seen) prev.last_seen = r.created_at;
      }
    }
  }
  const by_shape = [...counts.entries()]
    .map(([shape, v]) => ({ shape, count: v.count, last_seen: v.last_seen }))
    .sort((a, b) => b.count - a.count);
  return { tagged_episodes: tagged, by_shape };
}

export async function staffOperatorFailureShapes(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);
  const daysRaw = Number(req.query.days ?? 7);
  const days = Math.min(90, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : 7));
  const tenantFilter =
    typeof req.query.tenant_id === "string" ? req.query.tenant_id : null;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let q = serviceClient()
    .from("memory_signal")
    .select("status, created_at, trust_tier, provenance")
    .eq("agent_slug", "operator")
    .eq("signal_kind", "episode")
    .lt("trust_tier", 3)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (tenantFilter) q = q.eq("tenant_id", tenantFilter);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({
      error: {
        code: "operator_shapes_query_failed",
        message: error.message,
      },
    });
    return;
  }

  const { tagged_episodes, by_shape } = aggregateOperatorShapes(
    (data ?? []) as OperatorShapeRow[],
    OPERATOR_FAILURE_SHAPES,
  );
  res.json({
    window_days: days,
    total_operator_episodes: (data ?? []).length,
    tagged_episodes,
    by_shape,
  });
}
