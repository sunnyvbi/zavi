
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import {
  sanitizeFetchedContent,
  xmlEscapeContent,
  decodeXmlEntities,
} from "@/services/onboarding/enrichment/sanitize";
import { createFounderGoalServiceRole } from "@/routes/workspace/autopilot";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { validateMeasurementMode } from "@/services/autopilot/goal-measurement-mode";

const bodySchema = z.object({
  objective: z.string().trim().min(4).max(500),
  target_metric: z.string().trim().min(1).max(120),
  target_value: z
    .number({ error: 'Add a number to your goal so it can be measured, e.g. "to 500".' })
    .finite(),
  baseline_value: z.number().finite().nullish(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be a YYYY-MM-DD date string")
    .refine((s) => Number.isFinite(Date.parse(s)), "due_date is not a valid date")
    .nullish(),
  measurement_mode: z.unknown().optional(),
});

export async function postHomeGoal(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: parsed.error.issues[0]?.message ?? "invalid goal body",
      },
    });
    return;
  }
  const { target_value } = parsed.data;
  const baseline_value = parsed.data.baseline_value ?? null;
  const due_date = parsed.data.due_date ?? null;

  const cleanObjective = xmlEscapeContent(sanitizeFetchedContent(parsed.data.objective));
  if (cleanObjective.trim().length === 0) {
    res.status(400).json({
      error: { code: "bad_request", message: "objective cannot be empty after sanitization" },
    });
    return;
  }
  const cleanMetric = xmlEscapeContent(sanitizeFetchedContent(parsed.data.target_metric));
  if (cleanMetric.trim().length === 0) {
    res.status(400).json({
      error: { code: "bad_request", message: "target_metric cannot be empty after sanitization" },
    });
    return;
  }

  const vMode = validateMeasurementMode(
    parsed.data.measurement_mode,
    decodeXmlEntities(parsed.data.target_metric),
  );
  if (!vMode.ok) {
    res.status(400).json({ error: { code: vMode.code, message: vMode.message } });
    return;
  }

  const created = await createFounderGoalServiceRole({
    tenant_id: auth.tenant_id,
    objective: cleanObjective,
    target_metric: cleanMetric,
    humanMetric: decodeXmlEntities(parsed.data.target_metric),
    target_value,
    baseline_value,
    due_date,
    priority: null,
    measurementMode: vMode.value ?? "manual_reported",
    actor: { source: "founder", user_id: auth.user_id },
  });
  if (!created.ok) {
    res.status(created.status).json({ error: { code: created.code, message: created.message } });
    return;
  }
  const goalId = created.id;

  const rls = serverClientFromBearer(auth.access_token);
  const { data: row } = await rls
    .from("autopilot_goals")
    .select(
      "id, objective, target_metric, target_value, baseline_value, current_value, due_date, status, priority, source",
    )
    .eq("tenant_id", auth.tenant_id)
    .eq("id", goalId)
    .maybeSingle();

  const goal = row
    ? {
        id: row.id as string,
        objective: decodeXmlEntities(row.objective as string),
        target_metric: decodeXmlEntities(row.target_metric as string),
        target_value: Number(row.target_value),
        baseline_value: row.baseline_value === null ? null : Number(row.baseline_value),
        current_value: row.current_value === null ? null : Number(row.current_value),
        due_date: (row.due_date as string | null) ?? null,
        status: row.status as string,
        priority: row.priority as number,
        source: row.source as string,
      }
    : null;

  res.json({ ok: true, id: goalId, goal, ...(created.warning ? { warnings: [created.warning] } : {}) });
}
