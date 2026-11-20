
import { globalClient } from "@/services/tenant-client";
import { getDeclaredDialect } from "@/services/tools/operator-db/catalog";
import { logEvent } from "@/services/logging/logEvent";
import { isCustomAgentSlug } from "@/services/billing/tiers";
import { internalToolEffects } from "@/services/mcp/tool-effects";
import type { ToolEffect } from "@/services/tools/types";
import { consumeBudgetOrReject, estimateRunCost, resolveDailyCapUsd, utcDay } from "./budget";
import {
  detectPunt,
  detectRecordAsk,
  isResearchAsk,
  isPuntRetry,
  withPuntRetry,
  type PuntClass,
} from "./punt-detector";

export { puntGuardNoteFromPayload, withPuntRetry, PUNT_RETRY_FLAG } from "./punt-detector";
import type { AgentContext, DispatcherResult } from "./types";

const MESSAGING_TRIGGERS: ReadonlySet<string> = new Set([
  "slack",
  "email",
  "teams",
  "whatsapp",
  "imessage",
  "telegram",
  "discord",
]);

export function isFounderFacingRun(ctx: AgentContext): boolean {
  if (ctx.draft_mode === true) return false;
  if (ctx.trigger === "chat") return !ctx.batch_id;
  if (MESSAGING_TRIGGERS.has(ctx.trigger)) return true;
  if (ctx.slackRouting || ctx.emailRouting) return true;
  if (ctx.trigger === "cron" && isCustomAgentSlug(ctx.agent.slug)) return true;
  return false;
}

function normalizeToolName(name: string): string {
  if (name.startsWith("mcp__server__")) return name.slice("mcp__server__".length);
  const wrapped = /^mcp__[^_]+__(.+__.+)$/.exec(name);
  if (wrapped) return wrapped[1];
  if (name.startsWith("mcp__")) return name.slice("mcp__".length);
  return name;
}

const READ_BUILTINS: ReadonlySet<string> = new Set([
  "WebFetch",
  "WebSearch",
  "Read",
  "Grep",
  "Glob",
  "TodoWrite",
  "ToolSearch",
  "Skill",
]);
const REMOTE_READ_VERBS = ["list", "get", "read", "search", "fetch", "find", "query", "describe", "check"];

let DECLARED: Map<string, ToolEffect> | null = null;
function declaredEffects(): Map<string, ToolEffect> {
  if (!DECLARED) DECLARED = internalToolEffects();
  return DECLARED;
}

export function isWriteToolCall(
  rawName: string,
  effects: Map<string, ToolEffect> = declaredEffects(),
): boolean {
  const name = normalizeToolName(rawName);
  const declared = effects.get(name);
  if (declared) return declared !== "read";
  const sep = name.indexOf("__");
  if (sep < 0) return !READ_BUILTINS.has(name);
  const tool = name.slice(sep + 2);
  const bare = tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
  return !REMOTE_READ_VERBS.some((v) => bare === v || bare.startsWith(`${v}_`));
}

export function firstAttemptMayHaveWritten(
  result: DispatcherResult,
  isWrite: (name: string) => boolean = (n) => isWriteToolCall(n),
): boolean {
  if (result.side_effect?.kind === "shipped") return true;
  if (result.connector_request || result.custom_agent_card) return true;
  return (result.tool_calls ?? []).some((t) => isWrite(t.name));
}

const CAPABILITY_TOOL = /^(?:web_fetch|web_search|apify|browser|product)__|^praxis__(?:handoff|run_site_check|ask_agent)$/;

export function capabilityToolNames(resolved: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of resolved ?? []) {
    const n = normalizeToolName(raw);
    if (CAPABILITY_TOOL.test(n) && !out.includes(n)) out.push(n);
    if (out.length >= 8) break;
  }
  return out;
}

const isDataTool = (name: string) => normalizeToolName(name).startsWith("operator_db__");

export function skippedDataLookup(result: DispatcherResult): boolean {
  if (!(result.resolved_tool_names ?? []).some(isDataTool)) return false;
  const called = (result.tool_calls ?? []).map((t) => t.name ?? "");
  if (called.some(isDataTool)) return false;
  if (!called.some((n) => n && n !== "ToolSearch")) return false;
  return detectRecordAsk(result.output_text);
}

const isSearchTool = (name: string) => {
  const n = normalizeToolName(name);
  return n.startsWith("web_search__") || n === "WebSearch" || n === "apify__rag_web_browser";
};

function chatAsk(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const m = typeof p.current_user_text_raw === "string" ? p.current_user_text_raw : p.current_message;
  return typeof m === "string" ? m : null;
}

export function skippedWebSearch(ctx: AgentContext, payload: unknown, result: DispatcherResult): boolean {
  if (ctx.trigger !== "chat") return false;
  if (!result.output_text || result.output_text.trim().length === 0) return false;
  if (result.clarify_envelope) return false;
  if (!(result.resolved_tool_names ?? []).some((n) => normalizeToolName(n).startsWith("web_search__"))) return false;
  if ((result.tool_calls ?? []).some((t) => isSearchTool(t.name ?? ""))) return false;
  return isResearchAsk(chatAsk(payload));
}

export const WEB_SEARCH_RETRY_NOTE =
  "Your previous attempt answered a question about the outside world (options, pricing, policy, fit) " +
  "from memory. Run web_search__search first (more than one query if the question has parts), read " +
  "the best sources with web_fetch__fetch where useful, then answer from what you found and name " +
  "the sources. If a page will not load, search for it instead of guessing.";

export async function tenantHasBusinessDb(tenantId: string): Promise<boolean> {
  try {
    return (await getDeclaredDialect(tenantId)) !== null;
  } catch {
    return false;
  }
}

export const RECORD_LOOKUP_RETRY_NOTE =
  "Your previous attempt asked the founder for a record's ID instead of looking it up. You have the " +
  "business database (operator_db__catalog, then operator_db__query). Find the record yourself from what " +
  "the founder gave you (names, titles, places, prices, anything visible in an attached screenshot), read " +
  "its fields, and answer from them; read code only for a field that looks wrong. Ask the founder only if " +
  "that lookup finds nothing, and say what you searched for.";

export function buildPuntRetryNote(tools: readonly string[]): string {
  const have = tools.length > 0 ? `You have these tools: ${tools.join(", ")}. ` : "";
  return (
    `Your previous attempt told the founder to do the task themselves. ${have}` +
    `Do the task with these tools instead of telling the founder to do it; if it truly needs the founder ` +
    `(login, approval, a connector only they can add), say exactly what and why.`
  );
}

export async function isPuntGuardEnabled(sb?: ReturnType<typeof globalClient>): Promise<boolean> {
  try {
    const { data, error } = await (sb ?? globalClient())
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return true;
    return (data?.blob ?? {}).punt_guard_enabled !== false;
  } catch {
    return true;
  }
}

export function mergeAttemptUsage(
  a: DispatcherResult["usage"],
  b: DispatcherResult["usage"],
): DispatcherResult["usage"] {
  const merged: DispatcherResult["usage"] = {
    input_tokens: (a?.input_tokens ?? 0) + (b?.input_tokens ?? 0),
    output_tokens: (a?.output_tokens ?? 0) + (b?.output_tokens ?? 0),
    cache_creation_input_tokens:
      (a?.cache_creation_input_tokens ?? 0) + (b?.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (a?.cache_read_input_tokens ?? 0) + (b?.cache_read_input_tokens ?? 0),
  };
  if (typeof a?.cost_usd === "number" && typeof b?.cost_usd === "number") {
    merged.cost_usd = a.cost_usd + b.cost_usd;
  }
  return merged;
}

export type PuntGuardOutcome =
  | "recovered"
  | "published_as_is"
  | "skipped_disabled"
  | "skipped_wrote"
  | "skipped_bespoke"
  | "budget_blocked"
  | "retry_failed"
  | "retry_threw_usage_unknown";

export async function reserveRetryBudget(ctx: AgentContext): Promise<boolean> {
  try {
    const estimate = estimateRunCost(ctx.agent.metadata_praxis.cost_class);
    const dailyCap = await resolveDailyCapUsd(ctx.tenant_id);
    return await consumeBudgetOrReject({ tenant_id: ctx.tenant_id, estimate, dailyCap, day: utcDay() });
  } catch {
    return false;
  }
}

export type PuntGuardDeps = {
  isEnabled?: () => Promise<boolean>;
  hasBusinessDb?: (tenantId: string) => Promise<boolean>;
  reserveBudget?: (ctx: AgentContext) => Promise<boolean>;
  isWriteTool?: (name: string) => boolean;
  log?: (outcome: PuntGuardOutcome, cls: PuntClass) => void;
};

export async function applyPuntGuard(args: {
  ctx: AgentContext;
  payload: unknown;
  result: DispatcherResult;
  rerun: ((payload: Record<string, unknown>) => Promise<DispatcherResult>) | null;
  deps?: PuntGuardDeps;
}): Promise<DispatcherResult> {
  const { ctx, payload, result, rerun } = args;
  if (isPuntRetry(payload) || !isFounderFacingRun(ctx)) return result;
  const first = detectPunt(result.output_text);
  const cls: PuntClass | null =
    first.punt && first.matched
      ? first.matched
      : skippedDataLookup(result) &&
          (await (args.deps?.hasBusinessDb ?? tenantHasBusinessDb)(ctx.tenant_id))
        ? "asked_for_record"
        : skippedWebSearch(ctx, payload, result)
          ? "skipped_web_search"
          : null;
  if (!cls) return result;
  const log =
    args.deps?.log ??
    ((outcome: PuntGuardOutcome, c: PuntClass) => {
      void logEvent({
        level: outcome === "published_as_is" ? "warn" : "info",
        source: "agents.punt_guard",
        code: `review.punt_guard_${outcome}`,
        tenant_id: ctx.tenant_id,
        run_id: ctx.runId,
        meta: { agent_slug: ctx.agent.slug, review_outcome: outcome, failure_class: c },
      });
    });

  if (!rerun) {
    log("skipped_bespoke", cls);
    return result;
  }
  if (!(await (args.deps?.isEnabled ?? isPuntGuardEnabled)())) {
    log("skipped_disabled", cls);
    return result;
  }
  if (firstAttemptMayHaveWritten(result, args.deps?.isWriteTool)) {
    log("skipped_wrote", cls);
    return result;
  }

  if (!(await (args.deps?.reserveBudget ?? reserveRetryBudget)(ctx))) {
    log("budget_blocked", cls);
    return result;
  }

  const note =
    cls === "asked_for_record"
      ? RECORD_LOOKUP_RETRY_NOTE
      : cls === "skipped_web_search"
        ? WEB_SEARCH_RETRY_NOTE
        : buildPuntRetryNote(capabilityToolNames(result.resolved_tool_names));
  let retry: DispatcherResult;
  try {
    retry = await rerun(withPuntRetry(payload, note));
  } catch (e) {
    console.warn(`[punt-guard] retry threw on ${ctx.runId}: ${(e as Error).message}`);
    log("retry_threw_usage_unknown", cls);
    return result;
  }
  const usage = mergeAttemptUsage(result.usage, retry.usage);
  const tool_calls = [...(result.tool_calls ?? []), ...(retry.tool_calls ?? [])];
  if (ctx.provenanceToolCalls) ctx.provenanceToolCalls.current = tool_calls;
  if (!retry.output_text || retry.output_text.trim().length === 0) {
    log("retry_failed", cls);
    return { ...result, usage, tool_calls };
  }
  const second = detectPunt(retry.output_text);
  const stillSkipped = cls === "skipped_web_search" && skippedWebSearch(ctx, payload, retry);
  log(second.punt || stillSkipped ? "published_as_is" : "recovered", second.matched ?? cls);
  return { ...retry, usage, tool_calls };
}
