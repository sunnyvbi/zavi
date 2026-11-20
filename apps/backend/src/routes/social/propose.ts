
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { tenantRpc } from "@/services/tenant-client";
import {
  IMAGE_PATH_RE,
  VIDEO_PATH_RE,
  resolveChannelAction,
  validateChannelPayload,
} from "@/services/connectors/social-channels";
import { resolvePinterestPublishReadiness, type PinterestReadiness } from "@/services/connectors/pinterest-composio/readiness";
import { findRedditTwin } from "@/services/connectors/reddit-social/duplicate";
import { refuseIfSocialPostPlanLocked } from "@/routes/approvals/decision-channel";

const SOCIAL_PUBLISH_CLASS = "social.publish.v2";
const DEFINITIVE_EMIT_REFUSALS = new Set(["22P02", "23502", "23503", "23505", "23514", "P0001", "PGRST000", "PGRST002", "PGRST003"]);

function isDefinitiveRpcRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && DEFINITIVE_EMIT_REFUSALS.has(code);
}

const proposeBodySchema = z.object({
  channel: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
});

const MEDIA_KEYS: Array<{ key: "image_path" | "video_path"; re: RegExp }> = [
  { key: "image_path", re: IMAGE_PATH_RE },
  { key: "video_path", re: VIDEO_PATH_RE },
];

function assertImagePathOwned(
  tenantId: string,
  payload: Record<string, unknown>,
): string | null {
  const expectedPrefix = `${tenantId}/`;
  for (const { key, re } of MEDIA_KEYS) {
    const path = payload[key];
    if (path === undefined) continue;
    if (typeof path !== "string") {
      return `${key} must be a string`;
    }
    if (!path.startsWith(expectedPrefix) || !re.test(path)) {
      return `${key} not owned by tenant or malformed`;
    }
  }
  return null;
}

export async function socialPropose(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = proposeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "invalid_body",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
    });
    return;
  }

  const { channel, payload, scheduled_at } = parsed.data;

  try {
    resolveChannelAction(channel);
  } catch (e) {
    res.status(400).json({
      error: { code: "invalid_channel", message: (e as Error).message },
    });
    return;
  }

  const planRefusal = await refuseIfSocialPostPlanLocked(auth.tenant_id, channel);
  if (planRefusal) {
    res.status(403).json(planRefusal.body);
    return;
  }

  const pathErr = assertImagePathOwned(auth.tenant_id, payload);
  if (pathErr) {
    res.status(403).json({
      error: { code: "path_not_owned", message: pathErr },
    });
    return;
  }

  let validatedPayload: Record<string, unknown>;
  try {
    validatedPayload = validateChannelPayload(channel, payload) as Record<
      string,
      unknown
    >;
  } catch (e) {
    res.status(400).json({
      error: {
        code: "invalid_payload",
        message: (e as Error).message.slice(0, 500),
      },
    });
    return;
  }

  let readiness: PinterestReadiness | null = null;
  if (channel === "pinterest_pin") {
    readiness = await resolvePinterestPublishReadiness(auth.tenant_id, {
      board_id: String(validatedPayload.board_id),
      image_path: String(validatedPayload.image_path),
      link: String(validatedPayload.link),
    });
    if (!readiness.ok || !readiness.board) {
      res.locals.idempotencyRelease = true;
      res.status(422).json({
        error: {
          code: readiness.reason_code ?? "pinterest_lookup_failed",
          message: readiness.reason ?? "Zavi could not confirm the Pinterest board.",
        },
        readiness,
      });
      return;
    }
    validatedPayload = { ...validatedPayload, board_name: readiness.board.name };
  }

  try {
    const twin = await findRedditTwin(auth.tenant_id, channel, validatedPayload);
    if (twin) {
      res.json({ ok: true, decision_id: twin.id, channel, existing: true, status: twin.status });
      return;
    }
  } catch {
    res.status(503).json({
      error: { code: "duplicate_check_failed", message: "Zavi could not check whether this was already posted. Try again." },
    });
    return;
  }

  const body = {
    channel,
    payload: validatedPayload,
    scheduled_at: scheduled_at ?? null,
    origin: "user_initiated_composer" as const,
    ...(readiness ? { readiness } : {}),
  };

  try {
    const { data, error } = await tenantRpc(auth.tenant_id, "emit_decision", {
      p_agent_run_id: null,
      p_decision_class: SOCIAL_PUBLISH_CLASS,
      p_body: body as object,
    });
    if (error) {
      if (isDefinitiveRpcRefusal(error)) res.locals.idempotencyRelease = true;
      res.status(500).json({
        error: { code: "emit_failed", message: "Couldn't stage the post." },
      });
      return;
    }
    res.json({
      ok: true,
      decision_id: data as string,
      channel,
    });
  } catch (e) {
    res.status(500).json({
      error: {
        code: "emit_failed",
        message: `Couldn't stage the post (${(e as Error).message}).`,
      },
    });
  }
}
