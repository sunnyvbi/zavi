
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export type RoutingRunInput = {
  agent_slug: string;
  model_used: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  routing_decision: {
    tier?: string;
    reason_code?: string;
    classifier_ms?: number | null;
    shadow?: boolean;
  } | null;
};

export type RoutingAgentEntry = {
  agent_slug: string;
  routed_runs: number;
  live_runs: number;
  shadow_runs: number;
  tier: Record<string, number>;
  reason_codes: Record<string, number>;
  classifier_runs: number;
  classifier_errors: number;
  classifier_error_rate: number;
  avg_classifier_ms: number | null;
  tokens: { input: number; output: number; cache_read: number; total: number };
  usd: number;
  flags: string[];
};

const CLASSIFIER_REASONS = new Set([
  "classifier_low",
  "classifier_high",
  "classifier_uncertain_opus",
  "classifier_error_opus",
]);

export function aggregateModelRouting(rows: RoutingRunInput[]): {
  perAgent: RoutingAgentEntry[];
  totals: {
    routed_runs: number;
    by_tier: Record<string, number>;
    classifier_runs: number;
    classifier_errors: number;
    classifier_error_rate: number;
  };
} {
  const map = new Map<
    string,
    RoutingAgentEntry & { _msSum: number; _msCount: number }
  >();

  for (const r of rows) {
    const rd = r.routing_decision;
    if (!rd) continue;
    const k = r.agent_slug;
    const cur =
      map.get(k) ??
      {
        agent_slug: k,
        routed_runs: 0,
        live_runs: 0,
        shadow_runs: 0,
        tier: {},
        reason_codes: {},
        classifier_runs: 0,
        classifier_errors: 0,
        classifier_error_rate: 0,
        avg_classifier_ms: null,
        tokens: { input: 0, output: 0, cache_read: 0, total: 0 },
        usd: 0,
        flags: [],
        _msSum: 0,
        _msCount: 0,
      };

    cur.routed_runs += 1;
    if (rd.shadow) cur.shadow_runs += 1;
    else cur.live_runs += 1;

    const tier = rd.tier ?? "unknown";
    cur.tier[tier] = (cur.tier[tier] ?? 0) + 1;

    const reason = rd.reason_code ?? "unknown";
    cur.reason_codes[reason] = (cur.reason_codes[reason] ?? 0) + 1;
    if (CLASSIFIER_REASONS.has(reason)) cur.classifier_runs += 1;
    if (reason === "classifier_error_opus") cur.classifier_errors += 1;

    if (typeof rd.classifier_ms === "number") {
      cur._msSum += rd.classifier_ms;
      cur._msCount += 1;
    }

    const inTok = r.input_tokens ?? 0;
    const outTok = r.output_tokens ?? 0;
    const cacheTok = r.cache_read_tokens ?? 0;
    cur.tokens.input += inTok;
    cur.tokens.output += outTok;
    cur.tokens.cache_read += cacheTok;
    cur.tokens.total +=
      inTok + outTok + cacheTok + (r.cache_creation_tokens ?? 0);
    cur.usd += r.cost_usd ?? 0;

    map.set(k, cur);
  }

  const perAgent: RoutingAgentEntry[] = Array.from(map.values())
    .map((e) => {
      const classifier_error_rate =
        e.classifier_runs > 0 ? e.classifier_errors / e.classifier_runs : 0;
      const avg_classifier_ms =
        e._msCount > 0 ? Math.round(e._msSum / e._msCount) : null;
      const flags: string[] = [];
      if (classifier_error_rate > 0.1 && e.classifier_runs >= 5) {
        flags.push("high_classifier_error");
      }
      const { _msSum, _msCount, ...rest } = e;
      void _msSum;
      void _msCount;
      return { ...rest, classifier_error_rate, avg_classifier_ms, flags };
    })
    .sort((a, b) => b.tokens.total - a.tokens.total);

  const totals = perAgent.reduce(
    (acc, e) => {
      acc.routed_runs += e.routed_runs;
      acc.classifier_runs += e.classifier_runs;
      acc.classifier_errors += e.classifier_errors;
      for (const [t, n] of Object.entries(e.tier)) {
        acc.by_tier[t] = (acc.by_tier[t] ?? 0) + n;
      }
      return acc;
    },
    {
      routed_runs: 0,
      by_tier: {} as Record<string, number>,
      classifier_runs: 0,
      classifier_errors: 0,
      classifier_error_rate: 0,
    },
  );
  totals.classifier_error_rate =
    totals.classifier_runs > 0
      ? totals.classifier_errors / totals.classifier_runs
      : 0;

  return { perAgent, totals };
}

export async function staffModelRouting(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 7)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select(
      "agent_slug, model_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, routing_decision",
    )
    .not("routing_decision", "is", null)
    .gte("enqueued_at", since)
    .limit(10000);
  if (error) {
    res
      .status(500)
      .json({ error: { code: "model_routing_query_failed", message: error.message } });
    return;
  }

  const { perAgent, totals } = aggregateModelRouting(
    (data ?? []) as RoutingRunInput[],
  );
  res.json({ days, totals, perAgent });
}
