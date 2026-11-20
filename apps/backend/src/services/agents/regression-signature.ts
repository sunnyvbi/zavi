
import { createHash } from "node:crypto";

export const SIG_VERSION = 1;

export type CodeClass =
  | "parse_failed"
  | "dispatch_throw"
  | "tool_use_errored"
  | "tool_timeout"
  | "budget_exceeded"
  | "tool_iter_cap"
  | "failed"
  | "other";

export type OutcomeClass =
  | "failed"
  | "parse_failed"
  | "dispatch_error"
  | "empty"
  | "other";

export interface RawStep {
  tool_name?: string | null;
  code?: string | null;
}

export interface SignatureInput {
  agent_slug: string;
  engine?: string | null;
  failing_tool_name?: string | null;
  status?: string | null;
  raw_code?: string | null;
  outcome?: string | null;
  steps?: RawStep[];
}

export interface SignatureResult {
  signature: string;
  sig_version: number;
  code_class: CodeClass;
  outcome_class: OutcomeClass;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_RE = /\b(?:https?|wss?):\/\/[^\s'"]+/gi;
const PATH_RE = /(?:\/[A-Za-z0-9._-]+){2,}/g;
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONGHEX_RE = /\b[0-9a-f]{16,}\b/gi;
const DIGITS_RE = /\d+/g;

export function strictScrub(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(EMAIL_RE, "")
    .replace(URL_RE, "")
    .replace(UUID_RE, "")
    .replace(LONGHEX_RE, "")
    .replace(PATH_RE, "")
    .replace(DIGITS_RE, "")
    .toLowerCase()
    .replace(/[^a-z _.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function safeToolName(name: string | null | undefined): string {
  if (!name) return "none";
  return /^[a-z0-9_./-]{1,64}$/i.test(name) ? name.toLowerCase() : "unknown_tool";
}

export function classifyCodeClass(rawCode: string | null | undefined): CodeClass {
  if (!rawCode) return "other";
  const c = rawCode.toLowerCase();
  if (c.includes("parse_failed") || c.startsWith("parse")) return "parse_failed";
  if (c.startsWith("dispatch")) return "dispatch_throw";
  if (c.includes("tool_use_errored") || c.includes("is_error")) return "tool_use_errored";
  if (c.includes("timeout") || c.includes("timed out")) return "tool_timeout";
  if (c.includes("budget") || c.includes("cost_cap")) return "budget_exceeded";
  if (c.includes("iter") && c.includes("cap")) return "tool_iter_cap";
  return "other";
}

export function classifyOutcomeClass(
  status: string | null | undefined,
  outcome: string | null | undefined,
): OutcomeClass {
  if (outcome && outcome.toLowerCase() === "empty") return "empty";
  const s = (status ?? "").toLowerCase();
  if (s === "parse_failed") return "parse_failed";
  if (s === "dispatch_error") return "dispatch_error";
  if (s === "failed") return "failed";
  return "other";
}

export function buildSignaturePreimage(input: SignatureInput): {
  v: number;
  a: string;
  e: string;
  t: string;
  cc: CodeClass;
  oc: OutcomeClass;
  seq: Array<{ t: string; c: CodeClass }>;
} {
  const code_class = classifyCodeClass(input.raw_code);
  const outcome_class = classifyOutcomeClass(input.status, input.outcome);
  const seq = (input.steps ?? [])
    .map((s) => ({ t: safeToolName(s.tool_name), c: classifyCodeClass(s.code) }))
    .slice(0, 40);
  return {
    v: SIG_VERSION,
    a: strictScrub(input.agent_slug) || "unknown_agent",
    e: strictScrub(input.engine) || "unknown_engine",
    t: safeToolName(input.failing_tool_name),
    cc: code_class,
    oc: outcome_class,
    seq,
  };
}

export function computeRegressionSignature(
  input: SignatureInput,
): SignatureResult {
  const pre = buildSignaturePreimage(input);
  const signature = createHash("sha256")
    .update(JSON.stringify(pre))
    .digest("hex");
  return {
    signature,
    sig_version: SIG_VERSION,
    code_class: pre.cc,
    outcome_class: pre.oc,
  };
}
