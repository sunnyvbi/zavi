
import { parseAddrSpec, domainCoveredBy } from "./addr-spec";

export type FromAuthResult = {
  authentic: boolean;
  reason: string;
};

export function verifyFromAuthenticity(
  from: string,
  authResults: string | null | undefined,
): FromAuthResult {
  const addr = parseAddrSpec(from);
  if (!addr) return { authentic: false, reason: "unparseable_from" };
  const fromDomain = addr.domain;

  const raw = String(authResults ?? "").trim();
  if (!raw) return { authentic: false, reason: "no_trusted_auth_results" };

  const clauses = parseAuthResults(raw);
  if (!clauses) return { authentic: false, reason: "malformed_auth_results" };

  let dmarcAligned: string | null = null;
  for (const c of clauses) {
    if (c.method !== "dmarc") continue;
    const d = singleDomainProp(c, "header.from");
    if (c.result === "pass") {
      if (!d) return { authentic: false, reason: "dmarc_pass_but_no_header_from" };
      if (!domainCoveredBy(fromDomain, d)) {
        return { authentic: false, reason: `dmarc_pass_but_unaligned:${d}` };
      }
      dmarcAligned ??= d;
      continue;
    }
    if (d && !domainCoveredBy(fromDomain, d)) {
      return { authentic: false, reason: `dmarc_unaligned:${d}` };
    }
    if (c.result === "fail" && d) {
      return { authentic: false, reason: `dmarc_fail:${d}` };
    }
  }
  if (dmarcAligned) return { authentic: true, reason: `dmarc_pass_aligned:${dmarcAligned}` };

  let firstUnaligned: string | null = null;
  let sawDkimPass = false;
  for (const c of clauses) {
    if (c.method !== "dkim" || c.result !== "pass") continue;
    sawDkimPass = true;
    const d = singleDomainProp(c, "header.d");
    if (d && domainCoveredBy(fromDomain, d)) {
      return { authentic: true, reason: `dkim_pass_aligned:${d}` };
    }
    firstUnaligned ??= d ?? "no_d";
  }
  if (sawDkimPass) {
    return { authentic: false, reason: `dkim_pass_but_unaligned:${firstUnaligned}` };
  }

  if (clauses.some((c) => c.method === "spf" && c.result === "pass")) {
    return { authentic: false, reason: "spf_only_from_not_authenticated" };
  }

  return { authentic: false, reason: "no_passing_auth" };
}

export type AuthResultClause = {
  method: string;
  result: string;
  props: Map<string, string[]>;
};

const METHOD_RESULT = /^([a-z0-9-]+)(?:\/[0-9]+)?=([a-z0-9-]+)$/;
const PROPERTY = /^([a-z0-9-]+\.[a-z0-9_.-]+)=(.*)$/;

export function parseAuthResults(raw: string): AuthResultClause[] | null {
  const s = String(raw ?? "").toLowerCase();
  const segments: string[] = [];
  let cur = "";
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuote) {
      if (ch === "\\") {
        i++;
        cur += "_";
      } else if (ch === '"') {
        inQuote = false;
      } else {
        cur += /\s/.test(ch) || ch === ";" ? "_" : ch;
      }
      continue;
    }
    if (depth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }
    if (ch === "(") {
      depth = 1;
      cur += " ";
    } else if (ch === ")") {
      return null;
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ";") {
      segments.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (inQuote || depth !== 0) return null;
  segments.push(cur);

  const clauses: AuthResultClause[] = [];
  for (const seg of segments.slice(1)) {
    const tokens = seg.replace(/\s*=\s*/g, "=").trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const head = tokens[0]!.match(METHOD_RESULT);
    if (!head) continue;
    const props = new Map<string, string[]>();
    for (const t of tokens.slice(1)) {
      const pm = t.match(PROPERTY);
      if (pm) {
        const list = props.get(pm[1]!) ?? [];
        list.push(pm[2]!);
        props.set(pm[1]!, list);
        continue;
      }
      if (t.startsWith("reason=")) continue;
      if (METHOD_RESULT.test(t)) return null;
    }
    clauses.push({ method: head[1]!, result: head[2]!, props });
  }
  return clauses;
}

function singleDomainProp(c: AuthResultClause, key: string): string | null {
  const v = c.props.get(key);
  if (!v || v.length !== 1) return null;
  const d = v[0]!.trim();
  return /^[a-z0-9.-]+$/.test(d) ? d : null;
}
