
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import {
  getSchedule,
  upsertSchedule,
  deleteSchedule,
  ScheduleValidationError,
  ScheduleForbiddenError,
} from "@/services/agents/schedules";
import {
  validateCronExpression,
  isValidTimeZone,
} from "../../../workers/functions/cron-match";
import { validatePayloadTemplate } from "@/services/agents/standing-orders";
import { isCronStopped } from "@/services/agents/cron-stopped";

const CRON_GATED_UNWIRED = new Set<string>([]);

export function scheduleWarningFor(slug: string, enabled: boolean): string | undefined {
  if (!enabled) return undefined;
  if (isCronStopped(slug)) {
    return `Agent "${slug}" has its scheduled runs stopped fleet-wide; this schedule is saved but will not fire. Manual and chat runs still work.`;
  }
  if (CRON_GATED_UNWIRED.has(slug)) {
    return `Agent "${slug}" dispatch is not wired yet; scheduled runs will be skipped unless PRAXIS_DISABLE_CRON_GATE=1.`;
  }
  return undefined;
}

export async function agentScheduleGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const schedule = await getSchedule(auth.tenant_id, req.params.slug);
    const warning = schedule
      ? scheduleWarningFor(req.params.slug, schedule.enabled)
      : undefined;
    res.json({ schedule, ...(warning ? { warning } : {}) });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function agentSchedulePut(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = req.params.slug;
  const body = (req.body ?? {}) as {
    cron_expression?: unknown;
    enabled?: unknown;
    payload_template?: unknown;
    timezone?: unknown;
  };
  const cron = typeof body.cron_expression === "string" ? body.cron_expression.trim() : "";
  const enabled = body.enabled !== false;

  const cronErr = validateCronExpression(cron);
  if (cronErr) {
    res.status(400).json({ error: { code: "bad_cron", message: cronErr } });
    return;
  }
  let timezone: string | null | undefined;
  if (body.timezone !== undefined) {
    if (body.timezone === null || body.timezone === "") {
      timezone = "";
    } else if (typeof body.timezone === "string" && isValidTimeZone(body.timezone.trim())) {
      timezone = body.timezone.trim();
    } else {
      res.status(400).json({
        error: { code: "bad_timezone", message: "timezone must be a valid IANA zone (e.g. America/Los_Angeles) or empty to use UTC" },
      });
      return;
    }
  }
  let payloadTemplate: Record<string, unknown> | null = null;
  if (body.payload_template !== undefined && body.payload_template !== null) {
    const tpl = validatePayloadTemplate(body.payload_template);
    if (!tpl.ok) {
      res
        .status(400)
        .json({ error: { code: "bad_payload_template", message: tpl.error } });
      return;
    }
    payloadTemplate = tpl.value;
  }
  try {
    await upsertSchedule(
      auth.access_token,
      auth.tenant_id,
      slug,
      cron,
      enabled,
      payloadTemplate,
      timezone,
    );
  } catch (e) {
    if (e instanceof ScheduleValidationError) {
      res.status(400).json({ error: { code: "bad_cron", message: e.message } });
      return;
    }
    if (e instanceof ScheduleForbiddenError) {
      res.status(403).json({ error: { code: "forbidden", message: e.message } });
      return;
    }
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
    return;
  }
  const warning = scheduleWarningFor(slug, enabled);
  res.json({ ok: true, ...(warning ? { warning } : {}) });
}

export async function agentScheduleDelete(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    await deleteSchedule(auth.access_token, auth.tenant_id, req.params.slug);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof ScheduleForbiddenError) {
      res.status(403).json({ error: { code: "forbidden", message: e.message } });
      return;
    }
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}
