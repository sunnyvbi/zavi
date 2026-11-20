
import type { Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { serviceClient } from "@/services/supabase";
import { inngest } from "@/../workers/client";

const LIVE_STATUSES = ["scheduled", "joining", "in_call", "call_ended", "processing"];

const STATUS_MAP: Record<string, string> = {
  "bot.joining_call": "joining",
  "bot.in_waiting_room": "joining",
  "bot.in_call_not_recording": "in_call",
  "bot.in_call_recording": "in_call",
  "bot.call_ended": "call_ended",
  "bot.done": "processing",
  "bot.fatal": "failed",
};

export function verifySvixSignature(
  secret: string,
  rawBody: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
): boolean {
  if (!svixId || !svixTimestamp || !svixSignature) return false;
  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false;
  }
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest("base64");
  for (const part of svixSignature.split(" ")) {
    const sig = part.includes(",") ? part.split(",", 2)[1] : part;
    try {
      const a = Buffer.from(sig, "base64");
      const b = Buffer.from(expected, "base64");
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } catch {
    }
  }
  return false;
}

export async function recallWebhook(req: Request, res: Response): Promise<void> {
  const secret = process.env.RECALL_WEBHOOK_SECRET;
  if (!secret) {
    res.status(503).json({ error: { code: "not_configured", message: "RECALL_WEBHOOK_SECRET unset" } });
    return;
  }

  const rawBuf = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
  const rawBody = rawBuf.toString("utf8");

  const ok = verifySvixSignature(
    secret,
    rawBody,
    String(req.header("svix-id") ?? req.header("webhook-id") ?? ""),
    String(req.header("svix-timestamp") ?? req.header("webhook-timestamp") ?? ""),
    String(req.header("svix-signature") ?? req.header("webhook-signature") ?? ""),
  );
  if (!ok) {
    res.status(401).json({ error: { code: "bad_signature", message: "svix signature invalid" } });
    return;
  }

  let body: {
    event?: string;
    data?: {
      data?: { code?: string; sub_code?: string | null };
      bot?: { id?: string };
      transcript?: { id?: string };
    };
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    res.status(400).json({ error: { code: "bad_json", message: "invalid json" } });
    return;
  }

  const event = String(body.event ?? "");
  const providerBotId = String(body.data?.bot?.id ?? "");
  const transcriptId = String(body.data?.transcript?.id ?? "");
  const subCode = body.data?.data?.sub_code ?? null;

  const isTranscriptEvent =
    event === "transcript.done" || event === "transcript.failed";
  if ((!event.startsWith("bot.") && !isTranscriptEvent) || !providerBotId) {
    res.status(200).json({ ok: true, ignored: event || "no_event" });
    return;
  }

  const svc = serviceClient();
  const { data: bot, error: botErr } = await svc
    .from("meeting_bots")
    .select("id, tenant_id, status")
    .eq("provider_bot_id", providerBotId)
    .maybeSingle();
  if (botErr) {
    console.error(`[webhooks/recall] bot lookup failed: ${botErr.message}`);
    res.status(200).json({ ok: true, error: "lookup_failed" });
    return;
  }
  if (!bot) {
    res.status(200).json({ ok: true, ignored: "unknown_bot" });
    return;
  }

  if (event === "bot.in_waiting_room" && bot.status !== "cancelled") {
    try {
      await inngest.send({
        id: `meeting-notice:waiting:${bot.id}`,
        name: "meeting.notice",
        data: { meeting_bot_id: bot.id as string, tenant_id: bot.tenant_id as string, kind: "waiting" },
      });
    } catch (e) {
      console.error(`[webhooks/recall] waiting notice queue failed bot=${bot.id}: ${(e as Error).message}`);
      res.status(503).json({ error: { code: "notice_queue_failed", message: "retry" } });
      return;
    }
  }

  if (event === "transcript.done") {
    if (bot.status === "cancelled") {
      res.status(200).json({ ok: true, ignored: "cancelled" });
      return;
    }
    const idSuffix = transcriptId || providerBotId;
    if (!transcriptId) {
      console.warn(
        `[webhooks/recall] transcript.done missing transcript.id for bot ${providerBotId}; using bot-id fallback`,
      );
    }
    await inngest.send({
      id: `recall-transcript:${providerBotId}:${idSuffix}`,
      name: "meeting.bot.status",
      data: {
        meeting_bot_id: bot.id as string,
        tenant_id: bot.tenant_id as string,
        event,
      },
    });
    res.status(200).json({ ok: true });
    return;
  }

  if (event === "transcript.failed") {
    if (bot.status !== "ingested" && bot.status !== "cancelled") {
      await svc
        .from("meeting_bots")
        .update({
          status: "failed",
          error: `transcript_failed:${subCode ?? "unknown"}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", bot.id)
        .in("status", [...LIVE_STATUSES, "failed"]);
    }
    res.status(200).json({ ok: true });
    return;
  }

  const mapped = STATUS_MAP[event];
  const terminal = new Set(["ingested", "failed", "cancelled"]);
  if (mapped && !terminal.has(bot.status)) {
    await svc
      .from("meeting_bots")
      .update({
        status: mapped,
        updated_at: new Date().toISOString(),
        ...(event === "bot.fatal" ? { error: String(subCode ?? "fatal") } : {}),
      })
      .eq("id", bot.id)
      .in("status", LIVE_STATUSES);
  }

  res.status(200).json({ ok: true });
}
