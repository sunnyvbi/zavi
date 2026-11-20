
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";
import { decideOnDecision } from "@/services/approvals/decide-service";
import { readApprovalClass } from "@/agents/engineer/approval-class";
import { isComposioDecisionClass } from "@/services/connectors/composio/write-classify";
import { TIKTOK_CHAT_EDIT_CLASSES } from "@/services/connectors/tiktok-ads/held-schema";
import {
  isStaffOrInternalTenant,
  idempotencyClaim,
  idempotencyResolve,
  idempotencyRelease,
  rateLimitExceeded,
} from "./staff-console-shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function staffDecisionExecute(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenant_id = req.params.tenant_id;
  const decision_id = req.params.decision_id;

  if (!UUID_RE.test(decision_id ?? "")) {
    res.status(400).json({ error: { code: "invalid_decision_id", message: "decision_id must be a uuid" } });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const override_red = body.override_red === true;

  if (rateLimitExceeded(staff.user_id, tenant_id)) {
    res.status(429).json({ error: { code: "rate_limited", message: "Too many override actions; slow down." } });
    return;
  }

  const sb = serviceClient();

  const { data: dec, error: decErr } = await sb
    .from("decisions")
    .select("id, tenant_id, status, decision_class, body")
    .eq("id", decision_id)
    .maybeSingle<{
      tenant_id: string;
      status: string;
      decision_class: string | null;
      body: Record<string, unknown> | null;
    }>();
  if (decErr) {
    res.status(500).json({ error: { code: "decision_query_failed", message: decErr.message } });
    return;
  }
  if (!dec) {
    res.status(404).json({ error: { code: "decision_not_found", message: decision_id } });
    return;
  }
  if (dec.tenant_id !== tenant_id) {
    res.status(403).json({ error: { code: "tenant_mismatch", message: "decision does not belong to this tenant" } });
    return;
  }

  if (isComposioDecisionClass(dec.decision_class) || TIKTOK_CHAT_EDIT_CLASSES.has(dec.decision_class ?? "")) {
    res.status(403).json({ error: { code: "not_authorized", message: "Only the tenant can approve a connected-app write or a TikTok Ads change." } });
    return;
  }

  if (reason.length === 0) {
    res.status(400).json({ error: { code: "reason_required", message: "a non-blank reason is required to override" } });
    return;
  }
  if (reason.length > 2000) {
    res.status(400).json({ error: { code: "reason_too_long", message: "reason exceeds 2000 chars" } });
    return;
  }

  if (dec.status !== "proposed") {
    res.status(409).json({ error: { code: "not_proposed", message: `decision is ${dec.status}` } });
    return;
  }

  if (await isStaffOrInternalTenant(tenant_id)) {
    res.status(403).json({
      error: { code: "tenant_not_operable", message: "The staff console v1 operates on customer tenants only." },
    });
    return;
  }

  const isRed = readApprovalClass(dec.body) === "ship_red";
  if (isRed && !override_red) {
    res.status(409).json({
      error: {
        code: "red_override_required",
        message: "This action is flagged RED (provably broken). Re-submit with override_red:true to execute it anyway.",
      },
    });
    return;
  }

  const clientKey =
    typeof req.headers["idempotency-key"] === "string"
      ? (req.headers["idempotency-key"] as string).slice(0, 200)
      : null;
  const idempKey = clientKey ? `execute:${staff.user_id}:${tenant_id}:${decision_id}:${clientKey}` : null;
  if (idempKey) {
    const claim = idempotencyClaim(idempKey);
    if (!claim.fresh) {
      if (claim.entry.pending) {
        res.status(409).json({ error: { code: "in_progress", message: "An identical override is still being processed." } });
        return;
      }
      res.status(200).json(claim.entry.result);
      return;
    }
  }

  try {
    const { error: wormErr } = await sb.rpc("admin_action_log_append", {
      p_staff_email: staff.email,
      p_tenant_id: tenant_id,
      p_task_id: null,
      p_action: "approve_on_behalf",
      p_target: decision_id,
      p_before: null,
      p_after: {
        action: "execute",
        reason,
        decision_class: dec.decision_class,
        override_red: isRed ? override_red : false,
      },
      p_on_behalf: true,
    });
    if (wormErr) throw new Error(wormErr.message);
  } catch (e) {
    if (idempKey) idempotencyRelease(idempKey);
    res.status(500).json({
      error: {
        code: "audit_write_failed",
        message: `WORM audit failed; nothing was executed: ${(e as Error).message}`,
      },
      executed: false,
    });
    return;
  }

  const result = await decideOnDecision({
    decision_id,
    tenant_id,
    action: "approve",
    actor: { user_id: staff.user_id },
    staff_override: true,
    ship_anyway: isRed ? override_red : undefined,
  });

  if (!result.ok) {
    if (idempKey) idempotencyRelease(idempKey);
    const http =
      result.code === "not_member" || result.code === "cross_tenant" || result.code === "not_authorized"
        ? 403
        : result.code === "not_found"
          ? 404
          : 409;
    res.status(http).json({ error: { code: result.code, message: `override rejected: ${result.code}` } });
    return;
  }

  if (!result.changed) {
    try {
      const { error: corrErr } = await sb.rpc("admin_action_log_append", {
        p_staff_email: staff.email,
        p_tenant_id: tenant_id,
        p_task_id: null,
        p_action: "approve_on_behalf",
        p_target: decision_id,
        p_before: null,
        p_after: {
          action: "execute_noop_correction",
          reason: "CAS lost — the decision was already decided by another actor; nothing was executed.",
          observed_status: result.status,
        },
        p_on_behalf: true,
      });
      if (corrErr) throw new Error(corrErr.message);
    } catch (e) {
      console.warn(`[staff-console] WORM correction failed for ${decision_id}: ${(e as Error).message}`);
    }
    if (idempKey) idempotencyRelease(idempKey);
    res.status(409).json({
      error: {
        code: "already_decided",
        message: `Nothing was executed. The decision was already ${result.status} when the override landed.`,
      },
      executed: false,
      status: result.status,
    });
    return;
  }

  const payload = { ok: true, status: result.status, changed: result.changed, decision_id };
  if (idempKey) idempotencyResolve(idempKey, payload);

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "decision.execute_override",
    target_table: "decisions",
    target_id: decision_id,
    tenant_id,
    meta: {
      decision_class: dec.decision_class,
      red: isRed,
      override_red: isRed ? override_red : false,
      status: result.status,
      changed: result.changed,
    },
  });

  res.status(200).json(payload);
}
