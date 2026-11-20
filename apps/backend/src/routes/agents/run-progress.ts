
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { buildRunPanel, type RunActivityRow, type RunPanelState } from "@zavi/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_EVENTS = 200;

const PANEL_KINDS = ["plan", "reasoning", "tool_call", "file_read", "file_edit", "file_create"];

function panelStateOf(status: string | null | undefined): RunPanelState {
  if (status === "queued" || status === "running" || !status) return "running";
  if (status === "cancelled") return "stopped";
  return status === "success" ? "finished" : "failed";
}

export async function agentRunProgress(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const runId = req.params.run_id;
  if (typeof runId !== "string" || !UUID_RE.test(runId)) {
    res.status(400).json({ error: { code: "bad_request", message: "run_id must be a uuid" } });
    return;
  }

  const sb = tenantClient(asTenantId(auth.tenant_id));

  const { data: runRows, error: runErr } = await sb
    .from("agent_runs")
    .select("id, status, actor_user_id")
    .eq("id", runId)
    .limit(1);
  if (runErr) {
    res.status(500).json({ error: { code: "run_read_failed", message: runErr.message } });
    return;
  }
  const run = runRows?.[0] as { status?: string; actor_user_id?: string | null } | undefined;
  if (!run || run.actor_user_id !== auth.user_id) {
    res.status(404).json({ error: { code: "not_found", message: "No such run." } });
    return;
  }

  const state = panelStateOf(run.status);

  const { data: eventRows, error: evErr } = await sb
    .from("thread_event")
    .select("id, kind, body")
    .eq("agent_run_id", runId)
    .in("kind", PANEL_KINDS)
    .order("id", { ascending: false })
    .limit(MAX_EVENTS);
  if (evErr) {
    res.status(200).json({ status: run.status ?? "running", ...buildRunPanel([], { state }) });
    return;
  }

  const chronological: RunActivityRow[] = ((eventRows ?? []) as Array<{
    id: number;
    kind: string;
    body: Record<string, unknown> | null;
  }>)
    .slice()
    .reverse()
    .map((r) => ({ id: String(r.id), kind: r.kind, body: r.body ?? {} }));

  res
    .status(200)
    .json({ status: run.status ?? "running", ...buildRunPanel(chronological, { state }) });
}
