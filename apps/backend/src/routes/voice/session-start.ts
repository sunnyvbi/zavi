
import type { Request, Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";

import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import {
  buildVoiceRoomName,
  createVoiceAgentDispatch,
  mintVoiceSessionToken,
  VOICE_JWT_TTL_SECONDS,
} from "@/services/voice/livekit-dispatch";
import { checkVoiceBudget } from "@/services/voice/budget-gate";
import { getAppSetting } from "@/services/settings";

const Body = z.object({
  agent_slug: z.string().min(1).max(128),
  thread_id: z.string().uuid().nullable().optional(),
});

interface FlagState {
  systemEnabled: boolean;
  agentDisabled: boolean;
  tenantEnabled: boolean;
}

async function loadFlagState(
  authToken: string,
  tenantId: string,
  agentSlug: string,
): Promise<FlagState> {
  const supabase = serverClientFromBearer(authToken);

  const svc = serviceClient();
  const [{ data: sys }, { data: tenant }] = await Promise.all([
    svc.from("system_config").select("blob").eq("id", 1).maybeSingle(),
    supabase.from("tenants").select("settings").eq("id", tenantId).maybeSingle(),
  ]);

  const sysBlob = (sys?.blob ?? {}) as Record<string, unknown>;
  const voiceSettingOverride = await getAppSetting("voice_enabled");
  const systemEnabled =
    voiceSettingOverride !== undefined
      ? voiceSettingOverride === true
      : sysBlob.voice_enabled === true;
  const disabledList = Array.isArray(sysBlob.disabled_voice_agent_slugs)
    ? (sysBlob.disabled_voice_agent_slugs as unknown[])
    : [];
  const agentDisabled = disabledList.includes(agentSlug);

  const tenantSettings = (tenant?.settings ?? {}) as Record<string, unknown>;
  const raw = tenantSettings.voice_enabled;
  const tenantEnabled = raw === true || raw === "true";

  return { systemEnabled, agentDisabled, tenantEnabled };
}

export async function voiceSessionStart(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parse = Body.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({
      error: {
        code: "invalid_body",
        message: parse.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }
  const { agent_slug, thread_id } = parse.data;

  const flags = await loadFlagState(auth.access_token, auth.tenant_id, agent_slug);
  if (!flags.systemEnabled) {
    res.status(503).json({ error: { code: "feature_flag_off" } });
    return;
  }
  if (flags.agentDisabled) {
    res.status(403).json({ error: { code: "agent_voice_disabled" } });
    return;
  }
  if (!flags.tenantEnabled) {
    res.status(403).json({ error: { code: "tenant_voice_not_enabled" } });
    return;
  }

  const svc = serviceClient();

  let resolvedThreadId: string;
  if (thread_id) {
    const { data: thr } = await svc
      .from("agent_threads")
      .select("id, deleted_at")
      .eq("id", thread_id)
      .eq("tenant_id", auth.tenant_id)
      .eq("user_id", auth.user_id)
      .eq("agent_slug", agent_slug)
      .maybeSingle();
    if (!thr || thr.deleted_at) {
      res.status(404).json({ error: { code: "thread_not_found" } });
      return;
    }
    resolvedThreadId = thr.id as string;
  } else {
    const title = `Voice · ${agent_slug} · ${new Date().toISOString()}`;
    const { data: created, error: createErr } = await svc
      .from("agent_threads")
      .insert({
        tenant_id: auth.tenant_id,
        agent_slug,
        user_id: auth.user_id,
        title,
      })
      .select("id")
      .single();
    if (createErr || !created) {
      res.status(500).json({
        error: { code: "thread_create_failed", message: createErr?.message },
      });
      return;
    }
    resolvedThreadId = created.id as string;
  }

  const { data: existing } = await svc
    .from("voice_sessions")
    .select("id, started_at")
    .eq("tenant_id", auth.tenant_id)
    .eq("user_id", auth.user_id)
    .eq("status", "active")
    .maybeSingle();
  if (existing) {
    res.status(409).json({
      error: {
        code: "voice_session_already_active",
        existing_session_id: existing.id,
        started_at: existing.started_at,
      },
    });
    return;
  }

  const budget = await checkVoiceBudget(svc, auth.tenant_id);
  if (!budget.allowed) {
    res.status(402).json({
      error: {
        code: budget.reason ?? "budget_exhausted",
        cap_micros: budget.capMicros.toString(),
        remaining_micros: budget.remainingTodayMicros.toString(),
      },
    });
    return;
  }

  const sessionId = randomUUID();
  const room = buildVoiceRoomName(sessionId);
  const { error: insertErr } = await svc.from("voice_sessions").insert({
    id: sessionId,
    tenant_id: auth.tenant_id,
    user_id: auth.user_id,
    agent_slug,
    thread_id: resolvedThreadId,
    livekit_room: room,
    status: "active",
  });
  if (insertErr) {
    if (insertErr.code === "23505") {
      const { data: winner } = await svc
        .from("voice_sessions")
        .select("id, started_at")
        .eq("tenant_id", auth.tenant_id)
        .eq("user_id", auth.user_id)
        .eq("status", "active")
        .maybeSingle();
      res.status(409).json({
        error: {
          code: "voice_session_already_active",
          existing_session_id: winner?.id,
          started_at: winner?.started_at,
        },
      });
      return;
    }
    res.status(500).json({
      error: { code: "voice_session_insert_failed", message: insertErr.message },
    });
    return;
  }

  try {
    const mintInput = {
      sessionId,
      userId: auth.user_id,
      agentSlug: agent_slug,
      threadId: resolvedThreadId,
      tenantId: auth.tenant_id,
    };
    const mint = await mintVoiceSessionToken(mintInput);
    await createVoiceAgentDispatch(mintInput);
    res.status(200).json({
      session_id: sessionId,
      thread_id: resolvedThreadId,
      room: mint.room,
      token: mint.token,
      ttl_seconds: mint.ttlSeconds,
    });
  } catch (err) {
    await svc
      .from("voice_sessions")
      .update({ status: "ended", end_reason: "error", ended_at: new Date().toISOString() })
      .eq("id", sessionId);
    res.status(500).json({
      error: {
        code: "voice_session_dispatch_failed",
        message: err instanceof Error ? err.message : "unknown",
      },
    });
  }
  return;
}

export const VOICE_SESSION_JWT_TTL_SECONDS = VOICE_JWT_TTL_SECONDS;
