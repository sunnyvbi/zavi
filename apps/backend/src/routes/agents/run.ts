
import type { Request, Response } from "express";
import { z } from "zod";
import {
  enqueueAgentRun,
  AgentNotFoundError,
  SafetyGateError,
  BudgetExceededError,
  FleetHaltedError,
} from "@/services/agents/runner";
import { TenantConfigNotFoundError } from "@/services/agents/tenant";
import { requireAuth } from "@/services/auth/middleware";
import { canUserAccessAgent } from "@/services/auth/members";
import { serviceClient } from "@/services/supabase";
import { validateAgentPayload } from "@/agents/_input-schemas";
import { stripReservedRunPayloadKeys } from "@/services/agents/reserved-payload";
import { lockedChannelMessageForAgent } from "@/services/channels/lock";

const Body = z.object({
  payload: z.unknown().optional(),
});

function resolvePayload(rawBody: unknown, parsed: z.infer<typeof Body>): unknown {
  if (parsed.payload !== undefined) return parsed.payload;
  if (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)) {
    const { payload: _ignored, ...rest } = rawBody as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return rest;
  }
  return undefined;
}

export async function agentRun(req: Request, res: Response): Promise<void> {
  const slug = req.params.slug;
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body ?? {});
  } catch (e) {
    res.status(400).json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }
  const effectivePayload = resolvePayload(req.body, body);

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const allowed = await canUserAccessAgent(
    serviceClient(),
    auth.user_id,
    auth.tenant_id,
    slug,
  );
  if (!allowed) {
    res.status(403).json({
      error: {
        code: "agent_not_allowed",
        message: "Your role is read-only. Ask a workspace admin to make you a member.",
      },
    });
    return;
  }

  const validated = validateAgentPayload(slug, effectivePayload);
  if (!validated.ok) {
    res.status(400).json({
      error: {
        code: validated.error.code,
        message: validated.error.message,
        path: validated.error.path,
      },
    });
    return;
  }

  const comingSoon = await lockedChannelMessageForAgent(slug);
  if (comingSoon) {
    res.status(409).json({ error: { code: "coming_soon", message: comingSoon } });
    return;
  }

  try {
    const { run_id } = await enqueueAgentRun({
      agent_slug: slug,
      tenant_id: auth.tenant_id,
      trigger: "manual",
      payload: stripReservedRunPayloadKeys(validated.payload),
      user_access_token: auth.access_token,
    });
    res.status(202).json({ run_id });
    return;
  } catch (e) {
    if (e instanceof AgentNotFoundError) {
      res.status(404).json({ error: { code: "not_found", message: e.message } });
      return;
    }
    if (e instanceof FleetHaltedError) {
      res.status(503).json({ error: { code: "fleet_halted", message: e.message } });
      return;
    }
    if (e instanceof SafetyGateError) {
      res.status(403).json({ error: { code: "safety_gate", message: e.message } });
      return;
    }
    if (e instanceof BudgetExceededError) {
      res.status(429).json({ error: { code: "budget_exceeded", message: e.message } });
      return;
    }
    if (e instanceof TenantConfigNotFoundError) {
      res.status(404).json({ error: { code: "tenant_not_found", message: e.message } });
      return;
    }
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
    return;
  }
}
