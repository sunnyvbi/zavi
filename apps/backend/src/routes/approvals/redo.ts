
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { runChannelRecipe } from "@/services/channels/engine";
import { defaultChannelContext } from "@/services/channels/context";
import { enqueueAgentRun } from "@/services/agents/runner";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";

const PARAM = z.object({ decision_id: z.string().uuid() });
const BODY = z.object({ message: z.string().trim().min(3).max(2000) });

const REDOABLE_CLASSES = new Set(["channel.recipe_step"]);

type DecisionRow = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  decision_class: string;
  body: Record<string, unknown> | null;
  status: string;
};

export async function approvalsRedoRequest(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const param = PARAM.safeParse(req.params);
  if (!param.success) {
    res.status(400).json({
      error: { code: "invalid_decision_id", message: "decision_id must be a UUID" },
    });
    return;
  }
  const parsedBody = BODY.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    res.status(400).json({
      error: { code: "validation", message: parsedBody.error.message },
    });
    return;
  }

  const sb = tenantClient(asTenantId(auth.tenant_id));
  const { data, error } = await sb
    .from("decisions")
    .select("id, tenant_id, agent_run_id, decision_class, body, status")
    .eq("id", param.data.decision_id)
    .maybeSingle();

  if (error) {
    res.status(500).json({
      error: { code: "decision_read_failed", message: error.message },
    });
    return;
  }
  if (!data || (data as DecisionRow).tenant_id !== auth.tenant_id) {
    res.status(404).json({
      error: { code: "decision_not_found", message: "decision not found" },
    });
    return;
  }

  const decision = data as DecisionRow;
  if (!REDOABLE_CLASSES.has(decision.decision_class)) {
    res.status(400).json({
      error: {
        code: "unsupported_decision_class",
        message: "this decision type cannot be redone",
      },
    });
    return;
  }
  if (decision.status !== "proposed") {
    res.status(409).json({
      error: { code: "not_proposed", message: `decision is ${decision.status}` },
    });
    return;
  }

  const { data: originRun } = await sb
    .from("agent_runs")
    .select("channel_slug")
    .eq("id", decision.agent_run_id ?? "")
    .maybeSingle<{ channel_slug: string | null }>();

  const channelSlug = originRun?.channel_slug ?? null;
  if (!channelSlug) {
    res.status(409).json({
      error: {
        code: "no_channel",
        message: "this action did not come from a channel run, so it cannot be redone",
      },
    });
    return;
  }

  const body = decision.body ?? {};
  const step = body.step as { title?: unknown } | undefined;
  const actionTitle =
    typeof step?.title === "string" && step.title.trim()
      ? step.title.trim()
      : "this action";
  const actionKey =
    typeof body.action_key === "string" ? body.action_key : decision.id;

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
      {
        action_key: actionKey,
        action_title: actionTitle,
        note: parsedBody.data.message,
        redo_of_decision_id: decision.id,
        origin_run_id: decision.agent_run_id,
        origin_position:
          typeof body.position === "number" ? body.position : null,
        origin_of: typeof body.of === "number" ? body.of : null,
      },
    );
  } catch (e) {
    res.status(500).json({
      error: { code: "redo_enqueue_failed", message: (e as Error).message },
    });
    return;
  }

  if (!result.ok) {
    const status = result.reason === "cap_reached" ? 429 : 409;
    res.status(status).json({
      error: { code: result.reason, message: result.message },
    });
    return;
  }

  void logEvent({
    level: "info",
    source: "approvals.redo",
    code: "channel.action_redo_requested",
    message: `redo requested for ${channelSlug}`,
    tenant_id: auth.tenant_id,
    run_id: result.run_id,
  });

  res.status(202).json({
    ok: true,
    run_id: result.run_id,
    redo_of_decision_id: decision.id,
  });
}
