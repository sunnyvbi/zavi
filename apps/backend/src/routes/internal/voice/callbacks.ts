
import type { Request, Response } from "express";

import { serviceClient } from "@/services/supabase";
import {
  checkAndConsumeNonce,
  verifyVoiceCallbackSignature,
} from "@/services/voice/sidecar-hmac";
import {
  deriveVoiceSessionAuthoritative,
  type VoiceSessionAuthoritative,
} from "@/services/voice/tenant-derive";

interface CallbackPreamble {
  body: Record<string, unknown>;
  session: VoiceSessionAuthoritative;
  eventId: string;
}

async function isVoiceEnabled(): Promise<boolean> {
  const svc = serviceClient();
  const { data } = await svc
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle();
  return (data?.blob as Record<string, unknown> | undefined)?.voice_enabled === true;
}

async function verifyAndDerive(
  req: Request,
  res: Response,
): Promise<CallbackPreamble | null> {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!raw) {
    res.status(500).json({ error: { code: "raw_body_unavailable" } });
    return null;
  }

  const secret = process.env.PRAXIS_VOICE_SIDECAR_HMAC ?? "";
  const verify = verifyVoiceCallbackSignature(raw, req.headers, secret);
  if (!verify.ok) {
    res.status(401).json({ error: { code: `hmac_${verify.reason}` } });
    return null;
  }

  const svc = serviceClient();
  const nonce = await checkAndConsumeNonce(svc, verify.eventId);
  if (!nonce.ok) {
    res.status(200).json({ ok: true, replayed: true });
    return null;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  if (!sessionId) {
    res.status(400).json({ error: { code: "missing_session_id" } });
    return null;
  }
  const session = await deriveVoiceSessionAuthoritative(svc, sessionId);
  if (!session) {
    res.status(404).json({ error: { code: "session_not_found" } });
    return null;
  }

  return { body, session, eventId: verify.eventId };
}

export async function voiceInternalHealth(
  _req: Request,
  res: Response,
): Promise<void> {
  res.status(200).json({ ok: true, service: "praxis-voice-callback-host" });
}

export async function voiceInternalWarmup(
  req: Request,
  res: Response,
): Promise<void> {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!raw) {
    res.status(500).json({ error: { code: "raw_body_unavailable" } });
    return;
  }
  const secret = process.env.PRAXIS_VOICE_SIDECAR_HMAC ?? "";
  const verify = verifyVoiceCallbackSignature(raw, req.headers, secret);
  if (!verify.ok) {
    res.status(401).json({ error: { code: `hmac_${verify.reason}` } });
    return;
  }
  res.status(200).json({ ok: true, warm: true });
}

export async function voiceInternalSessionHydrate(
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await isVoiceEnabled())) {
    res.status(503).json({ error: { code: "feature_flag_off" } });
    return;
  }
  const pre = await verifyAndDerive(req, res);
  if (!pre) return;
  res.status(200).json({
    ok: true,
    session_id: pre.session.sessionId,
    tenant_id: pre.session.tenantId,
    agent_slug: pre.session.agentSlug,
    thread_id: pre.session.threadId,
  });
}

export async function voiceInternalAgentTurn(
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await isVoiceEnabled())) {
    res.status(503).json({ error: { code: "feature_flag_off" } });
    return;
  }
  const pre = await verifyAndDerive(req, res);
  if (!pre) return;
  res.status(200).json({
    ok: true,
    session_id: pre.session.sessionId,
    placeholder: "agent_turn dispatch wires in Slice 3",
  });
}

export async function voiceInternalUtteranceUser(
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await isVoiceEnabled())) {
    res.status(503).json({ error: { code: "feature_flag_off" } });
    return;
  }
  const pre = await verifyAndDerive(req, res);
  if (!pre) return;

  const text = typeof pre.body.text === "string" ? pre.body.text : "";
  const sttConfidence =
    typeof pre.body.stt_confidence === "number" ? pre.body.stt_confidence : null;
  const voiceStartedAt =
    typeof pre.body.voice_started_at === "string"
      ? pre.body.voice_started_at
      : null;
  const voiceEndedAt =
    typeof pre.body.voice_ended_at === "string" ? pre.body.voice_ended_at : null;

  const svc = serviceClient();
  const { data, error } = await svc
    .from("agent_thread_messages")
    .insert({
      thread_id: pre.session.threadId,
      tenant_id: pre.session.tenantId,
      sender_role: "user",
      body: text,
      content_kind: "voice_transcript",
      stt_confidence: sttConfidence,
      voice_started_at: voiceStartedAt,
      voice_ended_at: voiceEndedAt,
    })
    .select("id")
    .single();
  if (error || !data) {
    res.status(500).json({
      error: { code: "utterance_insert_failed", message: error?.message },
    });
    return;
  }
  res.status(200).json({ ok: true, message_id: data.id });
}

export async function voiceInternalCostFlush(
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await isVoiceEnabled())) {
    res.status(503).json({ error: { code: "feature_flag_off" } });
    return;
  }
  const pre = await verifyAndDerive(req, res);
  if (!pre) return;

  const b = pre.body;
  const minuteBucket = typeof b.minute_bucket === "string" ? b.minute_bucket : null;
  if (!minuteBucket) {
    res.status(400).json({ error: { code: "missing_minute_bucket" } });
    return;
  }

  const svc = serviceClient();
  const { error } = await svc.from("voice_session_costs").upsert(
    {
      tenant_id: pre.session.tenantId,
      session_id: pre.session.sessionId,
      agent_run_id: (b.agent_run_id as string | undefined) ?? null,
      agent_slug: pre.session.agentSlug,
      minute_bucket: minuteBucket,
      stt_ms: Number(b.stt_ms ?? 0) | 0,
      stt_micros: String(b.stt_micros ?? "0"),
      tts_chars: Number(b.tts_chars ?? 0) | 0,
      tts_micros: String(b.tts_micros ?? "0"),
      llm_input_tok: Number(b.llm_input_tok ?? 0) | 0,
      llm_output_tok: Number(b.llm_output_tok ?? 0) | 0,
      llm_micros: String(b.llm_micros ?? "0"),
    },
    { onConflict: "session_id,minute_bucket,agent_run_id" },
  );
  if (error) {
    res
      .status(500)
      .json({ error: { code: "cost_flush_upsert_failed", message: error.message } });
    return;
  }
  res.status(200).json({ ok: true });
}

export async function voiceInternalSessionEnd(
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await isVoiceEnabled())) {
    res.status(503).json({ error: { code: "feature_flag_off" } });
    return;
  }
  const pre = await verifyAndDerive(req, res);
  if (!pre) return;

  const allowed = new Set([
    "user_ended",
    "budget_exhausted",
    "idle_reaped",
    "error",
    "first_wins_displaced",
    "livekit_disconnect",
    "tab_suspended",
  ]);
  const raw = typeof pre.body.end_reason === "string" ? pre.body.end_reason : "user_ended";
  const endReason = allowed.has(raw) ? raw : "user_ended";

  if (pre.session.status !== "active") {
    res.status(200).json({ ok: true, already_ended: true });
    return;
  }

  const svc = serviceClient();
  await svc
    .from("voice_sessions")
    .update({ status: "ended", end_reason: endReason, ended_at: new Date().toISOString() })
    .eq("id", pre.session.sessionId)
    .eq("status", "active");
  res.status(200).json({ ok: true });
}

export async function voiceInternalError(
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await isVoiceEnabled())) {
    res.status(503).json({ error: { code: "feature_flag_off" } });
    return;
  }
  const pre = await verifyAndDerive(req, res);
  if (!pre) return;
  res.status(200).json({
    ok: true,
    received: {
      code: typeof pre.body.code === "string" ? pre.body.code : "unknown",
      recoverable: pre.body.recoverable === true,
    },
  });
}
