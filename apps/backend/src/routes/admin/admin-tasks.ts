
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { upsertAnchor } from "@/services/memory/upsert-anchor";
import type { MemoryDocSlug } from "@/services/memory/loader";

const ANCHOR_SLUGS = ["company", "ops", "policies", "disputes", "support"] as const;

const ListQuery = z.object({
  state: z.enum(["open", "claimed", "in_progress", "snoozed", "resolved", "dismissed"]).optional(),
  kind: z.enum(["enrichment", "unblock", "coach"]).optional(),
  limit: z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "string" ? parseInt(v, 10) : v))
    .pipe(z.number().int().min(1).max(200))
    .optional(),
});

export async function staffAdminTasksList(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const parsed = ListQuery.safeParse(req.query);
  const q = parsed.success ? parsed.data : {};
  let query = serviceClient()
    .from("admin_tasks")
    .select(
      "id, kind, tenant_id, source_decision_id, source_run_id, block_reason, agent_slug, detector, state, assignee_staff_email, snooze_until, priority, resolution, created_at, claimed_at, started_at, completed_at, resolved_at",
    )
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(q.limit ?? 50);
  if (q.state) query = query.eq("state", q.state);
  else query = query.in("state", ["open", "claimed", "in_progress", "snoozed"]);
  if (q.kind) query = query.eq("kind", q.kind);
  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: { code: "list_failed", message: error.message } });
    return;
  }
  res.json({ tasks: data ?? [] });
}

async function audit(
  staffEmail: string,
  tenantId: string,
  taskId: string | null,
  action: string,
  opts: { target?: string; before?: unknown; after?: unknown; onBehalf?: boolean } = {},
): Promise<void> {
  const { error } = await serviceClient().rpc("admin_action_log_append", {
    p_staff_email: staffEmail,
    p_tenant_id: tenantId,
    p_task_id: taskId,
    p_action: action,
    p_target: opts.target ?? null,
    p_before: opts.before ?? null,
    p_after: opts.after ?? null,
    p_on_behalf: opts.onBehalf ?? false,
  });
  if (error) console.warn(`[admin-tasks audit] ${action} failed: ${error.message}`);
}

async function taskTenant(taskId: string): Promise<string | null> {
  const { data } = await serviceClient()
    .from("admin_tasks")
    .select("tenant_id")
    .eq("id", taskId)
    .maybeSingle();
  return (data?.tenant_id as string | undefined) ?? null;
}

export async function staffAdminTaskClaim(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const taskId = req.params.id;
  const tenantId = await taskTenant(taskId);
  if (!tenantId) {
    res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    return;
  }
  const { data, error } = await serviceClient().rpc("admin_task_claim", {
    p_task_id: taskId,
    p_staff_email: staff.email,
  });
  if (error) {
    res.status(500).json({ error: { code: "claim_failed", message: error.message } });
    return;
  }
  if (!data) {
    res.status(409).json({ error: { code: "already_claimed", message: "task already claimed" } });
    return;
  }
  await audit(staff.email, tenantId, taskId, "claim");
  res.json({ ok: true, task_id: data });
}

const SnoozeBody = z.object({ until: z.string().datetime() });

export async function staffAdminTaskSnooze(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const taskId = req.params.id;
  const parsed = SnoozeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_request", message: "until (ISO datetime) required" } });
    return;
  }
  const tenantId = await taskTenant(taskId);
  if (!tenantId) {
    res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    return;
  }
  const { data, error } = await serviceClient().rpc("admin_task_snooze", {
    p_task_id: taskId,
    p_until: parsed.data.until,
  });
  if (error) {
    res.status(500).json({ error: { code: "snooze_failed", message: error.message } });
    return;
  }
  if (!data) {
    res.status(409).json({ error: { code: "bad_state", message: "task not in a snoozable state" } });
    return;
  }
  await audit(staff.email, tenantId, taskId, "snooze", { after: { until: parsed.data.until } });
  res.json({ ok: true, task_id: data });
}

const ResolveBody = z.object({ resolution: z.record(z.string(), z.unknown()).optional() });

export async function staffAdminTaskResolve(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const taskId = req.params.id;
  const parsed = ResolveBody.safeParse(req.body ?? {});
  const resolution = parsed.success ? parsed.data.resolution ?? {} : {};
  const tenantId = await taskTenant(taskId);
  if (!tenantId) {
    res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    return;
  }
  const { data, error } = await serviceClient().rpc("admin_task_resolve", {
    p_task_id: taskId,
    p_resolution: resolution,
  });
  if (error) {
    res.status(500).json({ error: { code: "resolve_failed", message: error.message } });
    return;
  }
  if (!data) {
    res.status(409).json({ error: { code: "bad_state", message: "task already terminal" } });
    return;
  }
  await audit(staff.email, tenantId, taskId, "resolve", { after: resolution });
  res.json({ ok: true, task_id: data });
}

export async function staffAdminTaskDismiss(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const taskId = req.params.id;
  const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
  const tenantId = await taskTenant(taskId);
  if (!tenantId) {
    res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    return;
  }
  const { data, error } = await serviceClient().rpc("admin_task_dismiss", {
    p_task_id: taskId,
    p_reason: reason,
  });
  if (error) {
    res.status(500).json({ error: { code: "dismiss_failed", message: error.message } });
    return;
  }
  if (!data) {
    res.status(409).json({ error: { code: "bad_state", message: "task already terminal" } });
    return;
  }
  await audit(staff.email, tenantId, taskId, "dismiss", { after: { reason } });
  res.json({ ok: true, task_id: data });
}

const EnrichBody = z.object({
  slug: z.enum(ANCHOR_SLUGS),
  body_markdown: z.string().min(1).max(20000),
});

export async function staffAdminTaskEnrichMemory(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const taskId = req.params.id;
  const parsed = EnrichBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_request", message: "slug + body_markdown required" } });
    return;
  }
  const tenantId = await taskTenant(taskId);
  if (!tenantId) {
    res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    return;
  }
  const slug = parsed.data.slug as MemoryDocSlug;

  const { data: before } = await serviceClient()
    .from("memory_note")
    .select("body_markdown")
    .eq("tenant_id", tenantId)
    .eq("slug", slug)
    .is("superseded_by", null)
    .maybeSingle();

  if (slug === "company") {
    const { writeCompanyProse } = await import("@/services/company/brief");
    const { COMPANY_STORY_MAX } = await import("@/services/company/facts");
    if (parsed.data.body_markdown.length > COMPANY_STORY_MAX) {
      res.status(422).json({
        error: {
          code: "company_story_too_long",
          message: `The company brief is stored as a company fact, capped at ${COMPANY_STORY_MAX} characters. This edit is ${parsed.data.body_markdown.length}. Trim it and save again.`,
        },
      });
      return;
    }
    const stored = await writeCompanyProse(
      tenantId,
      parsed.data.body_markdown,
      "staff",
      `staff admin console (${staff.email})`,
    );
    if (!stored.stored && stored.reason === "error") {
      res.status(500).json({
        error: {
          code: "company_story_write_failed",
          message: `The company description could not be saved: ${stored.error}`,
        },
      });
      return;
    }
    if (!stored.stored && stored.reason === "empty") {
      res.status(422).json({
        error: {
          code: "empty_company_story",
          message: "The company description was blank. Write the description, or clear the task instead.",
        },
      });
      return;
    }
    if (!stored.stored) {
      res.status(409).json({
        error: {
          code: "outranked_by_customer",
          message:
            "Not saved: the customer has stated their own company description, which outranks a staff edit. " +
            "If it is wrong, the customer changes it by telling an agent in chat and confirming the reworded " +
            "version; individual facts stay editable on their Company Details card.",
        },
      });
      return;
    }
  } else {
    await upsertAnchor({
      tenant_id: tenantId,
      slug,
      body_markdown: parsed.data.body_markdown,
      source: "agent_write",
    });
  }

  if (slug !== "company") {
    await serviceClient()
      .from("memory_note")
      .update({ last_edited_by_staff_at: new Date().toISOString(), last_edited_by_staff_email: staff.email })
      .eq("tenant_id", tenantId)
      .eq("slug", slug)
      .is("superseded_by", null);
  }

  await audit(staff.email, tenantId, taskId, "enrich_memory", {
    target: slug,
    before: { body_markdown: (before?.body_markdown as string | undefined) ?? null },
    after: { body_markdown: parsed.data.body_markdown },
    onBehalf: true,
  });

  res.json({ ok: true, slug });
}
