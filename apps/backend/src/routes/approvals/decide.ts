
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { decideOnDecision, type DecideAction } from "@/services/approvals/decide-service";
import { decisionClosedElsewhere } from "@/services/approvals/decision-closed";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { captureAdminCorrection } from "@/services/staff/capture-admin-correction";
import {
  settleHumanApplicationDecision,
  HUMAN_APPLICATION_REVIEW_CLASS,
} from "@/services/humans/applications";

const DecisionIdParam = z.object({ decision_id: z.string().uuid() });

const DECIDE_SURFACES = new Set(["chat", "growth", "needs_you", "channel"]);
type DecideSurface = "chat" | "growth" | "needs_you" | "channel";
export function decideSurfaceOf(raw: unknown): DecideSurface | "other" {
  return typeof raw === "string" && DECIDE_SURFACES.has(raw) ? (raw as DecideSurface) : "other";
}

const RejectBody = z.object({
  reason: z.string().max(2000).optional(),
  refine: z.boolean().optional(),
});

const ApproveBody = z.object({
  business_controls: z.unknown().optional(),
  always_allow: z.boolean().optional(),
  ship_anyway: z.boolean().optional(),
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  image_path: z.string().max(250).optional(),
  payload_text: z.string().min(1).max(40_000).optional(),
  thread: z.array(z.string().min(1).max(280)).max(4).nullable().optional(),
  title: z.string().max(500).optional(),
  board_id: z.string().max(40).optional(),
  link: z.string().max(4096).optional(),
  confirm_unverified: z.boolean().optional(),
  expected_fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  expected_post_revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  expected_scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  email_variant: z.number().int().min(1).max(3).optional(),
  request_id: z.string().min(8).max(200).optional(),
  run_alone: z.boolean().optional(),
  raise_budget_to_usd: z.number().int().positive().max(9_999_900).optional(),
  raise_daily_limit_to_usd: z.number().int().positive().max(9_999_900).optional(),
});

const BUDGET_CHOICE_409 = new Set(["budget_choice_required", "budget_raise_changed", "budget_raise_failed", "budget_choice_in_zavi", "move_waits_on_cuts", "decision_closed", "card_changed"]);

async function handleDecide(req: Request, res: Response, action: DecideAction): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = DecisionIdParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_decision_id", message: "decision_id must be a UUID" },
    });
    return;
  }
  const decision_id = parsed.data.decision_id;

  const approveParsed =
    action === "approve" ? ApproveBody.safeParse(req.body ?? {}) : null;
  if (action === "approve" && req.body && typeof req.body === "object" && ["payload_text", "thread", "image_path", "title", "board_id", "link"].some((k) => Object.hasOwn(req.body, k)) && !approveParsed?.success) {
    const imageFailed = approveParsed?.error?.issues.some((i) => i.path[0] === "image_path");
    res.status(400).json({ error: { code: "invalid_edit", message: imageFailed ? "The selected image could not be applied. Review the post before approving." : "The edited post could not be applied. Review the post before approving." } }); return;
  }
  const always_allow =
    approveParsed?.success ? approveParsed.data.always_allow === true : false;
  const ship_anyway =
    approveParsed?.success ? approveParsed.data.ship_anyway === true : false;
  const scheduled_at = approveParsed?.success ? approveParsed.data.scheduled_at : undefined;
  const payload_edit =
    approveParsed?.success &&
    (approveParsed.data.payload_text !== undefined || approveParsed.data.thread !== undefined || approveParsed.data.image_path !== undefined || approveParsed.data.title !== undefined || approveParsed.data.board_id !== undefined || approveParsed.data.link !== undefined)
      ? {
          text: approveParsed.data.payload_text,
          thread: approveParsed.data.thread,
          image_path: approveParsed.data.image_path,
          ...(approveParsed.data.title !== undefined ? { title: approveParsed.data.title } : {}),
          ...(approveParsed.data.board_id !== undefined ? { board_id: approveParsed.data.board_id } : {}),
          ...(approveParsed.data.link !== undefined ? { link: approveParsed.data.link } : {}),
        }
      : undefined;
  const expected_fingerprint = approveParsed?.success ? approveParsed.data.expected_fingerprint : undefined;
  const expected_scheduled_at = approveParsed?.success ? approveParsed.data.expected_scheduled_at : undefined;

  const result = await decideOnDecision({
    decision_id,
    tenant_id: auth.tenant_id,
    action,
    actor: { user_id: auth.user_id },
    always_allow,
    ship_anyway,
    scheduled_at,
    payload_edit,
    expected_fingerprint,
    expected_post_revision: approveParsed?.success ? approveParsed.data.expected_post_revision : undefined,
    expected_scheduled_at,
    email_variant: approveParsed?.success ? approveParsed.data.email_variant : undefined,
    request_id: approveParsed?.success ? approveParsed.data.request_id : undefined,
    business_controls: auth.tenant_overridden ? undefined : approveParsed?.success ? approveParsed.data.business_controls : undefined,
    run_alone: !auth.tenant_overridden && approveParsed?.success && approveParsed.data.run_alone === true,
    offer_run_alone: !auth.tenant_overridden,
    surface: auth.tenant_overridden ? undefined : "web",
    raise_budget_to_usd: !auth.tenant_overridden && approveParsed?.success ? approveParsed.data.raise_budget_to_usd : undefined,
    raise_daily_limit_to_usd: !auth.tenant_overridden && approveParsed?.success ? approveParsed.data.raise_daily_limit_to_usd : undefined,
    confirm_unverified: approveParsed?.success ? approveParsed.data.confirm_unverified === true : false,
  });

  void logEvent({
    level: result.ok ? "info" : "warn",
    source: "routes/approvals/decide",
    code: "approvals.decide_outcome",
    tenant_id: auth.tenant_id,
    meta: {
      surface: decideSurfaceOf((req.query as Record<string, unknown> | undefined)?.surface),
      decision_class: result.decision_class ?? "unknown",
      outcome: result.code,
      changed: result.changed === true,
      op: action,
    },
  });

  if (!result.ok) {
    if (result.code === "not_found" || result.code === "cross_tenant") {
      res.status(404).json({ error: { code: "decision_not_found", message: "decision not found" } });
      return;
    }
    if (result.code === "not_member") {
      res.status(403).json({ error: { code: "not_member", message: "not a member of tenant" } });
      return;
    }
    if (result.code === "invalid_edit") {
      res.status(400).json({
        error: { code: "invalid_edit", message: result.detail ?? "The edited post is not valid for this channel." },
      });
      return;
    }
    if (result.code === "stale_card") {
      res.status(409).json({
        error: { code: "stale_card", message: result.detail ?? "This card changed. Reload it and review again." },
      });
      return;
    }
    if (result.code === "paired_move_waits") {
      res.status(409).json({
        error: {
          code: "paired_move_waits",
          message: result.detail ?? "Approve the matching cut first.",
          ...(result.run_alone ? { run_alone: result.run_alone } : {}),
        },
      });
      return;
    }
    if (BUDGET_CHOICE_409.has(result.code) || result.code === "budget_unreadable") {
      res.status(result.code === "budget_unreadable" ? 503 : 409).json({
        error: { code: result.code, message: result.detail ?? "Nothing was approved.", budget_choice: result.budget_choice ?? null },
      });
      return;
    }
    if (result.code === "email_card_required") {
      res.status(409).json({
        error: { code: result.email_card_code ?? "email_card_required", message: result.detail ?? "Approve this email from its email card.", open_in_zavi: result.open_in_zavi ?? null },
      });
      return;
    }
    if (result.code === "schedule_changed") {
      res.status(409).json({
        error: {
          code: "schedule_changed",
          message: "This post was moved to another time. Review the new time and approve again.",
          current_scheduled_at: result.current_scheduled_at ?? null,
        },
      });
      return;
    }
    if (result.code === "requires_unverified_confirm") {
      res.status(409).json({
        error: { code: "requires_unverified_confirm", message: result.detail ?? "Zavi could not check everything on this pin.", unverified: result.unverified ?? [] },
      });
      return;
    }
    if (result.code === "requires_ship_red_override") {
      res.status(409).json({
        error: {
          code: "requires_ship_red_override",
          message:
            "This change broke a test that was passing on the base branch. Confirm you want to open the PR anyway to approve it.",
        },
      });
      return;
    }
    if (result.code === "plan_required" && result.plan_refusal) {
      res.status(result.plan_refusal.status).json(result.plan_refusal.body);
      return;
    }
    if (result.code === "plan_required") {
      res.status(403).json({ error: { code: result.code, message: result.detail } });
      return;
    }
    if (result.code === "not_authorized") {
      res.status(403).json({
        error: {
          code: "not_authorized",
          message: "approving this action requires an owner or admin role",
        },
      });
      return;
    }
    res.status(500).json({
      error: { code: `${action}_failed`, message: "decision update failed" },
    });
    return;
  }

  if (action === "reject" && result.changed) {
    try {
      const reasonParsed = RejectBody.safeParse(req.body ?? {});
      const isRefine = reasonParsed.success ? reasonParsed.data.refine === true : false;
      const reason = reasonParsed.success ? reasonParsed.data.reason ?? null : null;
      if (!isRefine) {
        const { data: dec } = await serviceClient()
          .from("decisions")
          .select("decision_class")
          .eq("id", decision_id)
          .eq("tenant_id", auth.tenant_id)
          .maybeSingle();
        const decision_class = (dec as { decision_class?: string } | null)?.decision_class;
        if (decision_class) {
          await captureAdminCorrection({
            tenant_id: auth.tenant_id,
            decision_id,
            decision_class,
            actor: { user_id: auth.user_id },
            actor_kind: "customer",
            action: "reject",
            reason,
          });
        }
      }
    } catch (e) {
      console.warn(
        `[approvals/decide] customer-correction capture failed (decision ${decision_id}): ${(e as Error)?.message ?? e}`,
      );
    }
  }

  let human_settled: boolean | undefined;
  if (result.decision_class === HUMAN_APPLICATION_REVIEW_CLASS) {
    try {
      const settled = await settleHumanApplicationDecision({
        decision_id,
        tenant_id: auth.tenant_id,
        action,
      });
      human_settled = settled.handled
        ? action === "reject" || settled.engagement_id !== null
        : false;
    } catch (e) {
      human_settled = false;
      console.warn(
        `[approvals/decide] human settle failed (decision ${decision_id}): ${(e as Error)?.message ?? e}`,
      );
    }
  }

  const closed = decisionClosedElsewhere(action, result);
  if (closed) {
    res.status(409).json({ error: { code: "decision_closed", message: closed, status: result.status } });
    return;
  }

  res.json({
    ok: true,
    decision_id,
    allowlisted: result.allowlisted,
    ...(human_settled === undefined ? {} : { human_settled }),
  });
}

export async function approvalsApprove(req: Request, res: Response): Promise<void> {
  await handleDecide(req, res, "approve");
}

export async function approvalsReject(req: Request, res: Response): Promise<void> {
  await handleDecide(req, res, "reject");
}
