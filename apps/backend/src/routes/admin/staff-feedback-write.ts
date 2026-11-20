
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeNote } from "@/services/memory";

const Body = z.object({
  target_type: z.enum(["agent_run", "decision"]),
  target_id: z.string().uuid(),
  rating: z.union([z.literal(-1), z.literal(1), z.null()]).optional(),
  comment: z.string().max(2000).nullable().optional(),
});

type RpcRow = {
  feedback_id: string;
  agent_slug: string;
  tenant_id: string;
};

export async function staffFeedbackWrite(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: parsed.error.message },
    });
    return;
  }

  const { data, error } = await serviceClient()
    .rpc("submit_staff_feedback", {
      p_staff_user_id: staff.user_id,
      p_target_type: parsed.data.target_type,
      p_target_id: parsed.data.target_id,
      p_rating: parsed.data.rating ?? null,
      p_comment: parsed.data.comment ?? null,
    })
    .single<RpcRow>();

  if (error || !data) {
    const msg = error?.message ?? "rpc returned no row";
    const lower = msg.toLowerCase();
    if (
      lower.includes("not found") ||
      lower.includes("invalid") ||
      lower.includes("must include") ||
      lower.includes("not derivable") ||
      lower.includes("required")
    ) {
      res.status(400).json({ error: { code: "rpc_rejected", message: msg } });
      return;
    }
    res.status(500).json({ error: { code: "rpc_failed", message: msg } });
    return;
  }

  if (parsed.data.comment && parsed.data.comment.trim().length > 0) {
    const ratingTag =
      parsed.data.rating === 1
        ? "rating:+1"
        : parsed.data.rating === -1
          ? "rating:-1"
          : "rating:none";
    try {
      await writeNote(data.tenant_id, {
        title: `Staff feedback on ${parsed.data.target_type} ${parsed.data.target_id.slice(0, 8)}`,
        body_markdown: parsed.data.comment.trim(),
        source: "praxis_staff",
        source_ref: `${parsed.data.target_type}:${parsed.data.target_id}:${data.feedback_id}`,
        tags: [
          `agent:${data.agent_slug}`,
          "staff_feedback",
          ratingTag,
          `staff:${staff.email}`,
        ],
      });
    } catch (e: unknown) {
      console.warn(
        `[staff-feedback] writeNote failed for feedback_id=${data.feedback_id}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  res.json({
    ok: true,
    feedback_id: data.feedback_id,
    agent_slug: data.agent_slug,
    tenant_id: data.tenant_id,
  });
}
