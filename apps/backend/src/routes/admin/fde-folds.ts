
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { writeStaffAudit } from "@/services/staff/audit";
import { staffCrossTenantClient } from "@/services/tenant-client";

interface FoldCandidateRow {
  id: string;
  pattern_summary: string;
  target_agent_slug: string | null;
  gap_dimension: string | null;
  source_event_ids: string[];
  source_tenant_count: number;
  conflict_of_interest: boolean;
  conflict_detail: string | null;
  eval_status: string;
  status: string;
  created_at: string;
}

export async function staffFdeFolds(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  try {
    const { data, error } = await staffCrossTenantClient(
      "P3 review queue: read proposed fleet lessons derived from FDE rescues",
    )
      .from("fde_fold_candidate")
      .select("*")
      .eq("status", "proposed")
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    res.json({
      candidates: (data ?? []) as FoldCandidateRow[],
      note: "No prompt-eval holdout harness exists yet, so every candidate is eval_status='unmeasured'. That is precisely why approval is human. Approving records the lesson; it does not edit any agent prompt.",
    });
  } catch (e) {
    res.status(500).json({ error: { code: "fde_folds_failed", message: (e as Error).message } });
  }
}

export async function staffFdeFoldDecide(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const id = req.params.id;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const decision = String(body.decision ?? "");
  if (decision !== "approve" && decision !== "reject") {
    res.status(400).json({
      error: { code: "invalid_decision", message: "decision must be 'approve' or 'reject'" },
    });
    return;
  }

  const note = typeof body.note === "string" ? body.note.trim() : null;
  const svc = staffCrossTenantClient("P3 review queue: decide one proposed fleet lesson");

  try {
    const { data: row, error: rErr } = await svc
      .from("fde_fold_candidate")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (rErr) throw new Error(rErr.message);
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "candidate not found" } });
      return;
    }

    const candidate = row as FoldCandidateRow;
    if (candidate.status !== "proposed") {
      res.status(409).json({
        error: {
          code: "already_decided",
          message: `candidate is already '${candidate.status}'`,
        },
      });
      return;
    }

    if (decision === "approve" && candidate.conflict_of_interest && !note) {
      res.status(400).json({
        error: {
          code: "conflict_requires_note",
          message:
            "This lesson was derived from tenants that may be direct competitors. Approving it requires an explicit note explaining why that is acceptable.",
        },
        conflict_detail: candidate.conflict_detail,
      });
      return;
    }

    const status = decision === "approve" ? "approved" : "rejected";

    const { error: uErr } = await svc
      .from("fde_fold_candidate")
      .update({
        status,
        decided_by: staff.user_id,
        decided_at: new Date().toISOString(),
        decision_note: note,
      })
      .eq("id", id)
      .eq("status", "proposed");
    if (uErr) throw new Error(uErr.message);

    let folded = 0;
    if (decision === "approve" && candidate.source_event_ids?.length) {
      const { error: fErr } = await svc
        .from("fde_training_events")
        .update({ folded_into_prompt: true })
        .in("id", candidate.source_event_ids)
        .eq("folded_into_prompt", false);
      if (fErr) throw new Error(`fold-mark failed: ${fErr.message}`);
      folded = candidate.source_event_ids.length;
    }

    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: `fde_fold.${decision}`,
      target_table: "fde_fold_candidate",
      target_id: id,
      meta: {
        gap_dimension: candidate.gap_dimension,
        target_agent_slug: candidate.target_agent_slug,
        source_tenant_count: candidate.source_tenant_count,
        conflict_of_interest: candidate.conflict_of_interest,
        events_folded: folded,
      },
    });

    res.json({
      id,
      status,
      events_folded: folded,
      next_step:
        decision === "approve"
          ? "Recorded. This did NOT change any agent prompt. Apply it via the bake route (POST /api/admin/tenants/:tenant_id/agents/:slug/bake) if you want it in an agent body."
          : "Rejected. The source rescues stay in the backlog. The need they represent has not gone away.",
    });
  } catch (e) {
    res.status(500).json({ error: { code: "fde_fold_decide_failed", message: (e as Error).message } });
  }
}
