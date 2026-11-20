
import type { DaemonOp } from "./types";
import type { DecisionEvidence } from "@/services/agents/decision-evidence";

const READ_OPS: ReadonlySet<string> = new Set([
  "nav",
  "text",
  "assert_text",
  "assert_url",
  "screenshot",
  "wait_for",
  "current_url",
  "page_outline",
  "ax_snapshot",
  "scroll",
  "resolve",
  "hover_ref",
  "hover_xy",
  "scroll_at",
  "zoom",
  "get_page_text",
  "wait_until",
  "nav_history",
  "history_go",
]);

export type BrowserOpClass = "read" | "write";

const SIDE_EFFECT_VERBS = [
  "confirm",
  "unsubscribe",
  "optout",
  "opt-out",
  "delete",
  "remove",
  "destroy",
  "approve",
  "reject",
  "decline",
  "cancel",
  "verify",
  "activate",
  "deactivate",
  "disable",
  "enable",
  "reset",
  "revoke",
  "pay",
  "checkout",
  "purchase",
  "subscribe",
] as const;
const SIDE_EFFECT_QUERY_KEYS = new Set(["action", "do", "cmd", "unsubscribe", "confirm"]);
const SEGMENT_RE = new RegExp(
  `^(?:${SIDE_EFFECT_VERBS.join("|")})(?:[-_].*)?$`,
  "i",
);

export function navLooksSideEffecting(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.some((seg) => SEGMENT_RE.test(decodeURIComponent(seg)))) return true;
  for (const key of u.searchParams.keys()) {
    if (SIDE_EFFECT_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

export function navTargetUrl(op: DaemonOp | { op?: unknown; url?: unknown }): string | null {
  const o = op as { op?: unknown; url?: unknown };
  return (o.op === "nav" || o.op === "history_go") && typeof o.url === "string" ? o.url : null;
}

export function classifyBrowserOp(op: DaemonOp | { op?: unknown }): BrowserOpClass {
  const name = typeof op?.op === "string" ? op.op : undefined;
  if (!name) return "write";
  return READ_OPS.has(name) ? "read" : "write";
}

export interface BrowserActionBody {
  op: string;
  selector?: string;
  value?: string;
  url?: string;
}

const MAX_SELECTOR_LEN = 2000;
const MAX_VALUE_LEN = 8000;
const MAX_URL_LEN = 4000;

export function buildBrowserActionBody(op: DaemonOp | { op?: unknown; [k: string]: unknown }): BrowserActionBody {
  const name = typeof op?.op === "string" ? op.op : "unknown";
  const body: BrowserActionBody = { op: name };
  const sel = (op as { selector?: unknown }).selector;
  if (typeof sel === "string") body.selector = sel.slice(0, MAX_SELECTOR_LEN);
  const val = (op as { value?: unknown }).value;
  if (typeof val === "string") body.value = val.slice(0, MAX_VALUE_LEN);
  const url = (op as { url?: unknown }).url;
  if (typeof url === "string") body.url = url.slice(0, MAX_URL_LEN);
  return body;
}

export function buildBrowserActionEvidence(body: BrowserActionBody): DecisionEvidence {
  const evidence: string[] = [`op: ${body.op}`];
  if (body.selector) evidence.push(`selector: ${body.selector.slice(0, 200)}`);
  if (body.url) evidence.push(`url: ${body.url.slice(0, 200)}`);
  return {
    reason_text:
      `Browser write \`${body.op}\` would run on the live page; it is gated for ` +
      `approval before execution (page-mutating actions are never auto-run — ` +
      `Bundle B item B-2 prompt-injection containment).`,
    evidence,
    alternatives_considered: [],
    reversibility: "irreversible",
    blast_radius: "ORANGE",
    confidence: 0.5,
  };
}
