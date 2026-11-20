
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_TOLERANCE_S = 5 * 60;

export function hookSecretKey(secret: string): Buffer | null {
  const s = secret.trim().replace(/^v1,/, "").replace(/^whsec_/, "");
  if (!s || !/^[A-Za-z0-9+/=]+$/.test(s)) return null;
  const key = Buffer.from(s, "base64");
  return key.length >= 16 ? key : null;
}

export function signStandardWebhook(secret: string, id: string, ts: string, body: Buffer | string): string {
  const key = hookSecretKey(secret);
  if (!key) throw new Error("invalid webhook secret");
  return "v1," + createHmac("sha256", key).update(`${id}.${ts}.`).update(body).digest("base64");
}

export function verifyStandardWebhook(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  body: Buffer,
  nowMs: number,
): boolean {
  const key = hookSecretKey(secret);
  const { id, timestamp, signature } = headers;
  if (!key || !id || !timestamp || !signature) return false;
  if (id.length > 256 || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_S) return false;
  const want = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest();
  for (const part of signature.split(" ")) {
    const [ver, b64] = part.split(",", 2);
    if (ver !== "v1" || !b64) continue;
    const got = Buffer.from(b64, "base64");
    if (got.length === want.length && timingSafeEqual(got, want)) return true;
  }
  return false;
}
