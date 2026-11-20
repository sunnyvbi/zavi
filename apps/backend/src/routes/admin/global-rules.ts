
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { inngest } from "@/../workers/client";
import { writeStaffAudit } from "@/services/staff/audit";
import { generalizeRuleBody } from "@/services/staff/generalize-rule-body";

const ProposeBody = z.object({
  source_decision_id: z.string().uuid(),
  target_agent_slug: z.string().min(1).max(64),
  body_markdown: z.string().min(10).max(1500),
});

const ApproveBody = z.object({
  target_tenant_ids: z.array(z.string().uuid()).min(1).max(200),
});

const ListQuery = z.object({
  status: z.enum(["pending", "approved", "rejected", "superseded"]).optional(),
});

function approverAllowlist(): Set<string> {
  const raw = process.env.PRAXIS_GLOBAL_RULE_APPROVERS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

export async function staffGlobalRulesList(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);

  const parsed = ListQuery.safeParse(req.query);
  const status = parsed.success ? parsed.data.status ?? "pending" : "pending";

  const { data, error } = await serviceClient()
    .from("global_agent_rules")
    .select(
      "id, agent_slug, body_markdown, source_feedback_id, source_decision_id, status, proposed_by, approved_by, proposed_at, approved_at, applied_to_tenants",
    )
    .eq("status", status)
    .order("proposed_at", { ascending: false })
    .limit(100);
  if (error) {
    res.status(500).json({ error: { code: "read_failed", message: error.message } });
    return;
  }

  res.json({ items: data ?? [] });
}

export async function staffGlobalRulesPropose(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);

  let body: z.infer<typeof ProposeBody>;
  try {
    body = ProposeBody.parse(req.body ?? {});
  } catch (e) {
    res
      .status(400)
      .json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const svc = serviceClient();

  const { data: srcDecision, error: srcErr } = await svc
    .from("decisions")
    .select("id, tenant_id, decision_class")
    .eq("id", body.source_decision_id)
    .maybeSingle();
  if (srcErr) {
    res.status(500).json({ error: { code: "source_lookup_failed", message: srcErr.message } });
    return;
  }
  if (!srcDecision) {
    res.status(404).json({ error: { code: "source_not_found", message: body.source_decision_id } });
    return;
  }
  const src = srcDecision as { id: string; tenant_id: string; decision_class: string };

  let sourceSignature: string;
  try {
    const { data: sig, error: sigErr } = await svc
      .rpc("lookup_correction_signature", { p_decision_id: src.id })
      .single<string | null>();
    if (sigErr) throw new Error(sigErr.message);
    if (!sig) {
      res.status(409).json({
        error: {
          code: "no_source_signature",
          message:
            "source decision has no admin-correction ledger entry; cannot establish a recurrence signature for fleet promotion",
        },
      });
      return;
    }
    sourceSignature = sig;

    const { data: tenantCount, error: cntErr } = await svc
      .rpc("count_admin_correction_tenants", { p_signature: sourceSignature })
      .single<number>();
    if (cntErr) throw new Error(cntErr.message);
    if (Number(tenantCount ?? 0) < 2) {
      res.status(409).json({
        error: {
          code: "not_cross_tenant",
          message:
            "this exact correction has not recurred across >= 2 tenants; fleet promotion is gated on cross-tenant recurrence of the SAME signature",
        },
      });
      return;
    }
  } catch (e) {
    res.status(500).json({ error: { code: "recurrence_check_failed", message: (e as Error).message } });
    return;
  }

  const { data: srcTenant, error: tErr } = await svc
    .from("tenants")
    .select("id, name, slug")
    .eq("id", src.tenant_id)
    .maybeSingle();
  if (tErr) {
    res.status(500).json({ error: { code: "tenant_lookup_failed", message: tErr.message } });
    return;
  }
  const t = (srcTenant ?? { id: src.tenant_id }) as { id: string; name?: string | null; slug?: string | null };

  const SOURCE_REF_ROW_CAP = 2000;
  let sourceRefs: string[] = [];
  try {
    const { data: keyRows, error: keyErr } = await svc
      .from("memory_note")
      .select("connector_object_keys")
      .eq("tenant_id", src.tenant_id)
      .not("connector_object_keys", "is", null)
      .limit(SOURCE_REF_ROW_CAP + 1);
    if (keyErr) throw new Error(keyErr.message);
    const rows = (keyRows ?? []) as Array<{ connector_object_keys: string[] | null }>;
    if (rows.length > SOURCE_REF_ROW_CAP) {
      res.status(500).json({
        error: {
          code: "source_refs_incomplete",
          message:
            `source tenant has more than ${SOURCE_REF_ROW_CAP} connector-key rows; ` +
            `cannot prove the ref set is complete, so fleet promotion is blocked (failing closed). ` +
            `Generalize the rule body manually or narrow the source.`,
        },
      });
      return;
    }
    const set = new Set<string>();
    for (const row of rows) {
      for (const k of row.connector_object_keys ?? []) {
        if (typeof k === "string" && k.trim().length >= 3) set.add(k.trim());
      }
    }
    sourceRefs = Array.from(set);
  } catch (e) {
    res.status(500).json({
      error: {
        code: "source_refs_enumeration_failed",
        message: `could not enumerate source-tenant connector refs for the scrub (failing closed): ${(e as Error).message}`,
      },
    });
    return;
  }

  const scrub = generalizeRuleBody(body.body_markdown, {
    tenant_id: t.id,
    name: t.name,
    slug: t.slug,
    source_refs: sourceRefs,
  });
  if (!scrub.ok) {
    res.status(422).json({
      error: {
        code: "tenant_data_in_rule_body",
        message: `rule body still contains source-tenant identifiers after generalization: ${scrub.surviving.join(", ")}. Generalize the rule before promoting.`,
      },
    });
    return;
  }

  const { data, error } = await svc
    .rpc("propose_global_rule", {
      p_source_decision_id: body.source_decision_id,
      p_staff_user_id: staff.user_id,
      p_target_agent_slug: body.target_agent_slug,
      p_body_markdown: scrub.generalized,
    })
    .single<string>();

  if (error || !data) {
    res.status(500).json({
      error: { code: "rpc_failed", message: error?.message ?? "no id returned" },
    });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "global-rules.propose",
    target_table: "global_agent_rules",
    target_id: data,
    meta: {
      target_agent_slug: body.target_agent_slug,
      source_rule_body: body.body_markdown,
      generalized_rule_body: scrub.generalized,
      source_tenant_id: src.tenant_id,
    },
  });

  res.json({ ok: true, global_rule_id: data });
}

export async function staffGlobalRulesApprove(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);

  const allowlist = approverAllowlist();
  if (!allowlist.has(staff.email.toLowerCase())) {
    res.status(403).json({
      error: {
        code: "not_approver",
        message: `${staff.email} is not in PRAXIS_GLOBAL_RULE_APPROVERS`,
      },
    });
    return;
  }

  const ruleId = req.params.id;
  if (!ruleId) {
    res.status(400).json({ error: { code: "missing_id", message: "rule id required" } });
    return;
  }

  let body: z.infer<typeof ApproveBody>;
  try {
    body = ApproveBody.parse(req.body ?? {});
  } catch (e) {
    res
      .status(400)
      .json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const svc = serviceClient();
  const { data: decisionIds, error } = await svc
    .rpc("approve_global_rule", {
      p_global_rule_id: ruleId,
      p_approver_user_id: staff.user_id,
      p_target_tenant_ids: body.target_tenant_ids,
    })
    .single<string[]>();

  if (error || !decisionIds) {
    res.status(500).json({
      error: {
        code: "rpc_failed",
        message: error?.message ?? "no decision_ids returned",
      },
    });
    return;
  }

  const { data: decisionRows } = await svc
    .from("decisions")
    .select("id, tenant_id, decision_class")
    .in("id", decisionIds);
  const decisionMeta = new Map<
    string,
    { tenant_id: string; decision_class: string }
  >();
  for (const row of (decisionRows as Array<{
    id: string;
    tenant_id: string;
    decision_class: string;
  }> | null) ?? []) {
    decisionMeta.set(row.id, {
      tenant_id: row.tenant_id,
      decision_class: row.decision_class,
    });
  }

  for (const decisionId of decisionIds) {
    const meta = decisionMeta.get(decisionId);
    if (!meta) {
      console.warn(
        `[global-rules approve] could not resolve tenant for decision ${decisionId}; skipping inngest send`,
      );
      continue;
    }
    try {
      await inngest.send({
        name: "decision.approved",
        data: {
          decision_id: decisionId,
          tenant_id: meta.tenant_id,
          decision_class: meta.decision_class,
        },
      });
    } catch (e) {
      console.warn(
        `[global-rules approve] inngest.send failed for decision ${decisionId}: ${(e as Error).message}`,
      );
    }
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "global-rules.approve",
    target_table: "global_agent_rules",
    target_id: ruleId,
    meta: {
      target_tenant_count: body.target_tenant_ids.length,
      decision_ids: decisionIds,
    },
  });

  res.json({
    ok: true,
    global_rule_id: ruleId,
    decision_ids: decisionIds,
  });
}
