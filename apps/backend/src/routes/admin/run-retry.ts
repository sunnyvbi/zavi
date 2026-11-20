
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeNote } from "@/services/memory";
import { writeStaffAudit } from "@/services/staff/audit";
import { enqueueAgentRun } from "@/services/agents/runner";
import { prepareStaffDraftRetry, readStaffDraftRetryTarget, type StaffRetryRun } from "@/services/setup/staff-draft-retry";

const Body = z.object({ hint: z.string().max(2000).optional() });

export async function staffRunRetry(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const runId = req.params.run_id;
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const hint = parsed.data.hint?.trim() || null;

  const { data: run, error } = await serviceClient()
    .from("agent_runs")
    .select("id, tenant_id, agent_slug, status, trigger, enqueued_by, cron_dedupe_key, enqueued_at, payload")
    .eq("id", runId)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: { code: "run_query_failed", message: error.message } });
    return;
  }
  if (!run) {
    res.status(404).json({ error: { code: "run_not_found", message: runId } });
    return;
  }
  const { tenant_id, agent_slug } = run as { tenant_id: string; agent_slug: string };

  let setupRetry: Awaited<ReturnType<typeof prepareStaffDraftRetry>>;
  try {
    setupRetry = await prepareStaffDraftRetry(run as StaffRetryRun);
  } catch (e) {
    res.status(409).json({ error: { code: "retry_enqueue_failed", message: (e as Error).message } });
    return;
  }
  const existing = setupRetry && "existing" in setupRetry ? setupRetry.existing : null;

  let noteId: string | null = null;
  if (hint && !existing) {
    const today = new Date().toISOString().slice(0, 10);
    try {
      const r = await writeNote(tenant_id, {
        title: `Staff retry hint — ${agent_slug}`,
        body_markdown: hint,
        source: "praxis_staff",
        source_ref: `${staff.user_id}:${staff.email}:${today}:retry:${runId}`,
        tags: [`agent:${agent_slug}`, "praxis_staff_note", "retry_hint"],
      });
      noteId = r.note_id ?? null;
    } catch (e) {
      res.status(500).json({ error: { code: "hint_write_failed", message: (e as Error).message } });
      return;
    }
  }

  let newRunId: string;
  try {
    const out = existing ? { run_id: existing } : await enqueueAgentRun({
      agent_slug,
      tenant_id,
      trigger: "a2a",
      ...(setupRetry && "attempt" in setupRetry
        ? { setup_draft_attempt: setupRetry.attempt, payload: setupRetry.payload }
        : { payload: { retry_of: runId, hint_note_id: noteId, origin: "staff_retry" } }),
    });
    newRunId = out.run_id;
    if (!newRunId && setupRetry && "attempt" in setupRetry) {
      newRunId = await readStaffDraftRetryTarget(tenant_id, setupRetry.attempt) ?? "";
      if (!newRunId) throw new Error("Setup retry receipt is not available yet. Retry this same source run.");
    }
  } catch (e) {
    res.status(409).json({ error: { code: "retry_enqueue_failed", message: (e as Error).message } });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "run.retry",
    target_table: "agent_runs",
    target_id: runId,
    meta: { tenant_id, agent_slug, new_run_id: newRunId, hint_len: hint?.length ?? 0, note_id: noteId },
  });

  res.json({ ok: true, run_id: newRunId, hint_applied: !!noteId });
}
