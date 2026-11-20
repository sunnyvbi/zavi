
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { deleteNotesBySourceRef, writeNote } from "@/services/memory";
import { track } from "@/services/analytics/mixpanel";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";
import { getBoolSettingStrictResolved } from "@/services/settings";
import { BuildReasonsSchema, CARRYOVER_FLAG } from "@/services/sites/build-feedback-reasons";

const Body = z.object({
  target_type: z.enum(["agent_run", "decision", "conductor_run"]),
  target_id: z.string().uuid(),
  rating: z.union([z.literal(-1), z.literal(1), z.null()]).optional(),
  comment: z.string().max(2000).nullable().optional(),
  reasons: BuildReasonsSchema.optional(),
});

type RpcRow = {
  feedback_id: string;
  agent_slug: string;
  tenant_id: string;
};

export async function feedbackSubmit(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: parsed.error.message },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const isBuildFeedback = parsed.data.target_type === "conductor_run";
  const reasons = parsed.data.rating === -1 ? (parsed.data.reasons ?? []) : [];
  const rpc = isBuildFeedback
    ? supabase.rpc("submit_build_feedback", {
        p_target_id: parsed.data.target_id,
        p_rating: parsed.data.rating ?? null,
        p_comment: parsed.data.comment ?? null,
        p_build_reasons: reasons,
      })
    : supabase.rpc("submit_agent_feedback", {
        p_target_type: parsed.data.target_type,
        p_target_id: parsed.data.target_id,
        p_rating: parsed.data.rating ?? null,
        p_comment: parsed.data.comment ?? null,
      });
  const { data, error } = await rpc
    .single<RpcRow>();

  if (error || !data) {
    const msg = error?.message ?? "rpc returned no row";
    const lower = msg.toLowerCase();
    if (
      lower.includes("unauthorized") ||
      lower.includes("unauthenticated") ||
      lower.includes("not found") ||
      lower.includes("invalid") ||
      lower.includes("must include") ||
      lower.includes("not derivable")
    ) {
      res.status(400).json({ error: { code: "rpc_rejected", message: msg } });
      return;
    }
    res.status(500).json({ error: { code: "rpc_failed", message: msg } });
    return;
  }

  let carryover = false;
  if (isBuildFeedback && reasons.length > 0) {
    carryover = await getBoolSettingStrictResolved(CARRYOVER_FLAG, data.tenant_id).catch(() => false);
  }

  if (parsed.data.comment?.trim()) {
    void notifyFounderActivity({
      event: "feedback_submitted",
      tenant_id: data.tenant_id,
      user_id: auth.user_id,
      details: {
        kind: "agent feedback",
        agent: data.agent_slug,
        rating: parsed.data.rating ?? null,
        feedback: parsed.data.comment,
      },
    });
  }

  track("feedback_submitted", {
    tenant_id: data.tenant_id,
    user_id: auth.user_id,
    agent_slug: data.agent_slug,
    target_type: parsed.data.target_type,
    rating: parsed.data.rating ?? null,
    has_comment: Boolean(parsed.data.comment?.trim()),
  });

  const noteRef = `${parsed.data.target_type}:${parsed.data.target_id}:${data.feedback_id}`;
  if (parsed.data.target_type !== "conductor_run") {
    try {
      await deleteNotesBySourceRef(data.tenant_id, "operator_feedback", noteRef, auth.user_id);
    } catch (e: unknown) {
      console.warn(
        `[feedback] clearing the previous note failed for feedback_id=${data.feedback_id}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  if (parsed.data.target_type !== "conductor_run" && parsed.data.comment && parsed.data.comment.trim().length > 0) {
    const ratingTag =
      parsed.data.rating === 1
        ? "rating:+1"
        : parsed.data.rating === -1
          ? "rating:-1"
          : "rating:none";
    try {
      await writeNote(data.tenant_id, {
        title: `Operator feedback on ${parsed.data.target_type} ${parsed.data.target_id.slice(0, 8)}`,
        body_markdown: parsed.data.comment.trim(),
        source: "operator_feedback",
        source_ref: noteRef,
        dedup_key: noteRef,
        tags: [`agent:${data.agent_slug}`, "feedback", ratingTag],
      });
    } catch (e: unknown) {
      console.warn(
        `[feedback] writeNote failed for feedback_id=${data.feedback_id}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  res.json({
    ok: true,
    feedback_id: data.feedback_id,
    agent_slug: data.agent_slug,
    carryover,
  });
}

function isMissingBuildReasons(error: { code?: string; message?: string }): boolean {
  const message = error.message ?? "";
  return error.code === "42703" || (/build_reasons/.test(message) && /does not exist|schema cache/i.test(message));
}

const MINE_IDS_MAX = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function feedbackMine(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const type = typeof req.query.target_type === "string" ? req.query.target_type : "";
  const parsedType = Body.shape.target_type.safeParse(type);
  const ids = (typeof req.query.ids === "string" ? req.query.ids.split(",") : []).map((s) => s.trim()).filter(Boolean);
  if (!parsedType.success || ids.length === 0 || ids.length > MINE_IDS_MAX || !ids.every((id) => UUID_RE.test(id))) {
    res.status(400).json({ error: { code: "invalid_query", message: `target_type and 1-${MINE_IDS_MAX} ids are required` } });
    return;
  }
  const supabase = serverClientFromBearer(auth.access_token);
  const read = (cols: string) =>
    supabase
      .from("agent_feedback")
      .select(cols)
      .eq("tenant_id", auth.tenant_id)
      .eq("created_by", auth.user_id)
      .eq("target_type", parsedType.data)
      .in("target_id", [...new Set(ids)]);
  let { data, error } = await read("target_id, rating, comment, build_reasons");
  if (error && isMissingBuildReasons(error)) ({ data, error } = await read("target_id, rating, comment"));
  if (error) {
    res.status(500).json({ error: { code: "feedback_read_failed", message: error.message } });
    return;
  }
  const ratings: Record<string, { rating: -1 | 1 | null; comment: string | null; reasons: string[] }> = {};
  for (const row of (data ?? []) as unknown as Array<{ target_id: string; rating: number | null; comment: string | null; build_reasons: unknown }>) {
    const reasons = BuildReasonsSchema.safeParse(row.build_reasons);
    ratings[row.target_id] = {
      rating: row.rating === 1 || row.rating === -1 ? row.rating : null,
      comment: row.comment ?? null,
      reasons: reasons.success ? reasons.data : [],
    };
  }
  res.json({ ratings });
}
