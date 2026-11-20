
import { githubTokenRegex } from "@/services/security/github-token-pattern";

const SECRET_VALUE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "stripe_secret_key", re: /\b[rs]k_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "aws_access_key_id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github_token", re: githubTokenRegex("g") },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai_key", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

const CREDENTIAL_PARAM_NAME =
  /^(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|auth|token|secret|client[_-]?secret|password|passwd|pwd|bearer|session[_-]?token|sig|signature)$/i;

const PII_VALUE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: "email",
    re: /\b[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}\b/g,
  },
  {
    name: "phone",
    re: /(?:\+\d(?:[\s.-]?\d){6,14}\b)|(?:(?:\(\d{3}\)[\s.-]?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b)/g,
  },
];

const REDACTED = "[redacted]";

function scrubPiiFromParamValue(value: string): ScrubResult {
  const redactions: string[] = [];
  let out = value;
  for (const { name, re } of PII_VALUE_PATTERNS) {
    out = out.replace(re, () => {
      redactions.push(name);
      return REDACTED;
    });
  }
  return { scrubbed: out, redactions };
}

export function scrubPiiShapesFromText(text: string): ScrubResult {
  const first = scrubPiiFromParamValue(text);
  const redactions = [...first.redactions];
  const scrubbed = first.scrubbed.replace(/\b1?\d{10}\b/g, () => {
    redactions.push("phone");
    return REDACTED;
  });
  return { scrubbed, redactions };
}

export interface ScrubResult {
  scrubbed: string;
  redactions: string[];
}

export function scrubSecretsFromText(text: string): ScrubResult {
  const redactions: string[] = [];
  let out = text;
  for (const { name, re } of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, () => {
      redactions.push(name);
      return REDACTED;
    });
  }
  return { scrubbed: out, redactions };
}

export function scrubSecretsFromUrl(rawUrl: string): ScrubResult {
  const redactions: string[] = [];
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return scrubSecretsFromText(rawUrl);
  }
  let paramRedactions = 0;
  const rebuilt = new URLSearchParams();
  for (const [key, value] of Array.from(u.searchParams.entries())) {
    if (CREDENTIAL_PARAM_NAME.test(key)) {
      rebuilt.append(key, REDACTED);
      redactions.push(`param:${key}`);
      paramRedactions++;
      continue;
    }
    const valScrub = scrubSecretsFromText(value);
    const piiScrub = scrubPiiFromParamValue(valScrub.scrubbed);
    const valRedactions = [...valScrub.redactions, ...piiScrub.redactions];
    if (valRedactions.length > 0) {
      rebuilt.append(key, piiScrub.scrubbed);
      redactions.push(...valRedactions.map((r) => `param:${key}:${r}`));
      paramRedactions++;
    } else {
      rebuilt.append(key, value);
    }
  }
  if (paramRedactions > 0) {
    u.search = rebuilt.toString();
  }
  const pathScrub = scrubSecretsFromText(u.pathname);
  if (pathScrub.redactions.length > 0) {
    u.pathname = pathScrub.scrubbed;
    redactions.push(...pathScrub.redactions.map((r) => `path:${r}`));
  }
  if (u.hash) {
    const hashScrub = scrubSecretsFromText(u.hash);
    if (hashScrub.redactions.length > 0) {
      u.hash = hashScrub.scrubbed;
      redactions.push(...hashScrub.redactions.map((r) => `fragment:${r}`));
    }
  }
  return { scrubbed: u.toString(), redactions };
}

export interface ScrubArgsResult {
  scrubbed: unknown;
  redactions: string[];
}

const URLISH_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function scrubSecretsFromArgs(args: unknown, maxDepth = 8): ScrubArgsResult {
  const redactions: string[] = [];

  const walk = (v: unknown, depth: number): unknown => {
    if (depth > maxDepth) return v;
    if (typeof v === "string") {
      const r = URLISH_RE.test(v) ? scrubSecretsFromUrl(v) : scrubSecretsFromText(v);
      redactions.push(...r.redactions);
      return r.scrubbed;
    }
    if (Array.isArray(v)) return v.map((el) => walk(el, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val, depth + 1);
      }
      return out;
    }
    return v;
  };

  return { scrubbed: walk(args, 0), redactions };
}
