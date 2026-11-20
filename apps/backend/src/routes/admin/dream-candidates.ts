
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";
import {
  approveDreamCandidate,
  rejectDreamCandidate,
} from "@/services/memory/dream-candidates";

const ListQuery = z.object({
  limit: z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "string" ? parseInt(v, 10) : v))
    .pipe(z.number().int().min(1).max(200))
    .optional(),
});

export async function staffDreamCandidatesList(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);
  const parsed = ListQuery.safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit ?? 50 : 50;

  const { data, error } = await serviceClient()
    .from("dream_candidates")
    .select(
      "id, tenant_id, new_note_id, existing_note_id, verdict, rationale, merged_body, eval_delta, eval_status, created_at",
    )
    .eq("label", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    res.status(500).json({ error: { code: "read_failed", message: error.message } });
    return;
  }
  res.json({ items: data ?? [] });
}

export async function staffDreamCandidateApprove(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: { code: "missing_id", message: "candidate id required" } });
    return;
  }

  const result = await approveDreamCandidate(id, staff.user_id);

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "dream-candidate.approve",
    target_table: "dream_candidates",
    target_id: id,
    meta: { applied: result.applied, reason: result.reason },
  });

  if (!result.applied) {
    res.status(409).json({ error: { code: "not_applied", message: result.reason }, ...result });
    return;
  }
  res.json({ ok: true, ...result });
}

export async function staffDreamCandidateReject(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: { code: "missing_id", message: "candidate id required" } });
    return;
  }

  const result = await rejectDreamCandidate(id, staff.user_id);

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "dream-candidate.reject",
    target_table: "dream_candidates",
    target_id: id,
    meta: { rejected: result.rejected, reason: result.reason },
  });

  if (!result.rejected) {
    res.status(409).json({ error: { code: "not_rejected", message: result.reason }, ...result });
    return;
  }
  res.json({ ok: true, ...result });
}
