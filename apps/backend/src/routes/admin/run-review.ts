
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { computeRegressionSignature } from "@/services/agents/regression-signature";

const RUN_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Body = z.object({
  verdict: z.enum(["score_correct", "score_wrong", "bug"]),
  comment: z.string().max(2000).nullable().optional(),
});

type RecordRow = {
  review_id: number;
  out_tenant_id: string;
  out_agent_slug: string;
};

export async function staffRunReviewWrite(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const runId = req.params.run_id;
  if (!RUN_ID_UUID_RE.test(runId)) {
    res.status(400).json({ error: { code: "invalid_run_id", message: "run_id must be a UUID" } });
    return;
  }
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const { verdict, comment } = parsed.data;
  const sb = serviceClient();

  let regressionSignature: string | null = null;
  let runForSig:
    | { agent_slug: string; model_used: string | null; status: string }
    | null = null;
  if (verdict === "bug") {
    const { data: run, error: runErr } = await sb
      .from("agent_runs")
      .select("agent_slug, model_used, status")
      .eq("id", runId)
      .maybeSingle<{ agent_slug: string; model_used: string | null; status: string }>();
    if (runErr) {
      res.status(500).json({ error: { code: "run_query_failed", message: runErr.message } });
      return;
    }
    if (!run) {
      res.status(404).json({ error: { code: "not_found", message: "agent_run not found" } });
      return;
    }
    runForSig = run;
    regressionSignature = computeRegressionSignature({
      agent_slug: run.agent_slug,
      engine: run.model_used ?? null,
      failing_tool_name: "admin_flagged_bug",
      status: run.status,
      raw_code: null,
      steps: [],
    }).signature;
  }

  const { data, error } = await sb
    .rpc("record_agent_run_review", {
      p_run_id: runId,
      p_staff_user_id: staff.user_id,
      p_staff_email: staff.email,
      p_verdict: verdict,
      p_comment: comment ?? null,
      p_regression_signature: regressionSignature,
    })
    .single<RecordRow>();

  if (error || !data) {
    const msg = error?.message ?? "rpc returned no row";
    const lower = msg.toLowerCase();
    if (lower.includes("not found") || lower.includes("bad verdict") || lower.includes("null")) {
      res.status(400).json({ error: { code: "rpc_rejected", message: msg } });
      return;
    }
    res.status(500).json({ error: { code: "rpc_failed", message: msg } });
    return;
  }

  let recurrence = false;
  if (verdict === "bug" && regressionSignature && runForSig) {
    try {
      const { data: rpc } = await sb.rpc("register_regression_signature", {
        p_run_id: runId,
        p_signature: regressionSignature,
        p_sig_version: 1,
        p_code_class: "other",
        p_agent_slug: runForSig.agent_slug,
        p_engine: runForSig.model_used ?? null,
      });
      const row = Array.isArray(rpc) ? rpc[0] : rpc;
      recurrence = !!row?.was_recurrence;
    } catch (e) {
      console.warn(
        `[run-review] register_regression_signature failed for run=${runId}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  res.json({
    ok: true,
    review_id: data.review_id,
    agent_slug: data.out_agent_slug,
    verdict,
    regression_signature: regressionSignature,
    recurrence,
  });
}

type ReviewRow = {
  id: number;
  verdict: string;
  ai_score_at_review: number | null;
  quality_model: string | null;
  comment: string | null;
  regression_signature: string | null;
  staff_email: string | null;
  staff_user_id: string;
  created_at: string;
  updated_at: string;
};

export async function staffRunReviewList(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const runId = req.params.run_id;
  if (!RUN_ID_UUID_RE.test(runId)) {
    res.status(400).json({ error: { code: "invalid_run_id", message: "run_id must be a UUID" } });
    return;
  }
  const { data, error } = await serviceClient()
    .from("agent_run_review")
    .select(
      "id, verdict, ai_score_at_review, quality_model, comment, regression_signature, staff_email, staff_user_id, created_at, updated_at",
    )
    .eq("run_id", runId)
    .order("updated_at", { ascending: false });
  if (error) {
    res.status(500).json({ error: { code: "reviews_query_failed", message: error.message } });
    return;
  }
  res.json({ reviews: (data ?? []) as ReviewRow[] });
}

type CalibRow = {
  out_quality_model: string;
  out_agent_slug: string;
  correct: number;
  wrong: number;
  total: number;
  accuracy_pct: number | null;
};

export async function staffJudgeCalibration(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const minLabels = Math.max(1, Number(req.query.min_labels ?? 1));
  const { data, error } = await serviceClient().rpc("list_judge_calibration", {
    p_min_labels: minLabels,
  });
  if (error) {
    res.status(500).json({ error: { code: "calibration_query_failed", message: error.message } });
    return;
  }
  const rows = ((data ?? []) as CalibRow[]).map((r) => ({
    quality_model: r.out_quality_model,
    agent_slug: r.out_agent_slug,
    correct: r.correct,
    wrong: r.wrong,
    total: r.total,
    accuracy_pct: r.accuracy_pct,
  }));
  res.json({ calibration: rows });
}
