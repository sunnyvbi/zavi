
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { writeStaffAudit } from "@/services/staff/audit";
import {
  enqueueAgentRun,
  AgentNotFoundError,
  SafetyGateError,
  BudgetExceededError,
  InsufficientCreditsError,
  BuildCreditsExhaustedError,
} from "@/services/agents/runner";
import { asPlanUpgradeRequired } from "@/services/billing/tiers";
import { FleetHaltedError } from "@/services/agents/fleet-halt";
import { createHash } from "node:crypto";
import {
  STAFF_CONSOLE_ALLOWED_SLUG,
  STAFF_CONSOLE_MAX_MESSAGE_CHARS,
  isStaffOrInternalTenant,
  idempotencyClaim,
  idempotencyResolve,
  idempotencyRelease,
  rateLimitExceeded,
} from "./staff-console-shared";

const Body = z.object({
  message: z.string().min(1).max(STAFF_CONSOLE_MAX_MESSAGE_CHARS),
  thread_id: z.string().uuid().optional(),
});

export async function staffAgentChat(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenant_id = req.params.tenant_id;
  const slug = req.params.slug;

  if (slug !== STAFF_CONSOLE_ALLOWED_SLUG) {
    res.status(400).json({
      error: {
        code: "slug_not_allowed",
        message: `The staff console v1 only runs the '${STAFF_CONSOLE_ALLOWED_SLUG}' agent.`,
      },
    });
    return;
  }

  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const message = parsed.data.message.trim();
  if (message.length === 0) {
    res.status(400).json({ error: { code: "invalid_body", message: "message must not be blank" } });
    return;
  }
  const requestedThreadId = parsed.data.thread_id ?? null;

  if (rateLimitExceeded(staff.user_id, tenant_id)) {
    res.status(429).json({
      error: { code: "rate_limited", message: "Too many console messages; slow down." },
    });
    return;
  }

  if (await isStaffOrInternalTenant(tenant_id)) {
    res.status(403).json({
      error: {
        code: "tenant_not_operable",
        message: "The staff console v1 operates on customer tenants only.",
      },
    });
    return;
  }

  const clientKey =
    typeof req.headers["idempotency-key"] === "string"
      ? (req.headers["idempotency-key"] as string).slice(0, 200)
      : null;
  const msgHash = createHash("sha256")
    .update(`${requestedThreadId ?? "new"}\n${message}`)
    .digest("hex")
    .slice(0, 16);
  const idempKey = clientKey
    ? `chat:${staff.user_id}:${tenant_id}:${clientKey}:${msgHash}`
    : null;
  if (idempKey) {
    const claim = idempotencyClaim(idempKey);
    if (!claim.fresh) {
      if (claim.entry.pending) {
        res.status(409).json({
          error: { code: "in_progress", message: "An identical request is still being processed." },
        });
        return;
      }
      res.status(202).json(claim.entry.result);
      return;
    }
  }

  const sb = staffCrossTenantClient(
    "Staff operator console composes and manages customer-tenant chat threads and runs.",
  );

  let thread_id: string;
  if (requestedThreadId) {
    const { data: th, error: thErr } = await sb
      .from("agent_threads")
      .select("id")
      .eq("id", requestedThreadId)
      .eq("tenant_id", tenant_id)
      .eq("agent_slug", STAFF_CONSOLE_ALLOWED_SLUG)
      .eq("user_id", staff.user_id)
      .is("deleted_at", null)
      .maybeSingle<{ id: string }>();
    if (thErr) {
      if (idempKey) idempotencyRelease(idempKey);
      res.status(500).json({ error: { code: "thread_query_failed", message: thErr.message } });
      return;
    }
    if (!th) {
      if (idempKey) idempotencyRelease(idempKey);
      res.status(404).json({ error: { code: "thread_not_found", message: "thread not found for this staff + tenant" } });
      return;
    }
    thread_id = th.id;
    await sb.from("agent_threads").update({ last_message_at: new Date().toISOString() }).eq("id", thread_id);
  } else {
    const { data: created, error: createErr } = await sb
      .from("agent_threads")
      .insert({
        tenant_id,
        agent_slug: STAFF_CONSOLE_ALLOWED_SLUG,
        user_id: staff.user_id,
        title: message.slice(0, 80),
      })
      .select("id")
      .single<{ id: string }>();
    if (createErr || !created) {
      if (idempKey) idempotencyRelease(idempKey);
      res.status(500).json({ error: { code: "thread_create_failed", message: createErr?.message ?? "no row" } });
      return;
    }
    thread_id = created.id;
  }
  const threadIsOursToRollBack = requestedThreadId === null;

  const { data: liveRuns, error: liveErr } = await sb
    .from("agent_runs")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("payload->>thread_id", thread_id)
    .eq("trigger", "chat")
    .in("status", ["queued", "running"])
    .limit(1);
  if (liveErr) {
    if (threadIsOursToRollBack) await sb.from("agent_threads").delete().eq("id", thread_id);
    if (idempKey) idempotencyRelease(idempKey);
    res.status(500).json({ error: { code: "run_probe_failed", message: liveErr.message } });
    return;
  }
  if ((liveRuns ?? []).length > 0) {
    if (idempKey) idempotencyRelease(idempKey);
    res.status(409).json({
      error: {
        code: "run_in_flight",
        message: "The operator is still working on this thread. Wait for it to finish before sending again.",
      },
    });
    return;
  }

  const { data: msg, error: msgErr } = await sb
    .from("agent_thread_messages")
    .insert({
      thread_id,
      tenant_id,
      sender_role: "user",
      body: message,
      meta: { actor_source: "staff", staff_email: staff.email, origin: "staff_console" },
    })
    .select("id")
    .single<{ id: string }>();
  if (msgErr || !msg) {
    if (threadIsOursToRollBack) await sb.from("agent_threads").delete().eq("id", thread_id);
    if (idempKey) idempotencyRelease(idempKey);
    res.status(500).json({ error: { code: "message_insert_failed", message: msgErr?.message ?? "no row" } });
    return;
  }
  const user_message_id = msg.id;

  let run_id: string;
  try {
    const out = await enqueueAgentRun({
      tenant_id,
      agent_slug: STAFF_CONSOLE_ALLOWED_SLUG,
      trigger: "chat",
      payload: { thread_id, user_message_id, origin: "staff_console" },
    });
    run_id = out.run_id;
  } catch (e) {
    await sb.from("agent_thread_messages").delete().eq("id", user_message_id);
    if (threadIsOursToRollBack) await sb.from("agent_threads").delete().eq("id", thread_id);
    if (idempKey) idempotencyRelease(idempKey);
    const err = e as Error & { code?: string };
    if (err instanceof FleetHaltedError || err.code === "fleet_halted") {
      res.status(503).json({ error: { code: "fleet_halted", message: "fleet is halted; chat refused" } });
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
    res.status(500).json({ error: { code: "enqueue_failed", message: err.message } });
    return;
  }

  if (!run_id) {
    await sb.from("agent_thread_messages").delete().eq("id", user_message_id);
    if (threadIsOursToRollBack) await sb.from("agent_threads").delete().eq("id", thread_id);
    if (idempKey) idempotencyRelease(idempKey);
    res.status(409).json({ error: { code: "duplicate_dispatch", message: "an identical run is already in flight" } });
    return;
  }

  await sb.from("agent_thread_messages").update({ agent_run_id: run_id }).eq("id", user_message_id);

  const result = { thread_id, user_message_id, run_id };
  if (idempKey) idempotencyResolve(idempKey, result);

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "operator_chat",
    target_table: "agent_runs",
    target_id: run_id,
    tenant_id,
    meta: { agent_slug: slug, thread_id, message_chars: message.length },
  });

  res.status(202).json(result);
}
