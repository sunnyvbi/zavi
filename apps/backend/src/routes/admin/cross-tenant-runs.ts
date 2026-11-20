
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

const STUCK_RUNNING_MIN = 5;
const STUCK_QUEUED_MIN = 10;

export async function staffRunsFirehose(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const limit = Math.min(500, Number(req.query.limit ?? 100));
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const slug = typeof req.query.slug === "string" ? req.query.slug : null;
  const tenantId = typeof req.query.tenant_id === "string" ? req.query.tenant_id : null;
  const stuck = req.query.stuck === "1" || req.query.stuck === "true";
  const maxScore =
    typeof req.query.max_score === "string" && req.query.max_score.length > 0
      ? Number(req.query.max_score)
      : null;
  const unreviewedOnly = req.query.unreviewed === "1" || req.query.unreviewed === "true";

  const sb = serviceClient();
  let q = sb
    .from("agent_runs")
    .select(
      "id, tenant_id, agent_slug, status, parse_ok, cost_tokens, cost_usd, started_at, finished_at, enqueued_at, last_progress_at, inngest_run_id, quality_score, quality_scored_at, trigger, output_text, payload",
    )
    .order("enqueued_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);
  if (slug) q = q.eq("agent_slug", slug);
  if (tenantId) q = q.eq("tenant_id", tenantId);
  if (maxScore != null && Number.isFinite(maxScore)) q = q.lte("quality_score", maxScore);

  if (stuck) {
    const now = Date.now();
    const runningCutoff = new Date(now - STUCK_RUNNING_MIN * 60 * 1000).toISOString();
    const queuedCutoff = new Date(now - STUCK_QUEUED_MIN * 60 * 1000).toISOString();
    q = q.or(
      [
        `and(status.eq.running,last_progress_at.lt.${runningCutoff})`,
        `and(status.eq.running,last_progress_at.is.null,started_at.lt.${runningCutoff})`,
        `and(status.eq.queued,enqueued_at.lt.${queuedCutoff})`,
      ].join(","),
    );
  }

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ error: { code: "runs_query_failed", message: error.message } });
    return;
  }

  type RunRow = {
    id: string;
    quality_score: number | null;
    trigger: string | null;
    output_text: string | null;
    payload: Record<string, unknown> | null;
    [k: string]: unknown;
  };
  const baseRuns = (data ?? []) as RunRow[];
  const reviewCount = new Map<string, number>();
  if (baseRuns.length > 0) {
    const ids = baseRuns.map((r) => r.id);
    const { data: reviews } = await sb
      .from("agent_run_review")
      .select("run_id")
      .in("run_id", ids);
    for (const row of (reviews ?? []) as Array<{ run_id: string }>) {
      reviewCount.set(row.run_id, (reviewCount.get(row.run_id) ?? 0) + 1);
    }
  }

  const msgIds = baseRuns
    .map((r) => (typeof r.payload?.user_message_id === "string" ? r.payload.user_message_id : null))
    .filter((v): v is string => !!v);
  const requestByMsgId = new Map<string, string>();
  if (msgIds.length > 0) {
    const { data: msgs } = await sb
      .from("agent_thread_messages")
      .select("id, body")
      .in("id", Array.from(new Set(msgIds)));
    for (const m of (msgs ?? []) as Array<{ id: string; body: string | null }>) {
      if (m.body) requestByMsgId.set(m.id, m.body);
    }
  }

  const clip = (s: string | null | undefined, n: number): string | null => {
    if (!s) return null;
    const flat = s.replace(/\s+/g, " ").trim();
    if (!flat) return null;
    return flat.length > n ? flat.slice(0, n) + "…" : flat;
  };

  let runs = baseRuns.map((r) => {
    const msgId =
      typeof r.payload?.user_message_id === "string" ? r.payload.user_message_id : null;
    const request_preview = msgId ? clip(requestByMsgId.get(msgId) ?? null, 160) : null;
    const { output_text: _o, payload: _p, ...rest } = r;
    return {
      ...rest,
      review_count: reviewCount.get(r.id) ?? 0,
      request_preview,
      output_preview: clip(r.output_text, 200),
    };
  });
  if (unreviewedOnly) runs = runs.filter((r) => r.review_count === 0);

  res.json({ runs });
}

const RUN_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function staffRunDetail(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const runId = req.params.run_id;
  if (!RUN_ID_UUID_RE.test(runId)) {
    res.status(400).json({ error: { code: "invalid_run_id", message: "run_id must be a UUID" } });
    return;
  }
  const sb = serviceClient();

  const { data: run, error: runErr } = await sb
    .from("agent_runs")
    .select(
      "id, tenant_id, agent_slug, status, trigger, parse_ok, cost_tokens, cost_usd, started_at, finished_at, enqueued_at, output_text, error, last_progress_at, inngest_run_id, quality_score, quality_rationale, quality_model, quality_scored_at",
    )
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

  const { data: events, error: evErr } = await sb
    .from("agent_run_events")
    .select("id, stage, meta, created_at")
    .eq("agent_run_id", runId)
    .order("created_at", { ascending: true })
    .limit(500);
  if (evErr) {
    res.status(500).json({ error: { code: "events_query_failed", message: evErr.message } });
    return;
  }

  const { data: decisions, error: decErr } = await sb
    .from("decisions")
    .select("id, decision_class, status, autonomy_at_emit, emitted_at, approved_at")
    .eq("agent_run_id", runId)
    .order("emitted_at", { ascending: true });
  if (decErr) {
    res.status(500).json({ error: { code: "decisions_query_failed", message: decErr.message } });
    return;
  }

  res.json({ run, events: events ?? [], decisions: decisions ?? [] });
}
