
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";
import {
  approveRoutineCandidate,
  rejectRoutineCandidate,
} from "@/services/routines/routine-candidates";

const ListQuery = z.object({
  limit: z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "string" ? parseInt(v, 10) : v))
    .pipe(z.number().int().min(1).max(200))
    .optional(),
});

export async function staffRoutineCandidatesList(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);
  const parsed = ListQuery.safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit ?? 50 : 50;

  const { data, error } = await serviceClient()
    .from("tenant_routines")
    .select(
      "id, tenant_id, agent_slug, routine_name, emitted_tool_name, routine_spec, " +
        "spec_version, granted_tool_names, status, founder_blessed, " +
        "faithfulness_clean, source_note_ids, created_at",
    )
    .in("status", ["candidate", "staged"])
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    res.status(500).json({ error: { code: "read_failed", message: error.message } });
    return;
  }
  res.json({ items: data ?? [] });
}

export async function staffRoutineCandidateApprove(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: { code: "missing_id", message: "candidate id required" } });
    return;
  }

  const result = await approveRoutineCandidate(id, staff.user_id);

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "routine-candidate.approve",
    target_table: "tenant_routines",
    target_id: id,
    meta: { approved: result.approved, reason: result.reason, emitted_tool_name: result.emitted_tool_name ?? null },
  });

  if (!result.approved) {
    res.status(409).json({ error: { code: "not_approved", message: result.reason }, ...result });
    return;
  }
  res.json({ ok: true, ...result });
}

export async function staffRoutineCandidateReject(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: { code: "missing_id", message: "candidate id required" } });
    return;
  }

  const result = await rejectRoutineCandidate(id, staff.user_id);

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "routine-candidate.reject",
    target_table: "tenant_routines",
    target_id: id,
    meta: { rejected: result.rejected, reason: result.reason },
  });

  if (!result.rejected) {
    res.status(409).json({ error: { code: "not_rejected", message: result.reason }, ...result });
    return;
  }
  res.json({ ok: true, ...result });
}
