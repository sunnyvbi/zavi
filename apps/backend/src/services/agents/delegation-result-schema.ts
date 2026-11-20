
import { z } from "zod";
import type { DispatcherResult } from "./types";
import type { ToolCallTrace } from "@/services/tools/types";

export const DelegatedChildResult = z.object({
  run_id: z.string(),
  agent_slug: z.string(),
  status: z.enum(["success", "parse_failed", "error"]),
  parse_ok: z.boolean(),
  output_text: z.string().default(""),
  receipts: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
});
export type DelegatedChildResult = z.infer<typeof DelegatedChildResult>;

const PR_LINK_RE =
  /\bhttps?:\/\/(?:github|gitlab)\.com\/[^\s)]+\/(?:pull|merge_requests|-\/merge_requests)\/\d+/gi;
const PR_NUM_RE = /(?:^|\s)(#\d{1,6})\b/g;
const SIDE_EFFECTING_TOOL_RE =
  /(?:create_pr|open_pr|pull_request|__commit|gmail__send|slack__|__post|__send|create_issue|create_ticket|emit_decision|deploy)/i;

export function extractReceipts(
  output_text: string | null | undefined,
  tool_calls:
    | ReadonlyArray<Pick<ToolCallTrace, "name"> | { name?: string | null }>
    | null
    | undefined,
): string[] {
  const receipts: string[] = [];
  const text = typeof output_text === "string" ? output_text : "";
  for (const m of text.matchAll(PR_LINK_RE)) {
    receipts.push(`pr_url:${m[0]}`);
  }
  for (const m of text.matchAll(PR_NUM_RE)) {
    receipts.push(`pr_ref:${m[1]}`);
  }
  if (Array.isArray(tool_calls)) {
    for (const t of tool_calls) {
      if (t && typeof t.name === "string" && SIDE_EFFECTING_TOOL_RE.test(t.name)) {
        receipts.push(`tool:${t.name}`);
      }
    }
  }
  return [...new Set(receipts)];
}

export function buildDelegatedChildResult(args: {
  run_id: string;
  agent_slug: string;
  status: "success" | "parse_failed" | "error" | "failed";
  result: DispatcherResult | null;
  error?: string | null;
}): DelegatedChildResult {
  const r = args.result;
  const status: DelegatedChildResult["status"] =
    args.status === "success"
      ? "success"
      : args.status === "parse_failed"
        ? "parse_failed"
        : "error";
  const output_text =
    (r?.output_text && r.output_text.length > 0 && r.output_text) ||
    (r?.raw_response_text && r.raw_response_text.length > 0 && r.raw_response_text) ||
    "";
  return DelegatedChildResult.parse({
    run_id: args.run_id,
    agent_slug: args.agent_slug,
    status,
    parse_ok: r?.parse_ok ?? false,
    output_text,
    receipts: extractReceipts(r?.output_text, r?.tool_calls),
    error: args.error ?? r?.parse_error ?? null,
  });
}
