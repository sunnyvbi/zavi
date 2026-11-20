
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { canUserAccessAgent } from "@/services/auth/members";
import { ensureAgentRunnable } from "@/services/agents/ensure-runnable";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { inngest } from "@/../workers/client";
import { buildRunRequestedEvent } from "@/services/agents/run-lane";
import { resolveDecisionReviser } from "@/services/decisions/reviser";
import { revisionPrompt } from "@/services/decisions/revision-copy";

const DECISION_ID_PARAM = z.object({ decision_id: z.string().uuid() });
const BODY = z.object({
  message: z.string().trim().min(3).max(2000),
});

const REVISABLE_PREFIXES = ["meta_ads.", "google_ads."] as const;
const REVISABLE_CLASSES = new Set(["channel.recipe_step"]);

type DecisionRow = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown> | null;
  status: string;
};

function buildRevisionPayload(decision: DecisionRow, revisionId: string, message: string) {
  return {
    revision_request_id: revisionId,
    revises_decision_id: decision.id,
    original_decision_class: decision.decision_class,
    original_handler: decision.handler,
    original_body: decision.body ?? {},
    operator_requested_change: message,
    instruction:
      "Do not execute. If a change is warranted, emit a revised Meta proposal through the normal proposal path. If not, explain why.",
  };
}

async function isChannelActionId(tenantId: string, id: string): Promise<boolean> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("channel_actions")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    return !error && !!data;
  } catch {
    return false;
  }
}

async function latestThreadIdForDecision(decision: DecisionRow): Promise<string | null> {
  if (!decision.agent_run_id) return null;
  const { data } = await serviceClient()
    .from("agent_runs")
    .select("payload")
    .eq("id", decision.agent_run_id)
    .eq("tenant_id", decision.tenant_id)
    .maybeSingle();
  const payload = (data?.payload ?? {}) as { thread_id?: unknown };
  return typeof payload.thread_id === "string" ? payload.thread_id : null;
}

export async function approvalsRevisionRequest(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const param = DECISION_ID_PARAM.safeParse(req.params);
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

  const decisionId = param.data.decision_id;
  const sb = serviceClient();
  const { data: decisionData, error: decisionErr } = await sb
    .from("decisions")
    .select("id, tenant_id, agent_run_id, decision_class, handler, body, status")
    .eq("id", decisionId)
    .maybeSingle();

  if (decisionErr) {
    res.status(500).json({ error: { code: "decision_read_failed", message: decisionErr.message } });
    return;
  }
  if (!decisionData || (decisionData as DecisionRow).tenant_id !== auth.tenant_id) {
    if (await isChannelActionId(auth.tenant_id, decisionId)) {
      res.status(409).json({
        error: {
          code: "wrong_store",
          message:
            "This action lives in the channel_actions store, which this route cannot revise. Ask its channel to redo it: POST /api/channel-actions/:id/redo.",
          action_source: "channel_action",
        },
      });
      return;
    }
    res.status(404).json({ error: { code: "decision_not_found", message: "decision not found" } });
    return;
  }

  const decision = decisionData as DecisionRow;
  if (decision.status !== "proposed") {
    res.status(409).json({
      error: { code: "not_proposed", message: `decision is ${decision.status}` },
    });
    return;
  }
  const revisable =
    REVISABLE_PREFIXES.some((p) => decision.decision_class.startsWith(p)) ||
    REVISABLE_CLASSES.has(decision.decision_class);
  if (!revisable) {
    res.status(400).json({
      error: { code: "unsupported_decision_class", message: "this decision type cannot be revised" },
    });
    return;
  }

  const reviser = await resolveDecisionReviser(sb, decision);
  if (!reviser.ok) {
    res.status(reviser.status).json({ error: { code: reviser.code, message: reviser.message } });
    return;
  }
  const AGENT_SLUG = reviser.slug;

  const allowed = await canUserAccessAgent(sb, auth.user_id, auth.tenant_id, AGENT_SLUG);
  if (!allowed) {
    res.status(403).json({
      error: { code: "agent_not_allowed", message: "Your role is read-only. Ask a workspace admin to make you a member." },
    });
    return;
  }
  const runnable = await ensureAgentRunnable(auth.tenant_id, AGENT_SLUG, {
    origin: REVISABLE_CLASSES.has(decision.decision_class) ? "channel" : "standard",
  });
  if (!runnable.runnable) {
    res.status(runnable.reason === "not_found" ? 404 : 403).json({
      error: { code: runnable.reason, message: runnable.detail },
    });
    return;
  }

  const { count, error: activeErr } = await sb
    .from("decision_revision_requests")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", auth.tenant_id)
    .eq("decision_id", decisionId)
    .in("status", ["requested", "running"]);
  if (activeErr) {
    res.status(500).json({ error: { code: "revision_check_failed", message: activeErr.message } });
    return;
  }
  if ((count ?? 0) > 0) {
    res.status(409).json({
      error: { code: "revision_in_flight", message: "a revision request is already in flight" },
    });
    return;
  }

  const message = parsedBody.data.message;
  const { data: revisionData, error: revisionErr } = await sb
    .from("decision_revision_requests")
    .insert({
      tenant_id: auth.tenant_id,
      decision_id: decisionId,
      agent_slug: AGENT_SLUG,
      status: "requested",
      message,
      original_decision_class: decision.decision_class,
      original_handler: decision.handler,
      original_body: decision.body ?? {},
      created_by: auth.user_id,
    })
    .select("id, status, message, created_at")
    .single();
  if (revisionErr || !revisionData) {
    if (revisionErr?.code === "23505") {
      res.status(409).json({
        error: { code: "revision_in_flight", message: "a revision request is already in flight" },
      });
      return;
    }
    res.status(500).json({
      error: { code: "revision_insert_failed", message: revisionErr?.message ?? "no row" },
    });
    return;
  }

  const revision = revisionData as { id: string; status: string; message: string; created_at: string };
  const threadId = await latestThreadIdForDecision(decision);
  const visibleMessage = revisionPrompt(decision, message);
  const authed = serverClientFromBearer(auth.access_token);
  const { data: turnData, error: turnErr } = await authed.rpc("send_agent_chat_turn", {
    p_agent_slug: AGENT_SLUG,
    p_agent_hash: runnable.agent.content_hash,
    p_message: visibleMessage,
    p_thread_id: threadId,
  });
  if (turnErr || !turnData?.[0]) {
    await sb
      .from("decision_revision_requests")
      .update({ status: "failed", last_error: turnErr?.message ?? "send_agent_chat_turn returned no row" })
      .eq("id", revision.id)
      .eq("tenant_id", auth.tenant_id);
    res.status(500).json({
      error: { code: "chat_enqueue_failed", message: turnErr?.message ?? "no row" },
    });
    return;
  }

  const turn = turnData[0] as { thread_id: string; user_message_id: string; run_id: string };
  const { data: existingRun } = await sb
    .from("agent_runs")
    .select("payload")
    .eq("id", turn.run_id)
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle();
  const prevPayload = (existingRun?.payload as Record<string, unknown> | null) ?? {};
  const { error: payloadErr } = await sb
    .from("agent_runs")
    .update({
      payload: {
        ...prevPayload,
        revision_request: buildRevisionPayload(decision, revision.id, message),
      },
    })
    .eq("id", turn.run_id)
    .eq("tenant_id", auth.tenant_id);
  if (payloadErr) {
    await sb
      .from("decision_revision_requests")
      .update({ status: "failed", last_error: payloadErr.message })
      .eq("id", revision.id)
      .eq("tenant_id", auth.tenant_id);
    res.status(500).json({ error: { code: "payload_patch_failed", message: payloadErr.message } });
    return;
  }

  await sb
    .from("decision_revision_requests")
    .update({
      status: "running",
      thread_id: turn.thread_id,
      user_message_id: turn.user_message_id,
      agent_run_id: turn.run_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", revision.id)
    .eq("tenant_id", auth.tenant_id);

  inngest
    .send(
      buildRunRequestedEvent({
        run_id: turn.run_id,
        tenant_id: auth.tenant_id,
        agent_slug: AGENT_SLUG,
        trigger: "chat",
        batch_id: null,
      }),
    )
    .catch((e: unknown) => {
      console.warn(
        "inngest.send failed for revision run",
        turn.run_id,
        (e as Error).message,
      );
    });

  res.status(202).json({
    ok: true,
    revision: {
      ...revision,
      status: "running",
      thread_id: turn.thread_id,
      user_message_id: turn.user_message_id,
      agent_run_id: turn.run_id,
    },
  });
}
