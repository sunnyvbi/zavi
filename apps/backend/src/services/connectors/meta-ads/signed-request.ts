
import crypto from "node:crypto";

export type MetaSignedRequest = {
  user_id: string;
  issued_at: number | null;
};

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function verifySignedRequest(
  signedRequest: string,
  appSecret: string,
): MetaSignedRequest | null {
  if (!signedRequest || !appSecret) return null;

  const parts = signedRequest.split(".");
  if (parts.length !== 2) return null;
  const [sigPart, payloadPart] = parts;
  if (!sigPart || !payloadPart) return null;

  let payload: { algorithm?: unknown; user_id?: unknown; issued_at?: unknown };
  try {
    const parsed: unknown = JSON.parse(b64urlToBuffer(payloadPart).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    payload = parsed as typeof payload;
  } catch {
    return null;
  }

  if (payload.algorithm !== "HMAC-SHA256") return null;

  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(payloadPart, "utf8")
    .digest();
  const actual = b64urlToBuffer(sigPart);
  if (actual.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(actual, expected)) return null;

  const user_id = typeof payload.user_id === "string" ? payload.user_id : "";
  if (!user_id) return null;

  return {
    user_id,
    issued_at: typeof payload.issued_at === "number" ? payload.issued_at : null,
  };
}
