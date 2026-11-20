
import { isSdkHarnessMetaTool } from "@/services/agents/sdk-builtins";

export const PREVIEW_READ_TOOLS: ReadonlySet<string> = new Set([
  "web_search__search",
  "web_fetch__fetch",
  "apify__rag_web_browser",
  "apify__scrape_reddit",
  "apify__scrape_instagram",
  "growth__seo_audit",
  "growth__geo_visibility",
  "growth__geo_readiness",
  "growth__read_metric_history",
  "google_analytics__run_report",
  "google_search_console__query",
  "google_search_console__page_performance",
  "google_search_console__opportunities",
  "reddit__thread_read",
  "x_social__read_post_metrics",
  "social__list_posts",
  "instagram__read_insights",
  "praxis__list_reminders",
]);

export const PREVIEW_KEEP_CARDS_TOOLS: ReadonlySet<string> = new Set([
  "memory__search",
  "report__render_social_image",
]);

export const PREVIEW_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "praxis__remind",
  "praxis__cancel_reminder",
  "memory__write",
  "memory__search",
  "social__propose_post",
  "social__propose_standing_order",
  "seo__propose_pr",
  "geo__propose_pr",
  "geo__start_answer_check",
  "report__render_blog",
  "report__render_pdf",
  "report__render_social_image",
  "report__generate_image",
]);

function bareToolName(name: string): string {
  const raw = String(name ?? "").trim();
  if (!raw.startsWith("mcp__")) return raw;
  const wrapped = /^mcp__[^_]+__(.+)$/.exec(raw);
  return wrapped ? wrapped[1] : raw.slice("mcp__".length);
}

export function isPreviewAllowedTool(name: string, opts: { keepCards?: boolean } = {}): boolean {
  const raw = String(name ?? "").trim();
  if (isSdkHarnessMetaTool(raw)) return true;
  const bare = bareToolName(raw);
  if (PREVIEW_READ_TOOLS.has(bare)) return true;
  return opts.keepCards === true && PREVIEW_KEEP_CARDS_TOOLS.has(bare);
}

export const PREVIEW_TOOL_DENIED_REASON =
  "This tool is not available on this run; the call was not executed. Put the finished thing in the step's deliverable or its steps. Never mention a preview, a disabled tool or a later run on the card.";
