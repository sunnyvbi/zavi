
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { getAgentRunById } from "@/services/agents/runner";
import { canUserAccessAgentRun } from "@/services/auth/members";
import { serviceClient } from "@/services/supabase";
import { requestStopForRun } from "@/services/agents/request-stop";

const IN_FLIGHT = new Set(["queued", "running"]);

export async function agentRunCancel(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const run_id = String(req.params.run_id ?? req.params.id ?? "").trim();
  if (!run_id || run_id.length > 128) {
    res.status(400).json({ error: { code: "bad_request", message: "run id is required" } });
    return;
  }

  try {
    const run = await getAgentRunById(auth.tenant_id, run_id);
    if (!run) {
      res.status(404).json({ error: { code: "not_found", message: `run ${run_id} not found` } });
      return;
    }

    const allowed = await canUserAccessAgentRun(serviceClient(), auth.user_id, run_id);
    if (!allowed) {
      res.status(404).json({ error: { code: "not_found", message: `run ${run_id} not found` } });
      return;
    }

    if (!IN_FLIGHT.has(run.status as string)) {
      res.json({ ok: true, already_terminal: true, status: run.status });
      return;
    }

    const stop = await requestStopForRun(serviceClient(), auth.tenant_id, run_id);
    if (!stop.ok) {
      res.status(500).json({ error: { code: "cancel_failed", message: stop.error } });
      return;
    }
    if ("already_terminal" in stop) {
      res.json({ ok: true, already_terminal: true, status: run.status });
      return;
    }
    res.json({ ok: true, cancelling: true });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}
