
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import { DEFAULT_AGENT_MODEL } from "@/services/llm/models";
import type { RefusalReasonCode, RunOutcome } from "./outcome-model";
import type { RunDisplayState } from "./run-display-state";
import type { MemoryDocSlug } from "@/services/memory/loader";
import type { ToolCallTrace } from "@/services/tools/types";
import type { ActorAuthorityEnvelopeV1 } from "@/services/agents/actor-envelope";

export type { MemoryDocSlug } from "@/services/memory/loader";

export const AGENT_RUNTIMES = ["sdk", "subprocess"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export const AGENT_COST_CLASSES = ["cheap", "standard", "expensive"] as const;
export type AgentCostClass = (typeof AGENT_COST_CLASSES)[number];

export const AGENT_SLA_CLASSES = [
  "realtime",
  "hourly",
  "prompt",
  "daily",
  "weekly",
  "bulk",
] as const;
export type AgentSlaClass = (typeof AGENT_SLA_CLASSES)[number];

export const AgentMetadataSchema = z
  .object({
    model: z.string().min(1).optional(),
    model_policy: z.literal("default").optional(),
    provider: z
      .enum(["anthropic", "openai", "bedrock", "fireworks", "langchain"])
      .optional(),
    version: z.number().int().min(1).optional(),
    manual_only: z.boolean().default(true),
    custom: z.boolean().optional(),
    chat_eligible: z.boolean().default(true),
    side_effects: z.boolean().default(false),
    cost_class: z.enum(AGENT_COST_CLASSES).default("standard"),
    sla_class: z.enum(AGENT_SLA_CLASSES).optional(),
    kill_switch: z.boolean().default(true),
    decision_class: z.string().optional(),
    impact_classes: z.array(z.string()).default([]),
    cron: z.string().optional().default(""),
    triggers: z.array(z.string()).default([]),
    runtime: z.enum(AGENT_RUNTIMES).default("sdk"),
    department: z
      .enum(["leadership", "product", "growth", "others"])
      .default("others"),
    tools: z.array(z.string()).default([]),
    output_envelope: z.string().optional(),
    prose_fallback: z.boolean().default(false),
    response_contract: z.enum(["auto", "digest", "terse"]).default("auto"),
    chat_thought_partner_mode: z.boolean().default(false),
    tool_iter_cap: z.number().int().min(10).max(120).optional(),
    requires_sandbox: z.boolean().default(false),
    model_routing: z
      .object({
        base: z.enum(["opus", "sonnet", "haiku"]).default("sonnet"),
        escalate_to: z.enum(["opus"]).default("opus"),
        floor_payload_stage: z.boolean().default(false),
        floor_keywords: z.array(z.string()).default([]),
        classifier: z.boolean().default(true),
        light_payload_stages: z.array(z.string()).default([]),
        default_depth: z.enum(["light", "deep"]).default("light"),
        light_model: z.string().regex(/^claude-[a-z0-9-]+$/).optional(),
        deep_model: z.string().regex(/^claude-[a-z0-9-]+$/).optional(),
        floor_keywords_v1: z.array(z.string()).optional(),
      })
      .optional(),
    memory_layer: z.boolean().default(true),
    recall_policy: z
      .enum(["always", "live_state_aware"])
      .default("live_state_aware"),
    inherits: z.array(z.string()).default([]),
    setup: z
      .object({
        rationale: z.string().optional().default(""),
        vault_keys: z
          .array(
            z.object({
              key: z.string().min(1).max(80),
              label: z.string().min(1),
              input: z
                .enum(["text", "email", "password", "url"])
                .default("text"),
              required: z.boolean().default(false),
              placeholder: z.string().optional(),
            }),
          )
          .default([]),
        connectors: z.array(z.string()).default([]),
        chat_requires_connect: z.boolean().optional(),
        optional_connectors: z.array(z.string()).default([]),
      })
      .optional(),
    visibility: z
      .object({
        default_state: z
          .enum(["enabled", "disabled", "always_on"])
          .default("enabled"),
        channel_only: z.boolean().optional(),
        recommended_for_shapes: z.array(z.string()).optional(),
        hidden_for_shapes: z.array(z.string()).optional(),
      })
      .optional()
      .default({ default_state: "enabled" }),
    capabilities: z
      .object({
        money_path: z.boolean().default(false),
        reads_operator_db: z.boolean().default(false),
        emits_artifact: z.boolean().default(false),
        structured_clarifications: z.boolean().default(false),
      })
      .default({
        money_path: false,
        reads_operator_db: false,
        emits_artifact: false,
        structured_clarifications: false,
      }),
  })
  .superRefine((meta, ctx) => {
    if (!meta.model && meta.model_policy !== "default") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model"],
        message: "model is required unless model_policy is default",
      });
    }
    if (meta.model && meta.model_policy === "default") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model_policy"],
        message: "declare either model or model_policy, not both",
      });
    }
  })
  .transform((meta) => ({
    ...meta,
    model: meta.model ?? DEFAULT_AGENT_MODEL,
  }));
export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;

export type AgentDefinition = {
  slug: string;
  name: string;
  description: string;
  body_markdown: string;
  body_path: string;
  content_hash: string;
  metadata_praxis: AgentMetadata;
};

export const TenantConfigSchema = z.object({
  tenant_id: z.string().min(1),
  slug: z.string().min(1),
  display_name: z.string().min(1),
  gmv_thresholds: z.object({
    RaR_weekly: z.number().nonnegative(),
  }),
  channel_ids: z
    .object({
      chief_of_staff: z.string().optional(),
    })
    .default({}),
  timezone: z.string().default("America/Los_Angeles"),
});
export type TenantConfig = z.infer<typeof TenantConfigSchema>;

export type AgentRunSummary = {
  id: string;
  agent_slug: string;
  tenant_id: string;
  finished_at: string;
  status: AgentRunStatus;
  output_text: string;
};

export type ProgressStage =
  | "enqueued"
  | "claimed"
  | "loaded_context"
  | "tool_use_started"
  | "tool_use_completed"
  | "tool_use_errored"
  | "iter_cap_summarize"
  | "envelope_extracted"
  | "parsed"
  | "parse_failed"
  | "persisted"
  | "completed"
  | "failed"
  | "steer_drained";

export type ProgressMeta = {
  tool_name?: string;
  ms?: number;
  code?: string;
  iter?: number;
};

export type EmitProgress = (
  stage: ProgressStage,
  meta?: ProgressMeta,
) => Promise<void>;

export type StepLike = {
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>;
};

export type AgentContext = {
  agent: AgentDefinition;
  priorPassSpendUsd?: number;
  tenant_id: string;
  actor?: ActorAuthorityEnvelopeV1;
  shadow_mode?: boolean;
  draft_mode?: boolean;
  preview_dry?: boolean;
  preview_keep_cards?: boolean;
  done_for_you?: boolean;
  variants_lab?: boolean;
  variant_override?: import("./engine/variant-config").ResolvedVariant;
  lab_user_images?: Array<{ mime: string; base64: string }>;
  resolved_variant?: import("./engine/variant-config").ResolvedVariant;
  lab_abort?: AbortSignal;
  lab_engine?: { model: string; effort?: string };
  suppress_skill_runtime?: boolean;
  shadow_prompt_override?: { system: string; initial_user: string };
  shadow_tool_results?: Map<string, { content: string; is_error: boolean }[]>;
  shadow_sandbox_id?: string;
  bench_mode?: "build" | "score";
  bench_engine?: "shared_loop" | "claude_sdk";
  bench_task_tenant?: string;
  bench_capture?: (r: {
    sig: string;
    tenant_id: string;
    tool_name: string;
    input: unknown;
    content: string;
    is_error: boolean;
  }) => void;
  tenantConfig: TenantConfig;
  memory: Record<MemoryDocSlug, string>;
  episodic: string;
  engineer_cost_v2?: boolean;
  memory_mode?: "on" | "off";
  anthropic: Anthropic;
  runId: string;
  trigger: AgentTrigger;
  untrusted_context?: boolean;
  captured_page_context?: boolean;
  verified_member_email_reply?: boolean;
  top_action_run?: boolean;
  founder_chat_order?: boolean;
  founder_order_unverified?: boolean;
  founder_order_tell?: boolean;
  founder_order_group?: string;
  rules_steered?: { budget: boolean; status: boolean };
  chat_turn_verdict?: "answer" | "action";
  playbook?: import("@/playbooks").PlaybookDef;
  thread_id?: string;
  mention_target?: string;
  batch_id?: string | null;
  userId?: string;
  runOwnerBroken?: boolean;
  slackRouting?: {
    channel_id: string;
    thread_ts: string;
    original_ts: string;
    event_id: string;
    team_id?: string;
  };
  emailRouting?: {
    thread_id: string;
    email_message_id: string;
    rfc_message_id: string | null;
    from: string;
    envelope_to: string;
    identity_id: string | null;
  };
  priorMessages?: MessageParam[];
  scanRecentRuns: (windowHours?: number) => Promise<AgentRunSummary[]>;
  emitDecision: (decision_class: string, body: unknown, opts?: { selfDispatch?: boolean }) => Promise<string>;
  emitProgress: EmitProgress;
  citedNotes: Map<string, { title: string; score: number }>;
  provenanceToolCalls?: { current: readonly ToolCallTrace[] };
  step?: StepLike;
  lazySandboxEligible?: boolean;
  worker_sandbox?: { repo_full_name: string; e2b_sandbox_id: string };
};

export type DispatcherResult = {
  output_text: string;
  egress_email_allowlist?: string[];
  assistant_turns?: string[];
  code_search_available?: boolean;
  parsed: unknown;
  parse_ok: boolean;
  parse_error?: string;
  side_effect?: {
    kind: "shipped" | "refused" | "none";
    reason?: string;
    detail?: string;
    reason_code?: RefusalReasonCode;
  };
  customer_summary?: string;
  raw_response_text: string;
  prompt_snapshot: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cost_usd?: number;
  };
  auth_seat?: string;
  routing?: import("./model-router").RoutingDecision;
  tool_calls?: ToolCallTrace[];
  critic_lanes?: {
    anthropic: { status: string; reason?: string };
    openai: { status: string; reason?: string };
    revise_applied: boolean;
    critic_cost_usd?: number;
  };
  resolved_tool_names?: string[];
  envelope_rescue_kind?: "structured_questions" | "preceding_prose" | null;
  stop_reason?: string;
  schema_soft_failed?: boolean;
  coercion_notes?: string[];
  open_actions?: unknown;
  clarify_envelope?: import("./clarify-envelope").ClarifyEnvelope | null;
  connector_request?: import("@zavi/shared").ConnectorRequest | null;
  custom_agent_card?: import("./custom-agents").CustomAgentCard | null;
  claim_grounding_hedged?: boolean;
  claim_grounding_flags?: import("./claim-grounding-verifier").ClaimGroundingFlags;
  autonomous_grounding_hard_flag?: boolean;
  action_missing?: boolean;
  no_action_reason?: string;
  grounding_contract_failed?: boolean;
  operator_failure_shapes?: import("@/agents/operator/failure-shapes").OperatorFailureShape[];
  preview_action_types?: string[];
  local_pr?: {
    pr_number: number;
    pr_url: string;
    pr_repo: string;
    head_branch: string;
  } | null;
};

export const DispatcherResultSchema = z
  .object({
    output_text: z.string(),
    parsed: z.unknown(),
    parse_ok: z.boolean(),
    parse_error: z.string().optional(),
    raw_response_text: z.string(),
    prompt_snapshot: z.string(),
    usage: z
      .object({
        input_tokens: z.number(),
        output_tokens: z.number(),
        cache_creation_input_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        cost_usd: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type DispatcherResultParsed = z.infer<typeof DispatcherResultSchema>;

export type DispatcherFn = (
  ctx: AgentContext,
  payload?: unknown,
) => Promise<DispatcherResult>;

export const AGENT_RUN_STATUSES = [
  "success",
  "parse_failed",
  "dispatch_error",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const AGENT_TRIGGERS = [
  "manual",
  "cron",
  "slack",
  "webhook",
  "a2a",
  "chat",
  "handoff",
  "mcp",
  "email",
  "channel_recipe",
  "qa-weekly-execute",
  "teams",
  "whatsapp",
  "telegram",
  "discord",
  "imessage",
  "playbook",
] as const;
export type AgentTrigger = (typeof AGENT_TRIGGERS)[number];

export type AgentRun = {
  id: string;
  agent_slug: string;
  tenant_id: string;
  agent_definition_path: string;
  agent_definition_hash: string;
  trigger: AgentTrigger;
  started_at: string;
  finished_at: string;
  status: AgentRunStatus;
  input_payload_raw: unknown;
  prompt_snapshot: string;
  raw_response_text: string;
  parsed: unknown;
  parse_ok: boolean;
  parse_error?: string;
  output_text: string;
  decisions_emitted: string[];
  cost_tokens: number;
  cost_usd: number;
  tool_calls?: ToolCallTrace[];
  error?: string;
  outcome?: Partial<RunOutcome> | null;
  presentation_status?: RunDisplayState;
};
