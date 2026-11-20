
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import { getSecret } from "@/services/secrets/vault";
import { qaInflightCutoffISO } from "@/services/agents/qa-inflight";
import { inngest } from "../../../../workers/client";

const COOLDOWN_MIN = 10;

export async function qaRunTests(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const tenant_id = auth.tenant_id;

  let enabled = false;
  try {
    enabled = await getBoolSetting("qa_weekly_execute_enabled", tenant_id);
  } catch {
    enabled = false;
  }
  if (!enabled) {
    res.status(403).json({
      error: {
        code: "setup_required",
        message:
          "QA test execution is not enabled for this workspace. Enable qa_weekly_execute_enabled in settings first.",
      },
    });
    return;
  }

  let stagingUrl: string | null = null;
  try {
    stagingUrl = await getSecret(tenant_id, "qa.staging_url");
  } catch {
    stagingUrl = null;
  }
  if (!stagingUrl) {
    res.status(409).json({
      error: {
        code: "needs_staging_url",
        message:
          "No staging URL configured. Set qa.staging_url in QA Setup before running tests.",
      },
    });
    return;
  }

  const svc = serviceClient();
  const { data: inflight, error: inflightErr } = await svc
    .from("agent_runs")
    .select("id, status, enqueued_at")
    .eq("tenant_id", tenant_id)
    .eq("trigger", "qa-weekly-execute")
    .in("status", ["queued", "running"])
    .gt("enqueued_at", qaInflightCutoffISO())
    .limit(1);
  if (inflightErr) {
    res.status(500).json({
      error: { code: "dedupe_check_failed", message: inflightErr.message },
    });
    return;
  }
  if ((inflight ?? []).length > 0) {
    res.status(409).json({
      error: {
        code: "already_running",
        message:
          "A QA test batch is already running for this workspace. Results land in Approvals when it finishes.",
      },
    });
    return;
  }
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_MIN * 60_000).toISOString();
  const { data: recent, error: recentErr } = await svc
    .from("agent_runs")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("trigger", "qa-weekly-execute")
    .gt("enqueued_at", cooldownCutoff)
    .limit(1);
  if (recentErr) {
    res.status(500).json({
      error: { code: "dedupe_check_failed", message: recentErr.message },
    });
    return;
  }
  if ((recent ?? []).length > 0) {
    res.status(429).json({
      error: {
        code: "cooldown",
        message: `A QA test batch ran in the last ${COOLDOWN_MIN} minutes. Try again shortly.`,
      },
    });
    return;
  }

  const dedupe_key = `${tenant_id}:${Math.floor(Date.now() / (COOLDOWN_MIN * 60_000))}`;
  try {
    await inngest.send({
      name: "qa/weekly.execute.requested",
      data: { tenant_id, source: "operator-run-now", dedupe_key },
    });
  } catch (e) {
    res.status(502).json({
      error: { code: "dispatch_failed", message: (e as Error).message },
    });
    return;
  }

  res.status(202).json({
    started: true,
    message:
      "QA test run started. Each active test case runs via browser-operator; the pass/fail digest lands in Approvals (typically 10-45 minutes).",
  });
}
