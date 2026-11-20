
import { createHmac } from "node:crypto";

export const DEFAULT_ALIAS_DOMAIN = "u.sites-auth.zaviagent.com";
const ALIAS_VERSION = "v1";
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.normalize("NFC").trim().toLowerCase();
  if (e.length < 3 || e.length > 254) return null;
  if (!/^[^@\s"<>()\[\],;:\\]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(e)) {
    return null;
  }
  return e;
}

function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function aliasDomain(): string {
  return (process.env.SITE_AUTH_ALIAS_DOMAIN || DEFAULT_ALIAS_DOMAIN).trim().toLowerCase();
}

export function deriveAlias(key: string, siteId: string, emailNorm: string, domain = aliasDomain()): string {
  if (!key || key.length < 32) throw new Error("SITE_AUTH_ALIAS_KEY must be at least 32 characters");
  const mac = createHmac("sha256", key).update(`${ALIAS_VERSION}|${siteId.toLowerCase()}|${emailNorm}`).digest();
  return `u${base32(mac).slice(0, 32)}@${domain}`;
}

export function isAliasEmail(email: string, domain = aliasDomain()): boolean {
  return new RegExp(`^u[a-z2-7]{32}@${domain.replace(/\./g, "\\.")}$`).test(email.toLowerCase());
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}
