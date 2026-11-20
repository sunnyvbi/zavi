
export const MIN_IDENTITY_CONFIDENCE = 0.85;

export { FREE_MAILBOX_DOMAINS } from "@/email/free-mailbox-domains";
import { FREE_MAILBOX_DOMAINS } from "@/email/free-mailbox-domains";

export type ResolvedDomain = {
  domain: string;
  confidence: number;
  via: string;
} | null;

export type IdentityVerdict =
  | { ok: true; domain: string }
  | {
      ok: false;
      reason:
        | "no_email"
        | "free_mailbox"
        | "unresolved"
        | "low_confidence"
        | "email_domain_mismatch";
    };

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const dom = email.slice(at + 1).trim().toLowerCase();
  if (!dom.includes(".") || dom.includes(" ")) return null;
  return dom;
}

function emailMatchesCompany(emailDom: string, companyDomain: string): boolean {
  const c = companyDomain.toLowerCase();
  return emailDom === c || emailDom.endsWith(`.${c}`);
}

export function evaluateIdentity(input: {
  installerEmail: string | null | undefined;
  resolved: ResolvedDomain;
}): IdentityVerdict {
  const emailDom = emailDomain(input.installerEmail);
  if (!emailDom) return { ok: false, reason: "no_email" };
  if (FREE_MAILBOX_DOMAINS.has(emailDom))
    return { ok: false, reason: "free_mailbox" };
  if (!input.resolved) return { ok: false, reason: "unresolved" };
  if (input.resolved.confidence < MIN_IDENTITY_CONFIDENCE)
    return { ok: false, reason: "low_confidence" };
  if (!emailMatchesCompany(emailDom, input.resolved.domain))
    return { ok: false, reason: "email_domain_mismatch" };
  return { ok: true, domain: input.resolved.domain };
}
