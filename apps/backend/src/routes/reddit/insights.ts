import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { redditDb as serviceClient } from "@/services/channels/reddit/db";
import { buildRedditInsights } from "@/services/channels/reddit/insights";
import { openRedditSweep, type OpenSweepResult } from "@/services/channels/reddit/sweep";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";

export async function redditInsightsGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.json(await buildRedditInsights(serviceClient(), auth.tenant_id));
  } catch (err) {
    console.error("[reddit-insights] get failed", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "reddit_insights_failed" });
  }
}

const sweepBodySchema = z.object({ trigger: z.literal("manual").default("manual") });

const LIMIT_MS = 10 * 60 * 1000;
const STALE_RUNNING_MS = 60 * 60 * 1000;

type FailReason = Extract<OpenSweepResult, { ok: false }>["reason"];

function statusFor(reason: FailReason): number {
  switch (reason) {
    case "already_running":
      return 409;
    case "tenant_cap_reached":
    case "fleet_cap_reached":
      return 429;
    case "nothing_to_scan":
    case "disabled":
    case "not_configured":
      return 422;
    default:
      return 502;
  }
}

const ALREADY_RUNNING_MESSAGE = "A scan is already running.";

const MESSAGES: Partial<Record<FailReason, string>> = {
  already_running: ALREADY_RUNNING_MESSAGE,
  tenant_cap_reached: "This week's scan budget is used up. Scans resume as the 7-day window rolls.",
  fleet_cap_reached: "Zavi has hit today's Reddit scan limit across all workspaces. Try again tomorrow.",
};

function cooldownMessage(retryAfterS: number): string {
  const mins = Math.max(1, Math.ceil(retryAfterS / 60));
  return `A scan ran a few minutes ago. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
}

async function sweepRunning(tenantId: string, now: number): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from("reddit_sweeps")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "running")
    .gt("heartbeat_at", new Date(now - STALE_RUNNING_MS).toISOString())
    .limit(1);
  if (error) throw new Error(`reddit sweep running read failed: ${error.message}`);
  return (data ?? []).length > 0;
}

async function lastManualSweepAt(tenantId: string, now: number): Promise<number | null> {
  const { data, error } = await serviceClient()
    .from("reddit_sweeps")
    .select("started_at")
    .eq("tenant_id", tenantId)
    .eq("trigger", "manual")
    .gt("started_at", new Date(now - LIMIT_MS).toISOString())
    .or("error_code.is.null,error_code.neq.enqueue_failed")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`reddit sweep cooldown read failed: ${error.message}`);
  const at = Date.parse(String((data as Array<{ started_at?: unknown }> | null)?.[0]?.started_at ?? ""));
  return Number.isNaN(at) ? null : at;
}

export async function redditSweepPost(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = sweepBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ reason: "invalid_request", error: "invalid_request", issues: parsed.error.issues.map((i) => i.message) });
    return;
  }
  const planRefusal = await refuseIfChannelPlanLocked(auth.tenant_id, "reddit_organic");
  if (planRefusal) {
    res.status(403).json({ ...planRefusal.body, reason: "plan_upgrade_required", message: planRefusal.message });
    return;
  }
  const trigger = parsed.data.trigger;
  const now = Date.now();
  try {
    if (await sweepRunning(auth.tenant_id, now)) {
      res.status(409).json({ reason: "already_running", message: ALREADY_RUNNING_MESSAGE });
      return;
    }
    const last = await lastManualSweepAt(auth.tenant_id, now);
    if (last !== null) {
      const retryAfter = Math.max(1, Math.ceil((last + LIMIT_MS - now) / 1000));
      res.status(429).json({ reason: "rate_limited", message: cooldownMessage(retryAfter), retry_after_s: retryAfter });
      return;
    }
    const result = await openRedditSweep(auth.tenant_id, { trigger, requestedBy: auth.user_id });
    if (result.ok) {
      res.status(202).json({ sweep_id: result.sweep_id });
      return;
    }
    const message = MESSAGES[result.reason];
    res.status(statusFor(result.reason)).json(message ? { reason: result.reason, message } : { reason: result.reason });
  } catch (err) {
    console.error("[reddit-insights] sweep failed", err instanceof Error ? err.message : err);
    res.status(502).json({ reason: "sweep_failed" });
  }
}
