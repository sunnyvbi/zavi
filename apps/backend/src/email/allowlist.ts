
import { FREE_MAILBOX_DOMAINS } from "./free-mailbox-domains";
import { parseAddrSpec, canonicalizeDomain } from "./addr-spec";

export type AllowlistEntry = {
  kind: "address" | "domain";
  value: string;
};

export type ValidationError = {
  ok: false;
  code: "empty" | "malformed_address" | "malformed_domain" | "public_domain" | "own_domain";
  message: string;
};

export type ValidationOk = { ok: true; entry: AllowlistEntry };

const OWN_DOMAINS: ReadonlySet<string> = new Set([
  "inbox.zaviagent.com",
  "zaviagent.com",
]);

export function validateAllowlistEntry(raw: string): ValidationOk | ValidationError {
  const s = String(raw ?? "").trim();
  if (!s) {
    return { ok: false, code: "empty", message: "Enter an email address or a domain." };
  }

  if (s.includes("@")) {
    const addr = parseAddrSpec(s);
    if (!addr) {
      return {
        ok: false,
        code: "malformed_address",
        message: `"${s}" is not a valid email address.`,
      };
    }
    if (OWN_DOMAINS.has(addr.domain)) {
      return {
        ok: false,
        code: "own_domain",
        message: "That's a Zavi address, not an outside sender.",
      };
    }
    return { ok: true, entry: { kind: "address", value: addr.address } };
  }

  const domain = canonicalizeDomain(s);
  if (!domain) {
    return {
      ok: false,
      code: "malformed_domain",
      message: `"${s}" is not a valid domain.`,
    };
  }
  if (OWN_DOMAINS.has(domain)) {
    return {
      ok: false,
      code: "own_domain",
      message: "That's Zavi's own domain, not an outside sender.",
    };
  }
  if (isPublicMailboxDomain(domain)) {
    return {
      ok: false,
      code: "public_domain",
      message:
        `${domain} is a public email provider, so allowing the whole domain would let ` +
        `anyone with a ${domain} address email your agent. Add the specific addresses instead.`,
    };
  }
  return { ok: true, entry: { kind: "domain", value: domain } };
}

export function isPublicMailboxDomain(rawDomain: string): boolean {
  const d = canonicalizeDomain(rawDomain);
  if (!d) return false;
  return FREE_MAILBOX_DOMAINS.has(d);
}

export function matchesAllowlist(email: string, entries: readonly AllowlistEntry[]): boolean {
  if (!entries?.length) return false;
  const addr = parseAddrSpec(email);
  if (!addr) return false;

  for (const e of entries) {
    if (e?.kind === "address") {
      const v = parseAddrSpec(e.value);
      if (v && v.address === addr.address) return true;
      continue;
    }
    if (e?.kind === "domain") {
      const v = canonicalizeDomain(e.value);
      if (!v) continue;
      if (v !== addr.domain) continue;
      if (isPublicMailboxDomain(v)) continue;
      if (OWN_DOMAINS.has(v)) continue;
      return true;
    }
  }
  return false;
}
