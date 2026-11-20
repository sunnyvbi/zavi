
import type { Request, Response } from "express";
import { channelForBriefKind } from "@zavi/shared";
import { HUMAN_APPLICATION_REVIEW_CLASS } from "@/services/humans/applications";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { loadChannelRecipe, recipeExists } from "@/services/channels/recipe";

const DecisionIdParam = z.object({ decision_id: z.string().uuid() });

const SnoozeBody = z.object({ until: z.string().datetime().optional() });
export const MAX_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

export function archiveErrorStatus(message: string): 403 | 500 {
  return /not founder_managed|belongs to tenant/.test(message) ? 403 : 500;
}

export function snoozeErrorStatus(message: string): 403 | 500 {
  return /not founder_managed|belongs to tenant/.test(message) ? 403 : 500;
}

const OPAQUE_DENY = "That action can't be closed from here.";

const DAY_MS = 24 * 60 * 60 * 1000;

export function snoozeWindowMsFor(cadence: string | null): number {
  switch (cadence) {
    case "daily":
      return DAY_MS;
    case "weekly":
      return 7 * DAY_MS;
    case "monthly":
      return 14 * DAY_MS;
    default:
      return 7 * DAY_MS;
  }
}

async function cadenceForDecision(
  accessToken: string,
  tenantId: string,
  decisionId: string,
): Promise<string | null> {
  const supabase = serverClientFromBearer(accessToken);
  const { data } = await supabase
    .from("decisions")
    .select("agent_run_id, decision_class, body")
    .eq("id", decisionId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const row = data as {
    agent_run_id?: string | null;
    decision_class?: string | null;
    body?: { brief_kind?: unknown } | null;
  } | null;
  const runId = row?.agent_run_id;

  if (!runId) {
    if (row?.decision_class !== HUMAN_APPLICATION_REVIEW_CLASS) return null;
    const briefKind = row?.body?.brief_kind;
    if (typeof briefKind !== "string") return null;
    const humanSlug = channelForBriefKind(briefKind)?.slug;
    if (!humanSlug || !recipeExists(humanSlug)) return null;
    try {
      return loadChannelRecipe(humanSlug).meta.cadence;
    } catch {
      return null;
    }
  }
  const { data: run } = await supabase
    .from("agent_runs")
    .select("channel_slug")
    .eq("id", runId)
    .maybeSingle();
  const slug = (run as { channel_slug?: string | null } | null)?.channel_slug;
  if (!slug || !recipeExists(slug)) return null;
  try {
    return loadChannelRecipe(slug).meta.cadence;
  } catch {
    return null;
  }
}

async function callerCanSeeDecision(
  accessToken: string,
  tenantId: string,
  decisionId: string,
): Promise<boolean> {
  const supabase = serverClientFromBearer(accessToken);
  const { data, error } = await supabase
    .from("decisions")
    .select("id")
    .eq("id", decisionId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) return false;
  return !!data;
}

export function snoozeUntilValid(untilIso: string, nowMs: number): boolean {
  const ms = Date.parse(untilIso);
  if (!Number.isFinite(ms)) return false;
  return ms > nowMs && ms <= nowMs + MAX_SNOOZE_MS;
}

export async function approvalsArchive(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = DecisionIdParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_decision_id", message: "decision_id must be a uuid" } });
    return;
  }

  if (!(await callerCanSeeDecision(auth.access_token, auth.tenant_id, parsed.data.decision_id))) {
    res.status(404).json({ error: { code: "not_found", message: OPAQUE_DENY } });
    return;
  }

  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "archive_decision", {
    p_decision_id: parsed.data.decision_id,
  });

  if (error) {
    const code = archiveErrorStatus(error.message);
    console.warn(`[approvals/archive] ${parsed.data.decision_id}: ${error.message}`);
    res.status(code).json({
      error: { code: code === 403 ? "not_founder_managed" : "archive_failed", message: OPAQUE_DENY },
    });
    return;
  }
  res.json({ ok: true, changed: data === true });
}

export async function approvalsSnooze(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = DecisionIdParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_decision_id", message: "decision_id must be a uuid" } });
    return;
  }
  const body = SnoozeBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "bad_until", message: "until must be an ISO timestamp" } });
    return;
  }

  if (!(await callerCanSeeDecision(auth.access_token, auth.tenant_id, parsed.data.decision_id))) {
    res.status(404).json({ error: { code: "not_found", message: OPAQUE_DENY } });
    return;
  }

  let until = body.data.until;
  if (!until) {
    const cadence = await cadenceForDecision(
      auth.access_token,
      auth.tenant_id,
      parsed.data.decision_id,
    );
    until = new Date(Date.now() + snoozeWindowMsFor(cadence)).toISOString();
  }
  if (!snoozeUntilValid(until, Date.now())) {
    res.status(400).json({
      error: { code: "bad_until", message: "until must be in the future and within 14 days" },
    });
    return;
  }

  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "snooze_decision", {
    p_decision_id: parsed.data.decision_id,
    p_until: until,
  });

  if (error) {
    const code = snoozeErrorStatus(error.message);
    console.warn(`[approvals/snooze] ${parsed.data.decision_id}: ${error.message}`);
    res.status(code).json({
      error: { code: code === 403 ? "not_snoozeable" : "snooze_failed", message: OPAQUE_DENY },
    });
    return;
  }
  res.json({ ok: true, changed: data === true });
}

export async function approvalsUnsnooze(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = DecisionIdParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_decision_id", message: "decision_id must be a uuid" } });
    return;
  }
  if (!(await callerCanSeeDecision(auth.access_token, auth.tenant_id, parsed.data.decision_id))) {
    res.status(404).json({ error: { code: "not_found", message: OPAQUE_DENY } });
    return;
  }

  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "unsnooze_decision", {
    p_decision_id: parsed.data.decision_id,
  });
  if (error) {
    console.warn(`[approvals/unsnooze] ${parsed.data.decision_id}: ${error.message}`);
    res.status(500).json({ error: { code: "unsnooze_failed", message: OPAQUE_DENY } });
    return;
  }
  res.json({ ok: true, changed: data === true });
}
