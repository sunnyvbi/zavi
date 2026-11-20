
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { CONSENT_STATE_TTL_SECONDS } from "./tokens";

const SECRET = process.env.OAUTH_STATE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export type ConsentState = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  scopes: string[];
  resource: string;
  jti: string;
  iat: number;
};

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signConsentState(
  input: Omit<ConsentState, "jti" | "iat">,
): string {
  if (!SECRET) throw new Error("OAUTH_STATE_SECRET not configured");
  const payload: ConsentState = {
    ...input,
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", SECRET).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyConsentState(token: string): ConsentState | null {
  if (!SECRET) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac("sha256", SECRET).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: ConsentState;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload.iat !== "number" ||
    Date.now() / 1000 - payload.iat > CONSENT_STATE_TTL_SECONDS
  ) {
    return null;
  }
  return payload;
}
