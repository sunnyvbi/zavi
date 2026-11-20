
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serviceClient } from "@/services/supabase";
import { decideOnDecision } from "@/services/approvals/decide-service";

const DRAFT_CLASS = "dispute-response.submit-evidence";
const FINAL_CLASS = "dispute-response.final-submit-evidence";

const DecisionIdParam = z.object({ decision_id: z.string().uuid() });

export async function approvalsFinalizeEvidence(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const parsed = DecisionIdParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_decision_id", message: "decision_id must be a UUID" },
    });
    return;
  }
  const draftDecisionId = parsed.data.decision_id;
  const svc = serviceClient();

  const { data: draftRow } = await svc
    .from("decisions")
    .select("id, tenant_id, status, decision_class, agent_run_id, body")
    .eq("id", draftDecisionId)
    .maybeSingle();

  const draft = draftRow as
    | {
        tenant_id: string;
        status: string;
        decision_class: string | null;
        agent_run_id: string | null;
        body: Record<string, unknown> | null;
      }
    | null;

  if (!draft || draft.tenant_id !== auth.tenant_id) {
    res.status(404).json({ error: { code: "decision_not_found", message: "decision not found" } });
    return;
  }
  if (draft.decision_class !== DRAFT_CLASS) {
    res.status(400).json({
      error: { code: "not_a_draft", message: "decision is not a dispute-response evidence draft" },
    });
    return;
  }
  if (draft.status !== "acted") {
    res.status(409).json({
      error: {
        code: "draft_not_saved",
        message: "approve and save the evidence draft before submitting it for review",
      },
    });
    return;
  }

  const evidencePacket = (draft.body ?? {})["evidence_packet"];
  if (!evidencePacket || typeof evidencePacket !== "object") {
    res.status(422).json({
      error: { code: "missing_evidence_packet", message: "draft has no evidence packet to submit" },
    });
    return;
  }

  const { data: existingChild } = await svc
    .from("decisions")
    .select("id, status")
    .eq("tenant_id", auth.tenant_id)
    .eq("decision_class", FINAL_CLASS)
    .eq("body->>source_draft_decision_id", draftDecisionId)
    .maybeSingle();

  if (existingChild) {
    const child = existingChild as { id: string; status: string };
    res.json({ ok: true, decision_id: child.id, status: child.status, already: true });
    return;
  }

  const { data: childId, error: emitErr } = await svc.rpc("emit_decision", {
    p_tenant_id: auth.tenant_id,
    p_agent_run_id: draft.agent_run_id,
    p_decision_class: FINAL_CLASS,
    p_body: {
      evidence_packet: evidencePacket,
      submit_final: true,
      source_draft_decision_id: draftDecisionId,
    },
  });

  if (emitErr || typeof childId !== "string") {
    res.status(500).json({
      error: { code: "emit_failed", message: emitErr?.message ?? "could not stage the final submit" },
    });
    return;
  }

  const result = await decideOnDecision({
    decision_id: childId,
    tenant_id: auth.tenant_id,
    action: "approve",
    actor: { user_id: auth.user_id },
  });

  if (!result.ok) {
    if (result.code === "not_authorized") {
      res.status(403).json({
        error: { code: "not_authorized", message: "submitting evidence requires an owner or admin role" },
      });
      return;
    }
    res.status(500).json({
      error: { code: "finalize_failed", message: "could not submit the evidence for review" },
    });
    return;
  }

  res.json({ ok: true, decision_id: childId, status: result.status });
}
