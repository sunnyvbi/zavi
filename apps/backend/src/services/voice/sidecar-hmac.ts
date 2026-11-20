
import { createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

export const HMAC_HEADER_SIG = "X-Praxis-Sidecar-Sig";
export const HMAC_HEADER_EVENT_ID = "X-Praxis-Event-Id";
export const HMAC_HEADER_IAT = "X-Praxis-Iat";

export const HMAC_IAT_WINDOW_MS = 60_000;

export const HMAC_NONCE_TTL_MS = 2 * 60 * 60 * 1000;

export type HmacVerifyOutcome =
  | { ok: true; eventId: string }
  | { ok: false; reason: HmacRejectReason };

export type HmacRejectReason =
  | "missing_secret"
  | "missing_header"
  | "bad_iat"
  | "bad_signature"
  | "replay";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signVoiceCallbackBody(body: Buffer, secret: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  const val = headers[lower] ?? headers[name];
  if (Array.isArray(val)) return val[0] ?? null;
  return typeof val === "string" && val.length > 0 ? val : null;
}

export function verifyVoiceCallbackSignature(
  body: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  now: number = Date.now(),
): HmacVerifyOutcome {
  if (!secret) return { ok: false, reason: "missing_secret" };

  const sigHeader = readHeader(headers, HMAC_HEADER_SIG);
  const eventId = readHeader(headers, HMAC_HEADER_EVENT_ID);
  const iatHeader = readHeader(headers, HMAC_HEADER_IAT);

  if (!sigHeader || !eventId || !iatHeader) {
    return { ok: false, reason: "missing_header" };
  }

  const iat = Number(iatHeader);
  if (!Number.isFinite(iat) || Math.abs(now - iat) > HMAC_IAT_WINDOW_MS) {
    return { ok: false, reason: "bad_iat" };
  }

  const expected = signVoiceCallbackBody(body, secret);
  const a = Buffer.from(sigHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true, eventId };
}

export async function checkAndConsumeNonce(
  supabase: SupabaseClient,
  eventId: string,
): Promise<{ ok: true } | { ok: false; reason: "replay" }> {
  const { data, error } = await supabase
    .from("voice_callback_events_seen")
    .insert({ event_id: eventId })
    .select("event_id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return { ok: false, reason: "replay" };
    throw error;
  }
  if (!data) return { ok: false, reason: "replay" };
  return { ok: true };
}
