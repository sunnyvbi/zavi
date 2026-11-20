
import { z } from "zod";
import { xmlEscapeContent } from "@/services/onboarding/enrichment/sanitize";

export const BROWSER_TASK_STATUSES = ["done", "partial", "blocked", "busy", "disabled"] as const;
export type BrowserTaskStatus = (typeof BROWSER_TASK_STATUSES)[number];

export const BROWSER_TASK_BLOCKED_REASONS = [
  "login_required",
  "captcha",
  "needs_interaction",
  "private_address",
  "off_origin",
  "step_limit",
  "time_limit",
  "page_error",
  "invalid_input",
  "busy",
  "disabled",
] as const;
export type BrowserTaskBlockedReason = (typeof BROWSER_TASK_BLOCKED_REASONS)[number];

export const UNTRUSTED_OPEN = "<untrusted_web_content>";
export const UNTRUSTED_CLOSE = "</untrusted_web_content>";

export function wrapUntrusted(text: string, max = Infinity): string {
  const room = Math.max(0, max - UNTRUSTED_OPEN.length - UNTRUSTED_CLOSE.length - 2);
  let body = xmlEscapeContent(String(text ?? ""));
  if (body.length > room) body = `${body.slice(0, Math.max(0, room - 1))}…`;
  return `${UNTRUSTED_OPEN}\n${body}\n${UNTRUSTED_CLOSE}`;
}

export const ANSWER_MAX_CHARS = 2_000;
export const FACTS_MAX = 10;
export const FACT_MAX_CHARS = 300;
const URL_MAX_CHARS = 2_048;
const REASON_MAX_CHARS = 300;

export const browserTaskResultSchema = z
  .object({
    status: z.enum(BROWSER_TASK_STATUSES),
    answer: z.string().max(ANSWER_MAX_CHARS),
    facts: z.array(z.string().max(FACT_MAX_CHARS)).max(FACTS_MAX),
    final_url: z.string().max(URL_MAX_CHARS).nullable(),
    blocked_reason: z.enum(BROWSER_TASK_BLOCKED_REASONS).optional(),
    blocked_detail: z.string().max(REASON_MAX_CHARS).optional(),
    screenshot_artifact_ids: z.array(z.string()).max(3),
    see_what_i_saw_url: z.string().optional(),
    billing_uncertain: z.literal(true).optional(),
  })
  .strict();

export type BrowserTaskResult = z.infer<typeof browserTaskResultSchema>;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function clampResult(r: {
  status: BrowserTaskStatus;
  answer: string;
  facts: string[];
  final_url: string | null;
  blocked_reason?: BrowserTaskBlockedReason;
  blocked_detail?: string;
  screenshot_artifact_ids: string[];
}): BrowserTaskResult {
  return {
    status: r.status,
    answer: clip(String(r.answer ?? ""), ANSWER_MAX_CHARS),
    facts: (r.facts ?? [])
      .map((f) => clip(String(f).trim(), FACT_MAX_CHARS))
      .filter((f) => f.length > 0)
      .slice(0, FACTS_MAX),
    final_url: r.final_url ? clip(r.final_url, URL_MAX_CHARS) : null,
    ...(r.blocked_reason ? { blocked_reason: r.blocked_reason } : {}),
    ...(r.blocked_detail && r.blocked_detail.trim()
      ? { blocked_detail: clip(r.blocked_detail.trim(), REASON_MAX_CHARS) }
      : {}),
    screenshot_artifact_ids: (r.screenshot_artifact_ids ?? []).slice(0, 3),
  };
}
