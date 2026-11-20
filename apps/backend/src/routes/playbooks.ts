
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { enqueueAgentRun } from "@/services/agents/runner";
import { PLAYBOOKS, getPlaybook } from "@/playbooks";
import { summarizeTrail, type TrailDecisionRow } from "@/playbooks/trail";

export async function getPlaybooks(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  res.json({ playbooks: PLAYBOOKS });
}

export async function launchPlaybook(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const slug = String(req.params.slug ?? "");
  const pb = getPlaybook(slug);
  if (!pb) {
    res.status(404).json({ error: { code: "unknown_playbook", message: `No playbook '${slug}'.` } });
    return;
  }

  const playbook_run_id = randomUUID();
  try {
    const { run_id } = await enqueueAgentRun({
      agent_slug: pb.agent_slug,
      tenant_id: auth.tenant_id,
      trigger: "playbook",
      payload: { playbook_run_id, playbook_slug: pb.slug },
      user_access_token: auth.access_token,
    });
    res.json({ playbook_run_id, run_id, slug: pb.slug });
  } catch (e) {
    console.error(`[launchPlaybook] enqueue failed for ${pb.slug}: ${(e as Error).message}`);
    res.status(500).json({ error: { code: "launch_failed", message: "Could not launch this playbook. Please try again." } });
  }
}

export async function getPlaybookTrail(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const playbook_run_id = String(req.params.id ?? "");
  if (!playbook_run_id) {
    res.status(400).json({ error: { code: "missing_run_id", message: "playbook_run_id required." } });
    return;
  }

  try {
    const supabase = serverClientFromBearer(auth.access_token);
    const { data, error } = await supabase
      .from("decisions")
      .select("id, decision_class, status, dispatch_error, body, emitted_at")
      .eq("tenant_id", auth.tenant_id)
      .filter("body->>playbook_run_id", "eq", playbook_run_id)
      .order("emitted_at", { ascending: true });

    if (error) {
      res.status(500).json({ error: { code: "trail_query_failed", message: error.message } });
      return;
    }

    const rows = (data ?? []) as TrailDecisionRow[];
    res.json({
      playbook_run_id,
      decisions: data ?? [],
      summary: summarizeTrail(rows),
    });
  } catch (e) {
    console.error(`[getPlaybookTrail] failed for ${playbook_run_id}: ${(e as Error).message}`);
    res.status(500).json({ error: { code: "trail_query_failed", message: "Could not load the run trail." } });
  }
}
