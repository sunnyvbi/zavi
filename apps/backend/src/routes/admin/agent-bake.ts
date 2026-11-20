
import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { loadGlobalAgentDefinition } from "@/services/agents/registry";
import { getTenantDisabledSlugs } from "@/services/agents/visibility";
import { inngest } from "@/../workers/client";
import { writeStaffAudit } from "@/services/staff/audit";

const BAKE_DECISION_CLASS = "proposed_rule";
const BAKE_HANDLER = "praxis.bake_rule";
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

const Body = z.object({
  rule_body_markdown: z.string().min(5).max(1500),
  source_feedback_id: z.string().uuid().optional(),
  override_disabled: z.boolean().optional(),
});

function contentHash(tenantId: string, slug: string, body: string): string {
  return createHash("sha256")
    .update(`${tenantId}\n${slug}\n${body.trim()}`)
    .digest("hex")
    .slice(0, 32);
}

export async function staffTenantAgentBake(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenantId = req.params.tenant_id;
  const slug = req.params.slug;
  const svc = serviceClient();

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const ruleBody = parsed.data.rule_body_markdown.trim();
  const sourceFeedbackId = parsed.data.source_feedback_id ?? null;

  if (!loadGlobalAgentDefinition(slug)) {
    res.status(404).json({ error: { code: "agent_not_found", message: slug } });
    return;
  }

  const { data: tenant, error: tErr } = await svc
    .from("tenants")
    .select("id")
    .eq("id", tenantId)
    .maybeSingle();
  if (tErr) {
    res.status(500).json({ error: { code: "tenant_lookup_failed", message: tErr.message } });
    return;
  }
  if (!tenant) {
    res.status(404).json({ error: { code: "tenant_not_found", message: tenantId } });
    return;
  }

  if (sourceFeedbackId) {
    const { data: fb, error: fbErr } = await svc
      .from("agent_feedback")
      .select("id")
      .eq("id", sourceFeedbackId)
      .eq("tenant_id", tenantId)
      .eq("agent_slug", slug)
      .maybeSingle();
    if (fbErr) {
      res.status(500).json({ error: { code: "feedback_lookup_failed", message: fbErr.message } });
      return;
    }
    if (!fb) {
      res.status(404).json({
        error: { code: "source_feedback_not_found", message: "source_feedback_id not found for this tenant" },
      });
      return;
    }
  }

  const { data: dc, error: dcErr } = await svc
    .from("decision_classes")
    .select("slug, dispatch_handler")
    .eq("slug", BAKE_DECISION_CLASS)
    .maybeSingle();
  if (dcErr) {
    res.status(500).json({ error: { code: "decision_class_lookup_failed", message: dcErr.message } });
    return;
  }
  if (!dc || dc.dispatch_handler !== BAKE_HANDLER) {
    res.status(500).json({
      error: {
        code: "bake_misconfigured",
        message: `decision_class '${BAKE_DECISION_CLASS}' must route to '${BAKE_HANDLER}' (got '${dc?.dispatch_handler ?? "none"}')`,
      },
    });
    return;
  }

  if (!parsed.data.override_disabled) {
    try {
      const disabled = await getTenantDisabledSlugs(tenantId);
      if (disabled.has(slug)) {
        res.status(409).json({
          error: {
            code: "agent_disabled",
            message: `${slug} is disabled/kill-switched for this tenant; pass override_disabled:true to bake anyway`,
          },
        });
        return;
      }
    } catch (e) {
      res.status(500).json({ error: { code: "disabled_check_failed", message: (e as Error).message } });
      return;
    }
  }

  const idemKey = sourceFeedbackId ?? contentHash(tenantId, slug, ruleBody);
  const sinceIso = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS).toISOString();
  const { data: existing, error: exErr } = await svc
    .from("decisions")
    .select("id, status, body, source_feedback_id, emitted_at")
    .eq("tenant_id", tenantId)
    .eq("decision_class", BAKE_DECISION_CLASS)
    .eq("handler", BAKE_HANDLER)
    .gte("emitted_at", sinceIso)
    .order("emitted_at", { ascending: false })
    .limit(50);
  if (exErr) {
    res.status(500).json({ error: { code: "idempotency_lookup_failed", message: exErr.message } });
    return;
  }
  const match = ((existing ?? []) as Array<{
    id: string;
    status: string;
    body: Record<string, unknown> | null;
    source_feedback_id: string | null;
    emitted_at: string;
  }>).find((d) => {
    if (d.body?.target_agent_slug !== slug) return false;
    if (d.status === "rejected") return false;
    if (sourceFeedbackId) return d.source_feedback_id === sourceFeedbackId;
    return (d.body?.bake_idem_key as string | undefined) === idemKey;
  });
  if (match) {
    res.status(200).json({ ok: true, decision_id: match.id, idempotent: true });
    return;
  }

  const { data: inserted, error: insErr } = await svc
    .from("decisions")
    .insert({
      tenant_id: tenantId,
      agent_run_id: null,
      decision_class: BAKE_DECISION_CLASS,
      body: {
        rule_body_markdown: ruleBody,
        target_agent_slug: slug,
        origin: "per_tenant_staff_bake",
        bake_idem_key: idemKey,
      },
      status: "approved",
      autonomy_at_emit: "approval",
      handler: BAKE_HANDLER,
      source_feedback_id: sourceFeedbackId,
      approved_by: staff.user_id,
      approved_at: new Date().toISOString(),
    })
    .select("id")
    .single<{ id: string }>();
  if (insErr || !inserted) {
    res.status(500).json({ error: { code: "insert_failed", message: insErr?.message ?? "no id" } });
    return;
  }
  const decisionId = inserted.id;

  try {
    await inngest.send({
      name: "decision.approved",
      data: { decision_id: decisionId, tenant_id: tenantId, decision_class: BAKE_DECISION_CLASS },
    });
  } catch (e) {
    const { error: revertErr } = await svc
      .from("decisions")
      .update({ status: "rejected", dispatch_error: "inngest_send_failed" })
      .eq("id", decisionId)
      .eq("tenant_id", tenantId);
    if (revertErr) {
      res.status(500).json({
        error: {
          code: "dispatch_send_failed_revert_failed",
          message: `inngest.send failed AND the revert failed: decision ${decisionId} is approved-but-undispatched, repair manually: ${revertErr.message}`,
        },
      });
      return;
    }
    res.status(502).json({
      error: { code: "dispatch_send_failed", message: `bake reverted: inngest.send failed: ${(e as Error).message}` },
    });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "agent.bake",
    target_table: "decisions",
    target_id: decisionId,
    tenant_id: tenantId,
    meta: { agent_slug: slug, source_feedback_id: sourceFeedbackId },
  });

  res.json({ ok: true, decision_id: decisionId });
}
