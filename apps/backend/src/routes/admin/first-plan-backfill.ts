
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { writeStaffAuditStrict } from "@/services/staff/audit";
import { backfillFromMs, BACKFILL_BEFORE_MS, runFirstPlanWatch } from "@/services/growth/first-plan-watch";
import { firstPlanWatchDeps } from "@/services/growth/first-plan-watch-deps";

export const BACKFILL_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const Body = z.object({ from: z.string().min(10).max(40) });

export async function staffFirstPlanBackfill(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = Body.safeParse(req.body ?? {});
  const now = Date.now();
  const fromMs = parsed.success ? backfillFromMs(parsed.data.from) : Number.NaN;
  if (!parsed.success || !Number.isFinite(fromMs) || fromMs >= now - BACKFILL_BEFORE_MS || fromMs < now - BACKFILL_MAX_AGE_MS) {
    res.status(400).json({
      error: { code: "invalid_from", message: "from must be a date (YYYY-MM-DD) more than 24 hours and at most 90 days ago." },
    });
    return;
  }
  const from = (parsed.data as { from: string }).from;

  try {
    await writeStaffAuditStrict({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "first_plan.backfill",
      target_table: "first_plan_watch",
      meta: { from },
    });
  } catch (e) {
    res.status(503).json({ error: { code: "audit_unavailable", message: (e as Error).message } });
    return;
  }

  let summary;
  try {
    summary = await runFirstPlanWatch(
      await firstPlanWatchDeps(staffCrossTenantClient("first plan backfill: enrol and start first plans for stranded workspaces")),
      { backfillFrom: from },
    );
  } catch (e) {
    res.status(503).json({ error: { code: "backfill_read_failed", message: (e as Error).message } });
    return;
  }
  res.json({
    started: summary.started,
    retried: summary.retried,
    skipped: summary.backfill.skipped,
    enrolled: summary.backfill.enrolled,
    checked: summary.checked,
    errors: summary.errors,
    window: { from: summary.backfill.from, before: summary.backfill.before },
  });
}
