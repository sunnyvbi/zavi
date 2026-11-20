
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { getAgentRunById } from "@/services/agents/runner";
import { canUserAccessAgentRun } from "@/services/auth/members";
import { serviceClient } from "@/services/supabase";
import { redactStaffOnlyPayload } from "@/services/agents/redact-payload";
import { readMemoryStatus } from "@/services/onboarding/background-memory";

export async function agentRunStatus(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const run_id = req.params.run_id;
  try {
    const run = await getAgentRunById(auth.tenant_id, run_id);
    if (!run) {
      res.status(404).json({ error: { code: "not_found", message: `run ${run_id} not found` } });
      return;
    }
    const allowed = await canUserAccessAgentRun(
      serviceClient(),
      auth.user_id,
      run_id,
      { read: true },
    );
    if (!allowed) {
      res.status(404).json({ error: { code: "not_found", message: `run ${run_id} not found` } });
      return;
    }

    let queue_position: number | null = null;
    let queue_ahead: number | null = null;
    if ((run.status as string) === "queued" && run.started_at) {
      try {
        const { count } = await serviceClient()
          .from("agent_runs")
          .select("id", { count: "exact", head: true })
          .in("status", ["queued", "running"])
          .lte("enqueued_at", run.started_at);
        if (typeof count === "number" && count >= 1) {
          queue_position = count;
          queue_ahead = count - 1;
        }
      } catch {
      }
    }
    let waiting_on: "memory" | undefined;
    if ((run.status as string) === "queued") {
      try {
        if ((await readMemoryStatus(auth.tenant_id)) === "pending") {
          waiting_on = "memory";
        }
      } catch {
      }
    }
    res.json({
      run: redactStaffOnlyPayload(run),
      queue_position,
      queue_ahead,
      ...(waiting_on ? { waiting_on } : {}),
    });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}
