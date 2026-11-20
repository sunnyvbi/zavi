
import crypto from "node:crypto";

const SIG_VERSION = "v0";
export const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 60 * 5;

export function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean {
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() / 1000 - tsNum) > SLACK_TIMESTAMP_TOLERANCE_SECONDS) return false;

  const base = `${SIG_VERSION}:${timestamp}:${rawBody}`;
  const expected =
    SIG_VERSION + "=" + crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
