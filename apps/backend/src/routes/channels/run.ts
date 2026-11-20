
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { runChannelRecipe, type ChannelRedo } from "@/services/channels/engine";
import type { TopActionPayload } from "@/services/channels/top-actions";
import { defaultChannelContext } from "@/services/channels/context";
import { enqueueAgentRun, InsufficientCreditsError } from "@/services/agents/runner";
import { asPlanUpgradeRequired } from "@/services/billing/tiers";
import { refusalFor } from "@/services/agents/refusal";
import { logEvent } from "@/services/logging/logEvent";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

export const RUN_NOW_LANE = "run_now";

const SlugParam = z.object({ slug: z.string().min(1).max(64) });

const RunBody = z.object({
  request_id: z.string().trim().min(8).max(200).optional(),
});

export async function channelRun(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = SlugParam.safeParse(req.params);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { code: "bad_slug", message: "slug is required" } });
    return;
  }

  const body = RunBody.safeParse(req.body ?? {});
  if (!body.success) {
    res
      .status(400)
      .json({ error: { code: "validation", message: z.prettifyError(body.error) } });
    return;
  }

  await startChannelRun(res, auth, parsed.data.slug, {
    requestId: body.data.request_id,
    joinLane: RUN_NOW_LANE,
  });
}

export async function startChannelRun(
  res: Response,
  auth: NonNullable<Awaited<ReturnType<typeof requireAuth>>>,
  channelSlug: string,
  opts: {
    requestId?: string;
    extra?: Record<string, unknown>;
    topAction?: TopActionPayload;
    redo?: ChannelRedo;
    joinLane?: string;
  } = {},
): Promise<void> {
  let result;
  try {
    result = await runChannelRecipe(
      auth.tenant_id,
      channelSlug,
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
      opts.redo,
      opts.extra,
      opts.requestId,
      undefined,
      opts.topAction,
      opts.joinLane,
    );
  } catch (e) {
    const planRefusal = asPlanUpgradeRequired(e);
    if (planRefusal) {
    void notifyFounderActivity({
      event: "plan_upgrade_required",
      tenant_id: auth.tenant_id,
      user_id: auth.user_id,
      details: { refused: "plan_upgrade_required", channel: channelSlug, where: "channel run" },
    });
      res.status(403).json(planRefusal.body);
      return;
    }
    if (e instanceof InsufficientCreditsError) {
    void notifyFounderActivity({
      event: "out_of_credits",
      tenant_id: auth.tenant_id,
      user_id: auth.user_id,
      details: { refused: "insufficient_credits", channel: channelSlug, where: "channel run" },
    });

      res.status(402).json({ error: refusalFor({ kind: "credits" }) });
      return;
    }
    const message = (e as Error).message ?? "enqueue failed";
    console.error(`[channels/run] ${channelSlug}: ${message}`);
    res.status(500).json({ error: { code: "enqueue_failed", message: "Zavi couldn't start this one. Try again in a minute." } });
    return;
  }

  if (!result.ok) {
    const status =
      result.reason === "cap_reached"
        ? 402
        : result.reason === "coming_soon" || result.reason === "retired" || result.reason === "founder_stopped"
          ? 409
          : 400;
    res.status(status).json({
      error: { code: result.reason, message: result.message },
    });
    return;
  }

  if (!result.stamped) {
    void logEvent({
      level: "warn",
      source: "channels.run",
      code: "channel.stamp_failed",
      message: result.stamp_error ?? "stamp_channel_run did not confirm",
      tenant_id: auth.tenant_id,
      run_id: result.run_id,
      meta: { channel_slug: result.channel_slug },
    });
  }
  if (!result.duplicate) {
    void notifyFounderActivity({
      event: "first_channel_run",
      tenant_id: auth.tenant_id,
      user_id: auth.user_id,
      details: { channel: result.channel_slug, run_id: result.run_id },
    });
  }
  res.json({
    ok: true,
    run_id: result.run_id,
    stamped: result.stamped,
    duplicate: result.duplicate === true,
  });
}
