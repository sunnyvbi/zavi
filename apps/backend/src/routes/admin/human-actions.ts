
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeAutopilotGoal } from "@/services/growth/goal-write";

const TENANT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ITEM_COLUMNS =
  "id, tenant_id, title, detail, priority, source, source_ref, status, snooze_until, created_by, created_at, done_at";

async function audit(
  staffEmail: string,
  tenantId: string,
  action: string,
  opts: { target?: string; before?: unknown; after?: unknown } = {},
): Promise<void> {
  const { error } = await serviceClient().rpc("admin_action_log_append", {
    p_staff_email: staffEmail,
    p_tenant_id: tenantId,
    p_task_id: null,
    p_action: action,
    p_target: opts.target ?? null,
    p_before: opts.before ?? null,
    p_after: opts.after ?? null,
    p_on_behalf: false,
  });
  if (error) console.warn(`[human-actions audit] ${action} failed: ${error.message}`);
}

export async function staffHumanActionsList(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenantId = typeof req.query.tenant_id === "string" ? req.query.tenant_id : "";
  if (!TENANT_UUID_RE.test(tenantId)) {
    res.status(400).json({ error: { code: "invalid_tenant_id", message: "tenant_id must be a UUID" } });
    return;
  }
  const sb = serviceClient();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const goalQ = sb
    .from("autopilot_goals")
    .select(
      "id, objective, target_metric, target_value, baseline_value, current_value, due_date, status, priority, source, created_at, updated_at",
    )
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const itemsQ = sb
    .from("human_action_items")
    .select(ITEM_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("status", ["open", "snoozed"])
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  const doneQ = sb
    .from("human_action_items")
    .select(ITEM_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("status", "done")
    .gte("done_at", dayAgo)
    .order("done_at", { ascending: false })
    .limit(20);
  const decisionsQ = sb
    .from("decisions")
    .select("id, decision_class, body, emitted_at")
    .eq("tenant_id", tenantId)
    .eq("status", "proposed")
    .order("emitted_at", { ascending: false })
    .limit(50);

  const [goal, items, done, decisions] = await Promise.all([goalQ, itemsQ, doneQ, decisionsQ]);
  const firstError = goal.error ?? items.error ?? done.error ?? decisions.error;
  if (firstError) {
    res.status(500).json({ error: { code: "list_failed", message: firstError.message } });
    return;
  }
  res.json({
    goal: goal.data ?? null,
    items: items.data ?? [],
    pending_decisions: decisions.data ?? [],
    done_today: done.data ?? [],
  });
}

const CreateBody = z.object({
  tenant_id: z.string().regex(TENANT_UUID_RE, "tenant_id must be a UUID"),
  title: z.string().min(1).max(500),
  detail: z.string().max(20000).optional().default(""),
  priority: z.enum(["P0", "P1", "P2"]).optional().default("P1"),
  source: z.enum(["curated", "decision", "digest"]).optional().default("curated"),
  source_ref: z.string().max(500).optional(),
});

export async function staffHumanActionsCreate(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = CreateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_request", message: parsed.error.message } });
    return;
  }
  const b = parsed.data;
  const { data, error } = await serviceClient()
    .from("human_action_items")
    .insert({
      tenant_id: b.tenant_id,
      title: b.title,
      detail: b.detail,
      priority: b.priority,
      source: b.source,
      source_ref: b.source_ref ?? null,
      created_by: staff.email,
    })
    .select(ITEM_COLUMNS)
    .single();
  if (error) {
    res.status(500).json({ error: { code: "create_failed", message: error.message } });
    return;
  }
  const item = data as { id: string };
  await audit(staff.email, b.tenant_id, "human_action_create", {
    target: item.id,
    after: { title: b.title, priority: b.priority, source: b.source },
  });
  res.json({ ok: true, item: data });
}

const StatusBody = z.object({
  status: z.enum(["open", "snoozed", "done"]),
  snooze_until: z.string().datetime().optional(),
});

export async function staffHumanActionsStatus(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const itemId = req.params.id;
  const parsed = StatusBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_request", message: parsed.error.message } });
    return;
  }
  const { status, snooze_until } = parsed.data;
  if (status === "snoozed" && !snooze_until) {
    res
      .status(400)
      .json({ error: { code: "bad_request", message: "snooze_until (ISO datetime) required when snoozing" } });
    return;
  }
  const { data, error } = await serviceClient()
    .from("human_action_items")
    .update({
      status,
      snooze_until: status === "snoozed" ? snooze_until : null,
      done_at: status === "done" ? new Date().toISOString() : null,
    })
    .eq("id", itemId)
    .select("id, tenant_id, status")
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: { code: "status_failed", message: error.message } });
    return;
  }
  if (!data) {
    res.status(404).json({ error: { code: "not_found", message: "item not found" } });
    return;
  }
  const row = data as { id: string; tenant_id: string };
  await audit(staff.email, row.tenant_id, "human_action_status", {
    target: row.id,
    after: { status, ...(snooze_until ? { snooze_until } : {}) },
  });
  res.json({ ok: true, item: data });
}

const GoalBody = z.object({
  objective: z.string().min(1).max(1000),
  target_metric: z.string().min(1).max(200),
  target_value: z.number().finite(),
  due_date: z.string().optional(),
  current_value: z.number().finite().optional(),
});

export async function staffHumanActionsSetGoal(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenantId = req.params.tenant_id;
  const parsed = GoalBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_request", message: parsed.error.message } });
    return;
  }
  const b = parsed.data;
  const sb = serviceClient();

  const { data: existing, error: findErr } = await sb
    .from("autopilot_goals")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .eq("target_metric", b.target_metric)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findErr) {
    res.status(500).json({ error: { code: "goal_query_failed", message: findErr.message } });
    return;
  }

  const actor = { source: "staff" as const, user_id: staff.user_id, why: "Set from the staff human-actions console" };
  let goalId: string;
  if (existing) {
    const w = await writeAutopilotGoal(tenantId, {
      op: "update",
      goal_id: (existing as { id: string }).id,
      values: {
        objective: b.objective,
        target_value: b.target_value,
        ...(b.due_date !== undefined ? { due_date: b.due_date } : {}),
        ...(b.current_value !== undefined ? { current_value: b.current_value } : {}),
        updated_at: new Date().toISOString(),
      },
      actor,
    });
    if (w.status !== "written") {
      res.status(500).json({ error: { code: "goal_update_failed", message: w.status === "error" ? w.error : "goal not found" } });
      return;
    }
    goalId = w.id;
  } else {
    const w = await writeAutopilotGoal(tenantId, {
      op: "insert",
      values: {
        objective: b.objective,
        target_metric: b.target_metric,
        target_value: b.target_value,
        due_date: b.due_date ?? null,
        current_value: b.current_value ?? 0,
        status: "active",
        source: "founder",
      },
      actor,
    });
    if (w.status !== "written") {
      res.status(500).json({ error: { code: "goal_insert_failed", message: w.status === "error" ? w.error : "goal not written" } });
      return;
    }
    goalId = w.id;
  }

  await audit(staff.email, tenantId, "goal_set", {
    target: goalId,
    after: { objective: b.objective, target_metric: b.target_metric, target_value: b.target_value, due_date: b.due_date ?? null },
  });
  res.json({ ok: true, goal_id: goalId, updated: !!existing });
}
