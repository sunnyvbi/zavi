
import { alert } from "@/services/logging/alert";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { actionsStoreFor, getChannel, isChannelSlug, isPartialRiskExecCode } from "@zavi/shared";
import { comingSoonMessage, isChannelLockedStrict } from "@/services/channels/lock";
import { requireAuth } from "@/services/auth/middleware";
import { signActionMedia } from "@/services/channels/action-media";
import { execVerdictOf } from "@/services/channels/exec-failure";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { channelActionRaisesSpend, channelApproveForbiddenMessage, channelApproveNeedsAdmin } from "@/services/channels/approve-needs-admin";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import {
  listChannelActions,
  listChannelMetrics,
  planDay,
  readHistoryChannelActionCard,
  scheduledAtForDay,
  timeInZone,
  stagedPostsForCards,
  tenantTimezone,
} from "@/services/channels/channel-actions";
import { isIsoDay } from "@/agents/lib/channel-recipe-step";
import { refreshApprovalCard } from "@/services/slack/approval-post-target";
import { runChannelRecipe } from "@/services/channels/engine";
import { readTopActionMiss } from "@/services/channels/top-action-miss";
import { releaseChannelRunClaim } from "@/services/channels/claim";
import { defaultChannelContext } from "@/services/channels/context";
import { enqueueAgentRun, InsufficientCreditsError } from "@/services/agents/runner";
import { asPlanUpgradeRequired } from "@/services/billing/tiers";
import { refusalFor } from "@/services/agents/refusal";
import { loadChannelRecipe, recipeExists } from "@/services/channels/recipe";
import { snoozeUntilValid, snoozeWindowMsFor } from "@/routes/approvals/close";
import { logEvent } from "@/services/logging/logEvent";
import { approveChannelAction } from "@/services/channels/exec-actions";
import { CREATOR_HIRE_CLASS } from "@/services/creators/hire-approve";
import { declineCreatorHire } from "@/services/creators/hire-card";
import { trackChannelActionResponded, type FounderResponse } from "@/services/analytics/action-events";
import { inngest } from "@/../workers/client";
import { suggestRuleFromReject } from "@/services/rules/suggest";
import { EMAIL_CARD_APPROVE_MESSAGE, EMAIL_CARD_APPROVE_REQUIRED } from "@/services/email-cards/approve-gate";
import { emailCardLink } from "@/services/email-cards/cards";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";

const IdParam = z.object({ id: z.string().uuid() });

const SetBody = z.object({
  action: z.enum(["acted", "rejected", "snoozed", "open"]),
  note: z.string().trim().max(1000).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  request_id: z.string().trim().min(8).max(200),
});

export const RedoBody = z
  .object({
    note: z.string().trim().min(1).max(2000),
    kind: z.enum(["answer"]).optional(),
  })
  .refine((b) => b.kind === "answer" || b.note.length >= 3, {
    message: "The note is too short. Use at least 3 characters.",
    path: ["note"],
  });

const ABANDONED_CLAIM_MS = 30 * 60 * 1000;

const ApproveBody = z.object({
  request_id: z.string().trim().min(8).max(200),
  via: z.literal("mobile").optional(),
});

const FIELD_NAMES: Record<string, string> = { note: "The note", until: "The snooze date", request_id: "The request id", steps_done: "The steps", action: "The action" };

export function plainValidationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "That request was not valid.";
  const key = String(issue.path[0] ?? "");
  const field = FIELD_NAMES[key] ?? (key ? `The ${key.replace(/_/g, " ")}` : "That request");
  const limit = (issue as { maximum?: number | bigint; minimum?: number | bigint }).maximum ?? (issue as { minimum?: number | bigint }).minimum;
  const origin = (issue as { origin?: string }).origin;
  if (issue.code === "custom" && issue.message) return issue.message.endsWith(".") ? issue.message : `${issue.message}.`;
  if ((issue.code === "too_big" || issue.code === "too_small") && origin !== "string") {
    if (origin === "array" && limit !== undefined) {
      return issue.code === "too_big" ? `${field} has too many items. Keep it to ${limit} or fewer.` : `${field} needs at least ${limit} items.`;
    }
    return `${field} is out of range.`;
  }
  if (issue.code === "too_big") return `${field} is too long${limit !== undefined ? `. Keep it to ${limit} characters or fewer` : ""}.`;
  if (issue.code === "too_small") return `${field} is too short${limit !== undefined ? `. Use at least ${limit} characters` : ""}.`;
  if (issue.code === "invalid_value") return `${field} is not one of the allowed choices.`;
  if (issue.code === "unrecognized_keys") return "That request has fields this action does not take.";
  return `${field} is missing or not valid.`;
}

function badSlug(res: Response): void {
  res.status(404).json({ error: { code: "unknown_channel", message: "Unknown channel." } });
}

function overridden(auth: unknown, res: Response): boolean {
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({
      error: { code: "tenant_override_forbidden", message: "Not available for an overridden tenant." },
    });
    return true;
  }
  return false;
}

const GENERATED_VIDEO_RENDER_CLASS = "generated_video.render.v1";

export async function channelVideoCardRead(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const param = IdParam.safeParse(req.params);
  if (!param.success) {
    res.status(400).json({ error: { code: "bad_action_id", message: "id must be a uuid" } });
    return;
  }
  try {
    const { data, error } = await tenantClient(auth.tenant_id)
      .from("channel_actions")
      .select("id, channel_slug, title, body, status, note, exec_status, exec_class, exec_result, proposed_at")
      .eq("id", param.data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const found = data as { channel_slug: string; exec_class: string | null; exec_status: string | null; exec_result: unknown; body: Record<string, unknown> | null } | null;
    const { exec_result, ...row } = found ?? { exec_result: null };
    if (!found || found.channel_slug !== "generated_video" || found.exec_class !== GENERATED_VIDEO_RENDER_CLASS) {
      res.status(404).json({ error: { code: "not_found", message: "Video card not found." } });
      return;
    }
    const failedCode = found.exec_status === "failed" ? (exec_result as { code?: unknown } | null)?.code : null;
    const [card] = await signActionMedia(auth.tenant_id, [
      { ...row, exec_code: typeof failedCode === "string" ? failedCode : null, exec_bucket: execVerdictOf(found.exec_status, exec_result)?.bucket ?? null },
    ]);
    res.json({ card });
  } catch {
    res.status(503).json({ error: { code: "read_failed", message: "The video card could not be read. Try again." } });
  }
}

export async function channelHistoryCardRead(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const param = IdParam.safeParse(req.params);
  if (!param.success) {
    res.status(400).json({ error: { code: "bad_action_id", message: "id must be a uuid" } });
    return;
  }
  try {
    const card = await readHistoryChannelActionCard(auth.tenant_id, param.data.id, auth.user_id);
    if (!card) {
      res.status(404).json({ error: { code: "not_found", message: "Card not found." } });
      return;
    }
    res.json({ card });
  } catch {
    res.status(503).json({ error: { code: "read_failed", message: "The card could not be read. Try again." } });
  }
}

export async function channelActionsList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = String(req.params.slug ?? "");
  if (!isChannelSlug(slug)) return badSlug(res);
  try {
    const all = req.query.all === "1" || req.query.all === "true";
    const [list, miss] = await Promise.all([
      listChannelActions(auth.tenant_id, slug, { all, withCompleted: true, viewerUserId: auth.user_id }),
      readTopActionMiss(auth.tenant_id, auth.user_id, slug).catch(() => null),
    ]);
    res.json(miss ? { ...list, top_action_miss: miss } : list);
  } catch (e) {
    console.warn(`[channel-actions] ${slug} list: ${(e as Error).message}`);
    res.status(500).json({ error: { code: "read_failed", message: "Could not read actions." } });
  }
}

export async function channelMetricsList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = String(req.params.slug ?? "");
  if (!isChannelSlug(slug)) return badSlug(res);
  try {
    res.json({ metrics: await listChannelMetrics(auth.tenant_id, slug) });
  } catch (e) {
    console.warn(`[channel-actions] ${slug} metrics: ${(e as Error).message}`);
    res.status(500).json({ error: { code: "read_failed", message: "Could not read actions." } });
  }
}

export function channelActionErrorStatus(code: string | undefined): 400 | 404 | 409 {
  if (code === "not_found") return 404;
  if (
    code === "illegal_transition" ||
    code === "not_reopenable" ||
    code === "exec_in_flight" ||
    code === "already_executed" ||
    code === "not_executable" ||
    code === "exec_partial_no_retry" ||
    code === "exec_blocked_no_retry" ||
    code === "paired_move_waits" ||
    code === "paired_move_unreadable" ||
    code === EMAIL_CARD_APPROVE_REQUIRED
  ) {
    return 409;
  }
  return 400;
}

type ActionRow = {
  id: string;
  channel_slug: string;
  run_id: string;
  position: number;
  run_of: number;
  title: string;
  title_key: string;
  status: string;
  exec_status: string | null;
  exec_class: string | null;
  exec_result?: { code?: unknown; bucket?: unknown } | null;
  exec_payload?: unknown;
};

export function partialRiskRetry(row: Pick<ActionRow, "exec_status" | "exec_result">): boolean {
  return row.exec_status === "failed" && (isPartialRiskExecCode(row.exec_result?.code) || row.exec_result?.bucket === "partial_risk");
}

const PARTIAL_NO_RETRY_MESSAGE =
  "Part of this change may already exist, so Zavi will not run it again. Check the account and finish or remove it there.";

export function blockedRetry(row: Pick<ActionRow, "exec_status" | "exec_result">): boolean {
  return row.exec_status === "failed" && row.exec_result?.bucket === "blocked_on_us";
}

export const BLOCKED_NO_RETRY_MESSAGE =
  "The platform refused this change, so it can't be run again. We've been alerted.";

function approveRefusalMessage(code: string | undefined): string {
  if (code === "exec_partial_no_retry") return PARTIAL_NO_RETRY_MESSAGE;
  if (code === "exec_blocked_no_retry") return BLOCKED_NO_RETRY_MESSAGE;
  if (code === EMAIL_CARD_APPROVE_REQUIRED) return EMAIL_CARD_APPROVE_MESSAGE;
  if (code === "paired_move_unreadable") return "Zavi could not read this card just now, so nothing was approved. Try again in a minute.";
  return "That change can't be approved from here.";
}

export function execInFlight(row: Pick<ActionRow, "exec_status">): boolean {
  return row.exec_status === "queued" || row.exec_status === "dispatching";
}

async function redoAttempt(
  auth: { tenant_id: Parameters<typeof tenantClient>[0] },
  actionId: string,
): Promise<{ key: string; runInFlight: boolean }> {
  const { data, error } = await tenantClient(auth.tenant_id)
    .from("agent_runs")
    .select("id, status")
    .eq("payload->>redo_of_action_id", actionId);
  if (error) throw new Error(error.message);
  const runs = (data ?? []) as Array<{ status: string }>;
  const live = runs.filter((r) => r.status === "queued" || r.status === "running").length;
  return { key: `redo:${actionId}:${runs.length - live}`, runInFlight: live > 0 };
}

async function releaseAbandonedRedoClaim(
  auth: { tenant_id: Parameters<typeof tenantClient>[0] },
  channelSlug: string,
  key: string,
): Promise<void> {
  const { data, error } = await tenantClient(auth.tenant_id)
    .from("channel_run_claims")
    .select("id, run_id, claimed_at")
    .eq("channel_slug", channelSlug)
    .eq("request_id", key)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const claim = data as { id: string; run_id: string | null; claimed_at: string } | null;
  if (!claim || claim.run_id !== null) return;
  if (Date.now() - Date.parse(claim.claimed_at) < ABANDONED_CLAIM_MS) return;
  await releaseChannelRunClaim(String(auth.tenant_id), claim.id);
}

async function readAction(auth: { tenant_id: Parameters<typeof tenantClient>[0] }, id: string) {
  const { data, error } = await tenantClient(auth.tenant_id)
    .from("channel_actions")
    .select("id, channel_slug, run_id, position, run_of, title, title_key, status, exec_status, exec_class, exec_result, exec_payload")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as ActionRow | null;
}

function trackResponse(
  auth: { tenant_id: Parameters<typeof tenantClient>[0]; user_id: string },
  id: string,
  response: FounderResponse,
): void {
  void readAction(auth, id)
    .then((row) => {
      if (!row) return;
      trackChannelActionResponded({
        tenant_id: auth.tenant_id,
        user_id: auth.user_id,
        channel_slug: row.channel_slug,
        response,
      });
    })
    .catch(() => undefined);
}

function cadenceOf(slug: string): string | null {
  if (!recipeExists(slug)) return null;
  try {
    return loadChannelRecipe(slug).meta.cadence;
  } catch {
    return null;
  }
}

async function closeTerminalResponse(
  auth: { tenant_id: Parameters<typeof tenantClient>[0]; user_id: string },
  actionId: string,
  response: "acted" | "rejected",
  note: string | null,
): Promise<void> {
  let row: ActionRow | null;
  try {
    row = await readAction(auth, actionId);
  } catch (e) {
    void logEvent({
      level: "warn",
      source: "channel_actions.set",
      code: "channel_action_close_read_failed",
      message: `card ${actionId} ${response}: ${(e as Error).message}`.slice(0, 300),
      tenant_id: String(auth.tenant_id),
    }).catch(() => undefined);
    return;
  }
  if (!row) return;
  trackChannelActionResponded({
    tenant_id: auth.tenant_id,
    user_id: auth.user_id,
    channel_slug: row.channel_slug,
    response,
  });
  if (row.exec_class !== CREATOR_HIRE_CLASS) return;
  if (row.exec_status != null && row.exec_status !== "failed") return;
  const order_id = (row.exec_payload as { order_id?: unknown } | null)?.order_id;
  if (typeof order_id !== "string" || !order_id) return;
  const because =
    response === "acted" ? "The founder closed this hire without approving it" : "The founder turned down this hire";
  try {
    await declineCreatorHire({
      tenant_id: String(auth.tenant_id),
      order_id,
      reason: note ? `${because}: ${note}` : `${because}.`,
    });
  } catch {
    void alert({
      source: "creator-hire",
      code: "creator_hire_decline_failed",
      tenant_id: String(auth.tenant_id),
      msg: `Creator order ${order_id} (card ${actionId}): the founder declined the hire but closing the order failed. A Checkout link may still be payable; expire it and close the order by hand.`,
      email: { dedupeKey: `creator_hire_decline_failed:${order_id}` },
    }).catch(() => undefined);
  }
}

export async function channelActionSet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (overridden(auth, res)) return;
  const param = IdParam.safeParse(req.params);
  if (!param.success) {
    res.status(400).json({ error: { code: "bad_action_id", message: "id must be a uuid" } });
    return;
  }
  const body = SetBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "validation", message: plainValidationMessage(body.error) } });
    return;
  }

  let until: string | null = null;
  if (body.data.action === "snoozed") {
    const nowMs = Date.now();
    if (body.data.until) {
      if (!snoozeUntilValid(body.data.until, nowMs)) {
        res.status(400).json({
          error: { code: "bad_until", message: "Snooze must end in the future and within 14 days." },
        });
        return;
      }
      until = new Date(body.data.until).toISOString();
    } else {
      let row: ActionRow | null;
      try {
        row = await readAction(auth, param.data.id);
      } catch (e) {
        res.status(500).json({ error: { code: "read_failed", message: "Could not read actions." } });
        return;
      }
      if (!row) {
        res.status(404).json({ error: { code: "not_found", message: "Action not found." } });
        return;
      }
      until = new Date(nowMs + snoozeWindowMsFor(cadenceOf(row.channel_slug))).toISOString();
    }
  }

  const { data, error } = await tenantRpc(auth.tenant_id, "set_channel_action", {
    p_action_id: param.data.id,
    p_status: body.data.action,
    p_note: body.data.note ?? null,
    p_snoozed_until: until,
    p_event_key: body.data.request_id,
    p_actor_user_id: auth.user_id,
  });
  if (error) {
    console.warn(`[channel-actions] set ${param.data.id}: ${error.message}`);
    res.status(500).json({ error: { code: "write_failed", message: "That action could not be updated." } });
    return;
  }
  const out = (data ?? {}) as { ok?: boolean; code?: string; status?: string; replayed?: boolean };
  if (!out.ok) {
    res.status(channelActionErrorStatus(out.code)).json({
      error: { code: out.code ?? "refused", message: "That action can't be changed from here." },
    });
    return;
  }
  if (out.replayed !== true && body.data.action === "snoozed") trackResponse(auth, param.data.id, "snoozed");
  if (out.replayed !== true && body.data.action === "rejected" && body.data.note) {
    void suggestRuleFromReject({ tenantId: auth.tenant_id, actionId: param.data.id, eventKey: body.data.request_id });
  }
  if (out.replayed !== true && (body.data.action === "acted" || body.data.action === "rejected")) {
    await closeTerminalResponse(auth, param.data.id, body.data.action, body.data.note ?? null);
  }
  res.json({ ok: true, status: out.status, replayed: out.replayed === true });
}

export const StepsBody = z.object({
  steps_done: z
    .array(z.number().int().min(0).max(11))
    .max(12)
    .refine((a) => new Set(a).size === a.length, { message: "steps must be distinct" }),
});

export async function channelActionSteps(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (overridden(auth, res)) return;
  const param = IdParam.safeParse(req.params);
  if (!param.success) {
    res.status(400).json({ error: { code: "bad_action_id", message: "id must be a uuid" } });
    return;
  }
  const body = StepsBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "validation", message: plainValidationMessage(body.error) } });
    return;
  }
  let data: unknown = null;
  let error: { message: string } | null = null;
  try {
    ({ data, error } = await tenantRpc(auth.tenant_id, "set_channel_action_steps", {
      p_action_id: param.data.id,
      p_steps_done: body.data.steps_done,
      p_actor_user_id: auth.user_id,
    }));
  } catch (e) {
    error = { message: e instanceof Error ? e.message : String(e) };
  }
  if (error) {
    console.warn(`[channel-actions] steps ${param.data.id}: ${error.message}`);
    res.status(500).json({ error: { code: "write_failed", message: "Those steps could not be saved." } });
    return;
  }
  const out = (data ?? {}) as { ok?: boolean; code?: string; steps_done?: number[] };
  if (!out.ok) {
    res.status(channelActionErrorStatus(out.code)).json({
      error: { code: out.code ?? "refused", message: "Those steps can't be saved on this card." },
    });
    return;
  }
  res.json({ ok: true, steps_done: out.steps_done ?? body.data.steps_done });
}

export const PublishOnBody = z.object({
  publish_on: z.string().refine(isIsoDay, "publish_on must be a YYYY-MM-DD day").nullable(),
  publish_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "publish_time must be an HH:MM time").optional(),
});

export async function channelActionPublishOn(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (overridden(auth, res)) return;
  const param = IdParam.safeParse(req.params);
  if (!param.success) {
    res.status(400).json({ error: { code: "bad_action_id", message: "id must be a uuid" } });
    return;
  }
  const body = PublishOnBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "validation", message: plainValidationMessage(body.error) } });
    return;
  }
  const refuse = (code: string | undefined) =>
    res.status(publishOnErrorStatus(code)).json({
      error: { code: code ?? "refused", message: "That card's day can't be changed." },
    });
  try {
    const { data: row, error: readErr } = await tenantClient(auth.tenant_id)
      .from("channel_actions")
      .select("id, run_id, body, channel_slug")
      .eq("id", param.data.id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "Action not found." } });
      return;
    }
    const card = row as { id: string; run_id: string; body: unknown; channel_slug: string };
    const planRefusal = await refuseIfChannelPlanLocked(auth.tenant_id, card.channel_slug);
    if (planRefusal) {
      res.status(403).json(planRefusal.body);
      return;
    }
    const staged = (await stagedPostsForCards(auth.tenant_id, [card], { includeDecided: true })).get(card.id);
    if (staged?.kind === "ambiguous") {
      refuse("ambiguous");
      return;
    }
    if (staged?.kind === "not_pending") {
      refuse("not_pending");
      return;
    }
    if (staged?.kind === "paired") {
      const tz = await tenantTimezone(auth.tenant_id);
      const at = body.data.publish_on === null ? null : scheduledAtForDay(body.data.publish_on, tz, Date.now(), body.data.publish_time);
      if (body.data.publish_on !== null && body.data.publish_time !== undefined && at === null) {
        res.status(400).json({
          error: {
            code: "invalid_publish_time",
            message: "That time has passed or does not exist in your workspace time zone. Pick a later time.",
          },
        });
        return;
      }
      const { data, error } = await tenantRpc(auth.tenant_id, "set_staged_post_scheduled_at", {
        p_decision_id: staged.decision_id,
        p_scheduled_at: at,
        p_actor_user_id: auth.user_id,
      });
      if (error) throw new Error(error.message);
      const out = (data ?? {}) as { ok?: boolean; code?: string; scheduled_at?: string | null };
      if (!out.ok) {
        refuse(out.code);
        return;
      }
      void refreshApprovalCard({ tenant_id: auth.tenant_id, decision_id: staged.decision_id })
        .then((ok) => {
          if (!ok) console.warn(`[channel-actions] publish-on ${card.id}: Slack approval card not updated`);
        })
        .catch(() => undefined);
      const heldAt = out.scheduled_at ?? null;
      res.json({
        ...planDay(card.body, heldAt, tz),
        plan_time: heldAt ? timeInZone(heldAt, tz) : null,
        plan_timezone: tz,
      });
      return;
    }
    const { data, error } = await tenantRpc(auth.tenant_id, "set_channel_action_publish_on", {
      p_action_id: param.data.id,
      p_publish_on: body.data.publish_on,
      p_actor_user_id: auth.user_id,
    });
    if (error) throw new Error(error.message);
    const out = (data ?? {}) as { ok?: boolean; code?: string; publish_on?: string | null };
    if (!out.ok) {
      refuse(out.code);
      return;
    }
    res.json(planDay({ step: { publish_on: out.publish_on ?? null } }));
  } catch (e) {
    console.warn(`[channel-actions] publish-on ${param.data.id}: ${e instanceof Error ? e.message : String(e)}`);
    res.status(500).json({ error: { code: "write_failed", message: "That day could not be saved." } });
  }
}

function publishOnErrorStatus(code: string | undefined): 400 | 404 | 409 {
  if (code === "not_pending" || code === "ambiguous") return 409;
  return channelActionErrorStatus(code);
}

export async function channelActionApprove(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (overridden(auth, res)) return;
  const param = IdParam.safeParse(req.params);
  if (!param.success) {
    res.status(400).json({ error: { code: "bad_action_id", message: "id must be a uuid" } });
    return;
  }
  const body = ApproveBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "validation", message: plainValidationMessage(body.error) } });
    return;
  }

  let current: ActionRow | null;
  try {
    current = await readAction(auth, param.data.id);
    if (current?.channel_slug === "chatgpt_ads" && current.exec_class) {
      const { adsAuth } = await import("./chatgpt-ads");
      const ownerOnly = !current.exec_class.startsWith("chatgpt_ads.");
      if (!(await adsAuth(req, res, ownerOnly))) return;
    }
    const ec = current?.exec_class ?? "";
    const spends = channelActionRaisesSpend(ec, current?.exec_payload);
    if (channelApproveNeedsAdmin(ec, current?.exec_payload)) {
      const role = await loadTenantRoleFor(auth.user_id, auth.tenant_id);
      if (role !== "owner" && role !== "admin") {
        res.status(403).json({ error: { code: "forbidden", message: channelApproveForbiddenMessage(ec) } });
        return;
      }
    }
    if (spends && current && (await isChannelLockedStrict(current.channel_slug))) {
      res.status(403).json({ error: { code: "coming_soon", message: comingSoonMessage(getChannel(current.channel_slug)?.name ?? current.channel_slug) } });
      return;
    }
  } catch {
    res.status(503).json({ error: { code: "authorization_unavailable", message: "Workspace access could not be checked. Try again." } });
    return;
  }
  if (current?.exec_class && current.exec_class !== "linkedin_ads.set_status") {
    const planRefusal = await refuseIfChannelPlanLocked(auth.tenant_id, current.channel_slug);
    if (planRefusal) {
      res.status(403).json(planRefusal.body);
      return;
    }
  }
  if (current && partialRiskRetry(current)) {
    res.status(409).json({ error: { code: "exec_partial_no_retry", message: PARTIAL_NO_RETRY_MESSAGE } });
    return;
  }
  if (current && blockedRetry(current)) {
    res.status(409).json({ error: { code: "exec_blocked_no_retry", message: BLOCKED_NO_RETRY_MESSAGE } });
    return;
  }
  if (current?.exec_class?.startsWith("chatgpt_ads.")) {
    const { chatgptWalletShortfall } = await import("@/services/channels/chatgpt-ads/proposal-readiness");
    const short = await chatgptWalletShortfall(auth.tenant_id, current);
    if (short) {
      res.status(409).json({
        error: {
          code: "chatgpt_wallet_short",
          message: `Your ChatGPT ads balance is $${(short.shortfall_cents / 100).toFixed(2)} short of this campaign's schedule. Add balance, then approve.`,
          required_cents: short.required_cents,
          available_cents: short.available_cents,
        },
      });
      return;
    }
  }
  if (current?.exec_class?.startsWith("generated_video.render.v1")) {
    const { generatedVideoApproveRefusal } = await import("@/services/channels/generated-video-render");
    const refusal = await generatedVideoApproveRefusal(auth.tenant_id, current.exec_payload);
    if (refusal) {
      res.status(refusal.status).json(refusal.body);
      return;
    }
  }
  let result;
  try {
    result = await approveChannelAction(auth.tenant_id, {
      actionId: param.data.id,
      eventKey: body.data.request_id,
      actorUserId: auth.user_id,
    });
  } catch (e) {
    console.warn(`[channel-actions] approve ${param.data.id}: ${(e as Error).message}`);
    res.status(500).json({ error: { code: "write_failed", message: "That change could not be queued." } });
    return;
  }
  if (!result.ok) {
    res.status(channelActionErrorStatus(result.code)).json({
      error: {
        code: result.code,
        message: "detail" in result && result.detail ? result.detail : approveRefusalMessage(result.code),
        ...(result.code === EMAIL_CARD_APPROVE_REQUIRED ? { open_in_zavi: emailCardLink("channel_actions", param.data.id, auth.tenant_id) } : {}),
      },
    });
    return;
  }
  const stampedVia = body.data.via && !result.alreadyQueued && !result.replayed ? await stampApprovedVia(auth.tenant_id, param.data.id, body.data.request_id, body.data.via) : false;
  if (result.alreadyQueued) {
    if (result.stillQueued) {
      try {
        await inngest.send({
          id: `approve:${param.data.id}:${result.attempt}`,
          name: "channel-action.approved",
          data: { action_id: param.data.id },
        });
      } catch (e) {
        console.warn(
          `[channel-actions] approve re-enqueue failed for ${param.data.id}: ${(e as Error).message}`,
        );
        res.status(502).json({
          error: { code: "enqueue_failed", message: "Approved, but the change could not be queued. Try again." },
        });
        return;
      }
    }
    res.json({ ok: true, exec_status: "queued", queued_by_another_click: true });
    return;
  }

  try {
    await inngest.send({
      id: `approve:${param.data.id}:${result.attempt}`,
      name: "channel-action.approved",
      data: { action_id: param.data.id },
    });
  } catch (e) {
    console.warn(`[channel-actions] approve enqueue failed for ${param.data.id}: ${(e as Error).message}`);
    res.status(502).json({
      error: { code: "enqueue_failed", message: "Approved, but the change could not be queued. Try again." },
    });
    return;
  }

  void logEvent({
    level: "info",
    source: "channel_actions.approve",
    code: "channel.action_approved",
    message: `approved an executable action (attempt ${result.attempt})${body.data.via ? ` via ${body.data.via}` : ""}`,
    tenant_id: auth.tenant_id,
    ...(stampedVia && body.data.via ? { meta: { approved_via: body.data.via } } : {}),
  });
  if (!result.replayed) trackResponse(auth, param.data.id, "approved");
  res.status(202).json({ ok: true, exec_status: "queued" });
}

export async function channelActionRedo(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (overridden(auth, res)) return;
  const param = IdParam.safeParse(req.params);
  if (!param.success) {
    res.status(400).json({ error: { code: "bad_action_id", message: "id must be a uuid" } });
    return;
  }
  const body = RedoBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "validation", message: plainValidationMessage(body.error) } });
    return;
  }

  let row: ActionRow | null;
  try {
    row = await readAction(auth, param.data.id);
  } catch (e) {
    res.status(500).json({ error: { code: "read_failed", message: "Could not read actions." } });
    return;
  }
  if (!row) {
    res.status(404).json({ error: { code: "not_found", message: "Action not found." } });
    return;
  }
  if (row.status !== "pending" && row.status !== "snoozed") {
    res.status(409).json({ error: { code: "not_open", message: "This card was already handled." } });
    return;
  }
  if (execInFlight(row)) {
    res.status(409).json({
      error: { code: "exec_in_flight", message: "This change is being applied. Wait for it to finish." },
    });
    return;
  }
  if (row.exec_class) {
    res.status(409).json({
      error: {
        code: "exec_action_use_revise",
        message:
          "This is an account change. Edit it with Revise, or decline it. Redo re-runs the whole recipe.",
      },
    });
    return;
  }
  if (actionsStoreFor(row.channel_slug) !== "channel_actions") {
    res.status(409).json({
      error: { code: "channel_not_switched", message: "This channel's actions are not redone here." },
    });
    return;
  }

  const planRefusal = await refuseIfChannelPlanLocked(auth.tenant_id, row.channel_slug);
  if (planRefusal) {
    res.status(403).json(planRefusal.body);
    return;
  }

  let redoKey: string;
  try {
    const attempt = await redoAttempt(auth, row.id);
    if (attempt.runInFlight) {
      res.status(409).json({
        error: { code: "redo_in_flight", message: "Zavi is already redoing this card with your earlier note. Wait for it to finish, then redo it again." },
      });
      return;
    }
    redoKey = attempt.key;
    await releaseAbandonedRedoClaim(auth, row.channel_slug, redoKey);
  } catch (e) {
    console.warn(`[channel-actions] redo key read failed for ${row.id}: ${(e as Error).message}`);
    res.status(500).json({ error: { code: "read_failed", message: "Could not check this action's runs." } });
    return;
  }

  const recorded = await tenantRpc(auth.tenant_id, "set_channel_action", {
    p_action_id: row.id,
    p_status: "redo_requested",
    p_note: body.data.note,
    p_snoozed_until: null,
    p_event_key: `redo_requested:${randomUUID()}`,
    p_actor_user_id: auth.user_id,
  });
  if (recorded.error) {
    console.warn(`[channel-actions] redo_requested event failed for ${row.id}: ${recorded.error.message}`);
    res.status(500).json({ error: { code: "write_failed", message: "Could not record that redo." } });
    return;
  }
  const recordedOut = (recorded.data ?? {}) as { ok?: boolean; code?: string };
  if (!recordedOut.ok) {
    res.status(channelActionErrorStatus(recordedOut.code)).json({
      error: { code: recordedOut.code ?? "refused", message: "That action can't be redone from here." },
    });
    return;
  }
  trackChannelActionResponded({
    tenant_id: auth.tenant_id,
    user_id: auth.user_id,
    channel_slug: row.channel_slug,
    response: "redo_requested",
  });

  let result;
  try {
    result = await runChannelRecipe(
      auth.tenant_id,
      row.channel_slug,
      {
        channelContext: defaultChannelContext,
        enqueue: async ({ slug, tenant_id, trigger, payload }) =>
          enqueueAgentRun({
            agent_slug: slug,
            tenant_id,
            trigger: trigger as "channel_recipe",
            payload,
          }),
      },
      {
        action_key: row.id,
        action_title: row.title,
        note: body.data.note,
        ...(body.data.kind ? { kind: body.data.kind } : {}),
        redo_of_action_id: row.id,
        origin_run_id: row.run_id,
        origin_position: row.position,
        origin_of: row.run_of,
      },
      undefined,
      redoKey,
    );
  } catch (e) {
    const planRefusal = asPlanUpgradeRequired(e);
    if (planRefusal) {
      res.status(403).json(planRefusal.body);
      return;
    }
    if (e instanceof InsufficientCreditsError) {
      res.status(402).json({ error: refusalFor({ kind: "credits" }) });
      return;
    }
    console.error(`[channel-actions] redo enqueue failed for ${row.id}: ${(e as Error).message}`);
    res.status(500).json({ error: { code: "redo_enqueue_failed", message: "Zavi could not start this redo. Try again in a minute." } });
    return;
  }
  if (!result.ok) {
    res.status(result.reason === "cap_reached" ? 429 : 409).json({
      error: { code: result.reason, message: result.message },
    });
    return;
  }

  if (result.duplicate) {
    res.status(202).json({ ok: true, run_id: result.run_id, redo_of_action_id: row.id, duplicate: true });
    return;
  }

  void logEvent({
    level: "info",
    source: "channel_actions.redo",
    code: "channel.action_redo_requested",
    message: `redo requested for ${row.channel_slug}`,
    tenant_id: auth.tenant_id,
    run_id: result.run_id,
  });
  res.status(202).json({ ok: true, run_id: result.run_id, redo_of_action_id: row.id });
}

export async function stampApprovedVia(tenantId: string, actionId: string, requestId: string, via: "mobile"): Promise<boolean> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("channel_action_events")
      .update({ note: `approved_via: ${via}` })
      .eq("action_id", actionId)
      .eq("event", "approved")
      .eq("event_key", requestId.trim().slice(0, 200))
      .is("note", null)
      .select("id");
    if (error) {
      console.warn(`[channel-actions] approved_via not stamped on ${actionId}: ${error.message}`);
      return false;
    }
    const n = ((data ?? []) as unknown[]).length;
    if (n !== 1) console.warn(`[channel-actions] approved_via stamped on ${n} events for ${actionId} (expected 1)`);
    return n === 1;
  } catch (e) {
    console.warn(`[channel-actions] approved_via not stamped on ${actionId}: ${(e as Error).message}`);
    return false;
  }
}
