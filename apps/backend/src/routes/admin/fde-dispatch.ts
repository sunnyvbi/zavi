
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { writeStaffAudit } from "@/services/staff/audit";
import { logFdeEvent, GAP_DIMENSIONS, type GapDimension } from "@/services/readiness/fde-events";
import { readReadiness } from "@/services/readiness/compute";
import { ensureAgentRunnable } from "@/services/agents/ensure-runnable";
import { planUpgradeErrorBody } from "@/services/agents/entitlement";
import { asPlanUpgradeRequired } from "@/services/billing/tiers";
import {
  enqueueAgentRun,
  AgentNotFoundError,
  SafetyGateError,
  BudgetExceededError,
  InsufficientCreditsError,
  BuildCreditsExhaustedError,
} from "@/services/agents/runner";
import { FleetHaltedError } from "@/services/agents/fleet-halt";

const MAX_PROMPT_CHARS = 8000;

export async function staffFdeDispatch(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenant_id = req.params.tenant_id;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const agent_slug = typeof body.agent_slug === "string" ? body.agent_slug.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  if (!agent_slug) {
    res.status(400).json({ error: { code: "invalid_agent_slug", message: "agent_slug required" } });
    return;
  }
  if (!prompt) {
    res.status(400).json({ error: { code: "invalid_prompt", message: "prompt required" } });
    return;
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    res.status(400).json({
      error: {
        code: "prompt_too_long",
        message: `prompt exceeds ${MAX_PROMPT_CHARS} chars`,
      },
    });
    return;
  }

  const gap_dimension = (body.gap_dimension ?? null) as GapDimension | null;
  if (gap_dimension !== null && !GAP_DIMENSIONS.includes(gap_dimension)) {
    res.status(400).json({
      error: {
        code: "invalid_gap_dimension",
        message: `gap_dimension must be one of: ${GAP_DIMENSIONS.join(", ")}`,
      },
    });
    return;
  }

  const runnable = await ensureAgentRunnable(tenant_id, agent_slug, {
    run: { trigger: "a2a", enqueuedByUser: false, payload: {} },
  });
  if (!runnable.runnable) {
    if (runnable.reason === "plan_upgrade_required") {
      res.status(403).json(planUpgradeErrorBody(agent_slug, runnable.required_tier ?? "pro"));
      return;
    }
    res.status(runnable.reason === "not_found" ? 404 : 403).json({
      error: { code: runnable.reason, message: runnable.detail ?? "agent not runnable for this tenant" },
    });
    return;
  }

  const before = await readReadiness(tenant_id).catch(() => null);

  let run_id: string;
  try {
    const out = await enqueueAgentRun({
      tenant_id,
      agent_slug,
      trigger: "a2a",
      payload: {
        task_description: prompt,
        origin: "fde_dispatch",
      },
    });
    run_id = out.run_id;
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err instanceof FleetHaltedError || err.code === "fleet_halted") {
      res.status(503).json({ error: { code: "fleet_halted", message: "fleet is halted; dispatch refused" } });
      return;
    }
    if (err instanceof AgentNotFoundError) {
      res.status(404).json({ error: { code: "agent_not_found", message: err.message } });
      return;
    }
    if (err instanceof SafetyGateError) {
      res.status(403).json({ error: { code: "safety_gate", message: err.message } });
      return;
    }
    if (err instanceof BudgetExceededError) {
      res.status(429).json({ error: { code: "budget_exceeded", message: err.message } });
      return;
    }
    const planRefusal = asPlanUpgradeRequired(err);
    if (planRefusal) {
      res.status(403).json(planRefusal.body);
      return;
    }
    if (err instanceof InsufficientCreditsError) {
      res.status(402).json({ error: { code: "insufficient_credits", message: err.message } });
      return;
    }
    if (err instanceof BuildCreditsExhaustedError) {
      res.status(402).json({ error: { code: "build_credits_exhausted", message: err.message } });
      return;
    }
    if (err.code === "repo_access_required" || /repo access/i.test(err.message)) {
      res.status(409).json({ error: { code: "repo_access_required", message: err.message } });
      return;
    }
    res.status(500).json({ error: { code: "dispatch_failed", message: err.message } });
    return;
  }

  if (!run_id) {
    res.status(409).json({
      error: { code: "duplicate_dispatch", message: "an identical run is already in flight" },
    });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "fde_dispatch",
    target_table: "agent_runs",
    target_id: run_id,
    tenant_id,
    meta: { agent_slug, prompt_chars: prompt.length, gap_dimension },
  });

  try {
    await logFdeEvent({
      tenant_id,
      action_kind: "dispatch",
      gap_dimension,
      staff_user_id: staff.user_id,
      staff_email: staff.email,
      readiness_at: before?.computed_at ?? null,
      before_score: before?.score ?? null,
      input_ref: run_id,
      escalation_category: typeof body.escalation_category === "string" ? body.escalation_category : null,
      agent_training_hint: typeof body.agent_training_hint === "string" ? body.agent_training_hint : null,
    });
  } catch (e) {
    res.status(500).json({
      error: {
        code: "dispatched_but_not_recorded",
        message: `run ${run_id} was dispatched, but the WORM training row failed to write: ${(e as Error).message}`,
      },
      run_id,
    });
    return;
  }

  res.json({ run_id, agent_slug, tenant_id });
}
