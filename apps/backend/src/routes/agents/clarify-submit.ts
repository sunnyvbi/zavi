
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import { loadAgentDefinition } from "@/services/agents/registry";
import { inngest } from "@/../workers/client";
import { buildRunRequestedEvent } from "@/services/agents/run-lane";
import { planUpgradeErrorBody, refreshPlanWallFacts, requiredTierFromDbError } from "@/services/agents/entitlement";
import { isPlanUpgradeError } from "@/services/billing/tiers";

const bodySchema = z.object({
  request_id: z.string().uuid(),
  answers: z.array(z.unknown()).max(50),
});

export async function agentClarifySubmit(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const slug = req.params.slug;
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "invalid body" },
    });
    return;
  }

  const def = await loadAgentDefinition(slug, auth.tenant_id);
  if (!def) {
    res.status(404).json({ error: { code: "unknown_agent", message: `no agent ${slug}` } });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("submit_clarification_response", {
    p_request_id: parsed.data.request_id,
    p_agent_hash: def.content_hash,
    p_answers: parsed.data.answers,
  });
  if (error || !data?.[0]) {
    const code = error?.code;
    const msg = error?.message ?? "";
    if (isPlanUpgradeError(error)) {
      const required = requiredTierFromDbError(error);
      await refreshPlanWallFacts();
      res.status(403).json(planUpgradeErrorBody(slug, required));
      return;
    }
    let status: number;
    if (code === "42501") status = 403;
    else if (code === "22023")
      status = /already (consumed|in progress)/i.test(msg) ? 409 : 400;
    else status = 500;
    res.status(status).json({
      error: { code: code ?? "rpc_failed", message: msg || "no row" },
    });
    return;
  }

  const { run_id, agent_slug, thread_id } = data[0] as {
    run_id: string;
    agent_slug: string;
    thread_id: string;
  };

  let shouldDispatch = true;
  {
    const sb = serviceClient();
    const { data: inflight, error: inflightErr } = await sb
      .from("agent_runs")
      .select("id")
      .eq("tenant_id", auth.tenant_id)
      .filter("payload->>thread_id", "eq", thread_id)
      .eq("trigger", "chat")
      .in("status", ["queued", "running"])
      .neq("id", run_id)
      .order("enqueued_at", { ascending: true })
      .limit(1);
    if (inflightErr) {
      console.warn(
        `[clarify-submit] serialization in-flight check failed (thread=${thread_id}): ${inflightErr.message}`,
      );
    } else if (inflight && inflight.length > 0) {
      const blockedBy = (inflight[0] as { id: string }).id;
      const { error: blockErr } = await sb
        .from("agent_runs")
        .update({ status: "blocked", blocked_by_run_id: blockedBy })
        .eq("id", run_id)
        .eq("tenant_id", auth.tenant_id)
        .eq("status", "queued");
      if (blockErr) {
        console.warn(
          `[clarify-submit] mark-blocked failed (run=${run_id}); dispatching normally: ${blockErr.message}`,
        );
      } else {
        shouldDispatch = false;
      }
    }
  }

  if (shouldDispatch) {
    inngest
      .send(
        buildRunRequestedEvent({
          run_id,
          tenant_id: auth.tenant_id,
          agent_slug,
          trigger: "chat",
          batch_id: null,
        }),
      )
      .catch((e: unknown) => {
        console.warn(
          "inngest.send failed for clarify-submit run",
          run_id,
          (e as Error).message,
        );
      });
  }

  res.status(202).json({ run_id, thread_id, agent_slug });
}
