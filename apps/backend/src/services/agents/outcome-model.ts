
import type { ToolCallTrace } from "@/services/tools/types";
import { hasMutatingSideEffect } from "./liveness/mutating-tools";

export type SideEffectKind = "shipped" | "refused" | "none" | "unknown";

export const REFUSAL_REASON_CODES = ["wrong_repo", "needs_input", "blocked", "no_change"] as const;
export type RefusalReasonCode = (typeof REFUSAL_REASON_CODES)[number];

export function asRefusalReasonCode(v: unknown): RefusalReasonCode | undefined {
  return typeof v === "string" && (REFUSAL_REASON_CODES as readonly string[]).includes(v)
    ? (v as RefusalReasonCode)
    : undefined;
}

export type LivenessTier = "shipped" | "answered" | "plan_only" | "empty";

export type FailureClass =
  | "none"
  | "envelope"
  | "infra"
  | "model_error"
  | "policy_refusal"
  | "cancelled"
  | "tool_no_output";

export type RunOutcome = {
  deliverable: string | null;
  side_effect: {
    kind: SideEffectKind;
    reason?: string;
    detail?: string;
    reason_code?: RefusalReasonCode;
  };
  customer_summary?: string | null;
  failure: {
    class: FailureClass;
    raw_error?: string | null;
  };
  liveness_tier: LivenessTier;
};

export type DeriveOutcomeInput = {
  refused?: boolean;
  status: string;
  outputText?: string | null;
  error?: string | null;
  parseError?: string | null;
  sideEffect?: {
    kind: "shipped" | "refused" | "none";
    reason?: string;
    detail?: string;
    reason_code?: RefusalReasonCode;
  };
  customerSummary?: string | null;
  toolCalls?: ToolCallTrace[] | null;
};

function resolveSideEffect(
  input: DeriveOutcomeInput,
  fallbackKind: SideEffectKind,
): RunOutcome["side_effect"] {
  return input.sideEffect ?? { kind: fallbackKind };
}

export const SITE_PREP_PLATFORM_FAILURE_RE =
  /^\s*(?:resetSiteRepo: git failed|onSiteSandboxReady: the running preview could not be stopped)/i;

const INFRA_RE =
  /boot_reap|watchdog_reap|stale_reap|orphaned by container|no progress for|inngest|exhausted retries|http_unreachable/i;

function classifyError(rawError: string | null | undefined): FailureClass {
  const e = (rawError ?? "").toString();
  if (e.trim().length === 0) return "model_error";
  if (INFRA_RE.test(e) || SITE_PREP_PLATFORM_FAILURE_RE.test(e)) return "infra";
  return "model_error";
}

function classifyLiveness(input: DeriveOutcomeInput, deliverable: string | null): LivenessTier {
  const stamped = input.sideEffect != null;
  const hasDeliverable = deliverable != null && deliverable.trim().length > 0;

  if (stamped) {
    const kind = input.sideEffect!.kind;
    if (kind === "shipped") return "shipped";
    if (kind === "refused") return "plan_only";
    return hasDeliverable ? "answered" : "empty";
  }

  if (hasMutatingSideEffect(input.toolCalls)) return "shipped";
  return hasDeliverable ? "answered" : "empty";
}

const GENERATION_TOOL_RE =
  /generate_image|generate_video|generate_audio|render_social_image|render_pdf|render_video|generate_3d/i;

export function detectToolNoOutput(
  toolCalls: DeriveOutcomeInput["toolCalls"],
): { tool: string; reason: string } | null {
  for (const tc of toolCalls ?? []) {
    if (!GENERATION_TOOL_RE.test(tc?.name ?? "")) continue;
    const preview = tc?.output_preview ?? "";
    if (!preview) continue;
    if (!preview.includes("skipped") || !preview.includes("generated")) continue;

    const generated = preview.match(/\\?"generated\\?"\s*:\s*(\d+)/);
    const typeset = preview.match(/\\?"typeset\\?"\s*:\s*(\d+)/);
    const cached = preview.match(/\\?"cached\\?"\s*:\s*(\d+)/);
    if (!generated) continue;

    const produced =
      Number(generated[1]) + Number(typeset?.[1] ?? 0) + Number(cached?.[1] ?? 0);
    if (produced > 0) continue;

    const reason = preview.match(/\\?"reason\\?"\s*:\s*\\?"([^"\\]{1,80})/);
    const detail = preview.match(/\\?"detail\\?"\s*:\s*\\?"((?:[^"\\]|\\.){1,160}?)\\?"[,}]/);
    if (!reason && !detail) continue;

    return {
      tool: tc.name ?? "unknown",
      reason: detail?.[1] ?? reason?.[1] ?? "produced no output",
    };
  }
  return null;
}

export function deriveOutcome(input: DeriveOutcomeInput): RunOutcome {
  const outcome = deriveOutcomeCore(input);
  const summary = typeof input.customerSummary === "string" ? input.customerSummary.trim() : "";
  return summary.length > 0 ? { ...outcome, customer_summary: summary } : outcome;
}

function deriveOutcomeCore(input: DeriveOutcomeInput): RunOutcome {
  const { status } = input;
  const out = (input.outputText ?? "").trim();

  if (status === "failed" && input.refused === true) {
    return {
      deliverable: null,
      ...(out.length > 0 ? { customer_summary: out } : {}),
      side_effect: { kind: "refused" },
      failure: { class: "policy_refusal", raw_error: input.error ?? null },
      liveness_tier: "empty",
    };
  }

  if (status === "success") {
    const deliverable = out.length > 0 ? out : null;
    const noOutput = detectToolNoOutput(input.toolCalls);
    return {
      deliverable,
      side_effect: resolveSideEffect(input, "unknown"),
      failure: noOutput
        ? { class: "tool_no_output", raw_error: `${noOutput.tool}: ${noOutput.reason}` }
        : { class: "none", raw_error: null },
      liveness_tier: classifyLiveness(input, deliverable),
    };
  }

  if (status === "cancelled") {
    const deliverable = out.length > 0 ? out : null;
    return {
      deliverable,
      side_effect: resolveSideEffect(input, "none"),
      failure: { class: "cancelled", raw_error: null },
      liveness_tier: classifyLiveness(input, deliverable),
    };
  }

  if (out.length > 0) {
    return {
      deliverable: out,
      side_effect: resolveSideEffect(input, "unknown"),
      failure: { class: status === "parse_failed" ? "envelope" : "none", raw_error: null },
      liveness_tier: classifyLiveness(input, out),
    };
  }

  const rawError =
    status === "parse_failed"
      ? input.parseError ?? input.error ?? null
      : input.error ?? null;
  return {
    deliverable: null,
    side_effect: resolveSideEffect(input, "none"),
    failure: {
      class: status === "parse_failed" ? "envelope" : classifyError(rawError),
      raw_error: rawError,
    },
    liveness_tier: classifyLiveness(input, null),
  };
}

export const EMPTY_COMPLETION_ERROR =
  "empty_completion: agent produced no output_text and no decision";

const REPLY_EXPECTING_TRIGGERS: ReadonlySet<string> = new Set(["chat", "slack"]);

export function isReplyExpectingTrigger(trigger: string | null | undefined): boolean {
  return typeof trigger === "string" && REPLY_EXPECTING_TRIGGERS.has(trigger);
}

export function shouldFailEmptyCompletion(args: {
  enabled: boolean;
  status: string;
  trigger: string | null | undefined;
  livenessTier: LivenessTier;
  decisionCount: number;
}): boolean {
  if (!args.enabled) return false;
  if (args.status !== "success") return false;
  if (!isReplyExpectingTrigger(args.trigger)) return false;
  if (args.livenessTier !== "empty") return false;
  return args.decisionCount === 0;
}
