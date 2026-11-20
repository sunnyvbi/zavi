
import { serviceClient } from "@/services/supabase";
import { sanitizeErrorMessage } from "./sanitize";
import { isCanonicalWorkerId, workerId } from "@/services/agents/boot-role";

export type LogLevel = "error" | "warn" | "info";

export const LOG_META_KEYS = [
  "agent_slug",
  "worker_id",
  "stage",
  "tool_name",
  "ms",
  "design_type",
  "design_source",
  "design_ms",
  "design_reason",
  "retry_count",
  "error_class",
  "failure_class",
  "http_status",
  "method",
  "path",
  "source_file",
  "source_line",
  "run_id_ref",
  "build_stage",
  "node_status",
  "node_id",
  "watchdog_age_ms",
  "tree_kb",
  "checkout_kb",
  "blob_count",
  "probe_ref_kind",
  "freed_kb",
  "free_kb_after",
  "gc_steps",
  "gate_rule",
  "gate_verdict",
  "gate_action",
  "step_index",
  "requested",
  "skipped_reason",
  "skipped_reasons",
  "vision_fix_outcome",
  "findings_before",
  "findings_after",
  "removed",
  "total",
  "batch_errors",
  "db_error_code",
  "driver",
  "decision_class",
  "count",
  "cap",
  "cost_usd",
  "logo_fail_reason",
  "logo_failure_stage",
  "surface",
  "families",
  "origin",
  "op",
  "engine",
  "platform",
  "profile_persisted",
  "passed_over",
  "served_by",
  "bytes",
  "captured",
  "event_id",
  "object_id",
  "amount",
  "currency",
  "money_model",
  "container_role",
  "prev_shutdown_clean",
  "boots_last_10m",
  "prompt_chars",
  "approx_tokens",
  "target_agent_slug",
  "gate_reason",
  "hypothesis_ref",
  "authorized",
  "reject_reason",
  "acceptance_mode",
  "acceptance_verdict",
  "acceptance_failed_invariant",
  "acceptance_pass_count",
  "acceptance_total",
  "acceptance_repairs",
  "review_outcome",
  "review_n",
  "cosine",
  "supersede_count",
  "blocked_by_trust",
  "blocked_by_date",
  "entities",
  "edges",
  "slug",
  "content_hash",
  "resume_entries",
  "resume_chars",
  "resume_approx_tokens",
  "resume_capped",
  "error_chars",
  "initiated_by_user",
  "exit_code",
  "timed_out",
  "has_rc_marker",
  "sandbox_id",
  "dead_letter_reason",
  "risk_class",
  "risk_score",
  "server_id",
  "table",
  "connector_slug",
  "token_days_remaining",
  "refresh_effective",
  "notice_bucket",
  "proxy_tier",
  "recovered",
  "creator_order_id",
  "reversal_shortfall_cents",
  "null_field",
  "rows_present",
  "row_count_total",
  "adapter_id",
  "deliverables",
  "rewritten",
  "claims_removed",
  "rejected_rewrites",
  "evidence_pages",
  "evidence_tool_results",
  "mechanical_removals",
  "input_tokens",
  "output_tokens",
  "purge_backlog",
  "purge_oldest_age_s",
  "artifacts_patched",
  "artifacts_unpatchable",
  "artifacts_unmatched",
  "unsourced_figures",
  "figures_checked",
  "figures_cut",
  "figures_kept",
  "chars_removed",
  "app_role",
  "invite_id",
  "target_id",
  "from_role",
  "to_role",
  "github_request_id",
  "ratelimit_remaining",
  "ratelimit_reset",
  "ratelimit_resource",
  "retry_after_s",
  "queue_ms",
  "prep_ms",
  "first_text_ms",
  "first_text_source",
  "model_ms",
  "tools_ms",
  "post_ms",
  "total_ms",
  "model_turns",
  "tool_calls",
  "tool_search_calls",
  "tool_ms",
  "outcome",
  "provider_api_ms",
  "cache_read_tokens",
  "cache_write_tokens",
  "review_score",
  "review_unsupported",
  "review_constraint_score",
  "review_constraint_issues",
  "review_target_score",
  "review_target_issues",
  "review_actions_score",
  "review_actions_issues",
  "review_effects_score",
  "review_effects_issues",
  "review_grounding_score",
  "review_grounding_issues",
  "dialect",
  "tables_found",
  "rescan_attempts",
  "rescan_age_ms",
  "caller",
  "graph_code",
  "subcode",
  "ad_account",
  "usage_pct",
  "regain_minutes",
  "home",
  "page_size",
  "changed",
  "rerouted",
  "cap_stripped",
  "final_status",
  "hold_reasons",
  "budget_raised",
  "approved_via",
] as const;

export type LogMetaKey = (typeof LOG_META_KEYS)[number];
export type LogMeta = Partial<Record<LogMetaKey, string | number>>;

const SAFE_ERROR_CLASSES = new Set<string>([
  "ExpectedToolError",
  "SafetyGateError",
  "ZodError",
  "TypeError",
  "RangeError",
  "SyntaxError",
]);

const MAX_MESSAGE = 2000;
const MAX_SOURCE = 64;
const MAX_CODE = 64;

export type LogEventInput = {
  level: LogLevel;
  source: string;
  code?: string;
  message?: string;
  error?: unknown;
  tenant_id?: string | null;
  run_id?: string | null;
  meta?: Record<string, unknown>;
};

function resolveMessage(input: LogEventInput): string | null {
  if (input.error !== undefined) {
    const e = input.error;
    const errorClass = e instanceof Error ? e.constructor.name : typeof e;
    if (e instanceof Error && SAFE_ERROR_CLASSES.has(errorClass)) {
      return sanitizeErrorMessage(e).slice(0, MAX_MESSAGE);
    }
    return `${errorClass}: omitted`.slice(0, MAX_MESSAGE);
  }
  if (typeof input.message === "string") {
    return sanitizeErrorMessage(input.message).slice(0, MAX_MESSAGE);
  }
  return null;
}

function sanitizeMeta(meta: Record<string, unknown> | undefined): Record<string, string | number> {
  if (!meta || typeof meta !== "object") return {};
  const out: Record<string, string | number> = {};
  for (const key of LOG_META_KEYS) {
    const v = meta[key];
    if (typeof v === "string") {
      out[key] = v.slice(0, 256);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = v;
    } else if (typeof v === "boolean") {
      out[key] = v ? 1 : 0;
    }
  }
  return out;
}

export async function logEvent(input: LogEventInput): Promise<void> {
  await logEventConfirmed(input);
}

export async function logEventConfirmed(input: LogEventInput): Promise<{ ok: boolean; error?: string }> {
  try {
    const level: LogLevel = input.level;
    const source = (input.source || "unknown").slice(0, MAX_SOURCE);
    const code = input.code ? input.code.slice(0, MAX_CODE) : null;
    const message = resolveMessage(input);
    const meta = sanitizeMeta(input.meta);
    delete meta.worker_id;
    const worker = workerId();
    if (!isCanonicalWorkerId(worker)) meta.worker_id = worker;
    const tenant_id = input.tenant_id ?? null;
    const run_id = input.run_id ?? null;

    const row = {
      level,
      source,
      code,
      message,
      tenant_id,
      run_id,
      meta,
    };

    let client;
    try {
      client = serviceClient();
    } catch (clientErr) {
      console.warn(
        `[logEvent] serviceClient unavailable for ${level} ${source}/${code ?? "-"}: ${(clientErr as Error).message}`,
      );
      return { ok: false, error: "service_client_unavailable" };
    }

    const { error } = await client.from("praxis_logs").insert(row);
    if (error) {
      const code = (error as { code?: string }).code ?? "";
      if (code === "42P01" || /relation .* does not exist/i.test(error.message)) {
        console.warn(
          `[logEvent] praxis_logs table not yet provisioned — apply migration 20260517072240_praxis_logs.sql. Event was: ${level} ${source}/${input.code ?? "-"}`,
        );
      } else {
        console.warn(
          `[logEvent] insert failed for ${level} ${source}/${input.code ?? "-"}: ${error.message}`,
        );
      }
      return { ok: false, error: String(error.message ?? "insert failed").slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    try {
      console.warn(`[logEvent] unhandled in helper: ${(e as Error).message}`);
    } catch {
    }
    return { ok: false, error: "unhandled" };
  }
}
