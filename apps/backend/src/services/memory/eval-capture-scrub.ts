
import { githubTokenRegex } from "@/services/security/github-token-pattern";

const MAX_QUERY_LEN = 51200;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE =
  /(?<!\w)(?:\+?\d{1,3}[-.\s])?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\w|\d)/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CC_CANDIDATE_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const API_KEY_RE =
  /\b(sk-[A-Za-z0-9]{20,}|sk_(?:live|test)_[A-Za-z0-9]{20,}|rk_(?:live|test)_[A-Za-z0-9]{20,})\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g;
const PEM_RE = /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g;
const GITHUB_TOKEN_RE = githubTokenRegex("g");
const SLACK_TOKEN_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const LINEAR_KEY_RE = /\blin_api_[A-Za-z0-9]{20,}\b/g;

function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = parseInt(d[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function scrubQueryForCapture(input: string): string {
  if (typeof input !== "string") return "";
  let out = input;

  out = out.replace(PEM_RE, "[PEM]");
  out = out.replace(JWT_RE, "[JWT]");
  out = out.replace(AWS_KEY_RE, "[AWS_KEY]");
  out = out.replace(API_KEY_RE, "[API_KEY]");
  out = out.replace(BEARER_RE, "[BEARER]");
  out = out.replace(GITHUB_TOKEN_RE, "[GITHUB_TOKEN]");
  out = out.replace(SLACK_TOKEN_RE, "[SLACK_TOKEN]");
  out = out.replace(LINEAR_KEY_RE, "[LINEAR_KEY]");

  out = out.replace(EMAIL_RE, "[EMAIL]");
  out = out.replace(SSN_RE, "[SSN]");
  out = out.replace(PHONE_RE, "[PHONE]");
  out = out.replace(CC_CANDIDATE_RE, (match) => (luhnValid(match) ? "[CARD]" : match));

  if (out.length > MAX_QUERY_LEN) {
    out = out.slice(0, MAX_QUERY_LEN - 14) + "[…truncated]";
  }
  return out;
}

export const _MAX_QUERY_LEN = MAX_QUERY_LEN;
