import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function newReviewToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenValid(a: { presented: string; storedHash: string | null; expiresAt: string; now: Date }): boolean {
  if (!a.storedHash || !a.presented) return false;
  if (!(Date.parse(a.expiresAt) > a.now.getTime())) return false;
  const x = Buffer.from(hashToken(a.presented), "hex");
  const y = Buffer.from(a.storedHash, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}
