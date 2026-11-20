
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";
import { decideOnDecision } from "@/services/approvals/decide-service";
import { captureAdminCorrection } from "@/services/staff/capture-admin-correction";
import { isComposioDecisionClass } from "@/services/connectors/composio/write-classify";
import { TIKTOK_CHAT_EDIT_CLASSES } from "@/services/connectors/tiktok-ads/held-schema";

const Body = z.object({
  action: z.enum(["approve", "reject"]),
  edited_body: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().max(2000).optional(),
});

export async function staffDecisionDecide(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const decisionId = req.params.decision_id;
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const { action, edited_body, reason } = parsed.data;

  const sb = serviceClient();
  const { data: dec, error } = await sb
    .from("decisions")
    .select("id, tenant_id, status, decision_class, body")
    .eq("id", decisionId)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: { code: "decision_query_failed", message: error.message } });
    return;
  }
  if (!dec) {
    res.status(404).json({ error: { code: "decision_not_found", message: decisionId } });
    return;
  }
  const d = dec as { tenant_id: string; status: string; decision_class: string; body: Record<string, unknown> | null };
  if (d.status !== "proposed") {
    res.status(409).json({ error: { code: "not_proposed", message: `decision is ${d.status}` } });
    return;
  }

  if (isComposioDecisionClass(d.decision_class) || TIKTOK_CHAT_EDIT_CLASSES.has(d.decision_class)) {
    if (edited_body) {
      res.status(400).json({ error: { code: "edit_not_allowed", message: "Composio writes and TikTok Ads changes cannot be edited." } });
      return;
    }
    if (action === "approve") {
      res.status(403).json({ error: { code: "not_authorized", message: "Only the tenant can approve a connected-app write or a TikTok Ads change." } });
      return;
    }
  }

  if (action === "approve" && edited_body) {
    const { data: editRes, error: editErr } = await sb.rpc("edit_decision_body_as_staff", {
      p_decision_id: decisionId,
      p_tenant_id: d.tenant_id,
      p_actor_user_id: staff.user_id,
      p_body: edited_body,
    });
    if (editErr) {
      res.status(500).json({ error: { code: "edit_rpc_failed", message: editErr.message } });
      return;
    }
    const er = (editRes ?? {}) as { ok?: boolean; reason?: string };
    if (!er.ok) {
      const code = er.reason ?? "edit_failed";
      const http = code === "not_member" || code === "cross_tenant" ? 403 : code === "not_found" ? 404 : 409;
      res.status(http).json({ error: { code, message: `edit rejected: ${code}` } });
      return;
    }
  }

  const result = await decideOnDecision({
    decision_id: decisionId,
    tenant_id: d.tenant_id,
    action,
    actor: { user_id: staff.user_id },
    staff_override: true,
  });

  if (!result.ok) {
    const http =
      result.code === "not_member" || result.code === "cross_tenant"
        ? 403
        : result.code === "not_found"
          ? 404
          : 409;
    res.status(http).json({ error: { code: result.code, message: `decide rejected: ${result.code}` } });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: `decision.${action}${edited_body ? "_with_edit" : ""}`,
    target_table: "decisions",
    target_id: decisionId,
    meta: {
      tenant_id: d.tenant_id,
      decision_class: d.decision_class,
      edited: !!edited_body,
      ...(edited_body ? { body_before: d.body, body_after: edited_body } : {}),
      status: result.status,
    },
  });

  if (result.changed) {
    const isCorrection = (action === "approve" && !!edited_body) || action === "reject";
    if (isCorrection) {
      try {
        await captureAdminCorrection({
          tenant_id: d.tenant_id,
          decision_id: decisionId,
          decision_class: d.decision_class,
          actor: { user_id: staff.user_id, email: staff.email },
          action: action === "reject" ? "reject" : "edit",
          before_body: d.body,
          after_body: edited_body ?? null,
          reason: action === "reject" ? reason ?? "(no reason given)" : null,
        });
      } catch (e) {
        console.warn(
          `[decision-decide] captureAdminCorrection failed for ${decisionId}: ${(e as Error)?.message ?? e}`,
        );
      }
    }
  }

  res.json({ ok: true, status: result.status, edited: !!edited_body });
}
