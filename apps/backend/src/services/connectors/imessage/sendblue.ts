
import crypto from "node:crypto";
import { normalizeHandle } from "./handle";

type SendblueEnv = {
  keyId: string;
  secret: string;
  line: string;
  webhookSecret: string;
};

const API_BASE = "https://api.sendblue.com";

export function imessageEnabled(): boolean {
  return sendblueEnv() !== null;
}

export function sendblueEnv(): SendblueEnv | null {
  const keyId = process.env.SENDBLUE_API_KEY_ID;
  const secret = process.env.SENDBLUE_API_SECRET;
  const webhookSecret = process.env.SENDBLUE_WEBHOOK_SECRET;
  const line = normalizeHandle(process.env.SENDBLUE_FROM_NUMBER);
  if (!keyId || !secret || !webhookSecret || !line || line.includes("@")) return null;
  return { keyId, secret, line, webhookSecret };
}

export function imessageOwnsLine(line: string): boolean {
  const env = sendblueEnv();
  return !!env && !!line && env.line === line;
}

export function verifySendblueSecret(headerValue: unknown): boolean {
  const env = sendblueEnv();
  if (!env) return false;
  const got = Buffer.from(typeof headerValue === "string" ? headerValue : "");
  const want = Buffer.from(env.webhookSecret);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

type SendblueResult = {
  ok: boolean;
  status: number;
  errorKey?: string;
  errorCode?: number;
  errorMessage?: string;
};

export async function callSendblue(path: string, body: Record<string, unknown>): Promise<SendblueResult> {
  const env = sendblueEnv();
  if (!env) return { ok: false, status: 0, errorMessage: "imessage_disabled" };
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "sb-api-key-id": env.keyId,
        "sb-api-secret-key": env.secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from_number: env.line, ...body }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      status?: string;
      error_key?: unknown;
      error_code?: unknown;
      error_message?: unknown;
      message?: unknown;
    };
    const failed = !res.ok || json.status === "ERROR" || json.status === "DECLINED";
    if (!failed) return { ok: true, status: res.status };
    return {
      ok: false,
      status: res.status,
      errorKey: typeof json.error_key === "string" ? json.error_key : undefined,
      errorCode: Number(json.error_code) || undefined,
      errorMessage: `http_${res.status}`,
    };
  } catch (e) {
    return { ok: false, status: 0, errorMessage: (e as Error).message };
  }
}

export function isRecipientGone(r: SendblueResult): boolean {
  return r.errorKey === "OPTED_OUT" || r.errorCode === 4002;
}

export function sendIMessageText(handle: string, content: string): Promise<SendblueResult> {
  return callSendblue("/api/send-message", { number: handle, content });
}

export async function startIMessageTyping(handle: string): Promise<void> {
  await callSendblue("/api/send-typing-indicator", { number: handle });
}
