
import crypto from "node:crypto";

export function makeBindCode(): string {
  const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const grp = () =>
    Array.from({ length: 4 }, () => ALPHA[crypto.randomInt(0, ALPHA.length)]).join("");
  return `${grp()}-${grp()}`;
}

export function makeLinkToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

const BIND_RE = /(?:^|\s)connect\s+zavi[:\s]+([A-Za-z0-9_-]{16,64})(?:\s|$)/i;

export function bindPrefill(token: string): string {
  return `Connect Zavi: ${token}`;
}

export function extractBindToken(text: string): string | null {
  const m = BIND_RE.exec(String(text ?? ""));
  return m ? m[1] : null;
}
