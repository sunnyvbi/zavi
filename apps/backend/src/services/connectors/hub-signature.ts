
import crypto from "node:crypto";

export function verifyHubSignature256(
  rawBody: Buffer,
  signature256: string,
  secret: string,
): boolean {
  if (!secret) return false;
  if (typeof signature256 !== "string" || !signature256.startsWith("sha256=")) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signature256.slice("sha256=".length);

  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}
