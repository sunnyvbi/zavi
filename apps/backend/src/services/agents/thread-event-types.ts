
import { z } from "zod";

export const THREAD_EVENT_KINDS = [
  "chat_user",
  "chat_assistant",
  "run_start",
  "reasoning",
  "plan",
  "plan_critic_verdict",
  "tool_call",
  "file_read",
  "file_edit",
  "file_create",
  "decision",
  "run_end",
  "voice_session_start",
  "voice_session_end",
  "voice_agent_utterance",
  "voice_turn_state",
  "voice_device_changed",
] as const;

export type ThreadEventKind = (typeof THREAD_EVENT_KINDS)[number];

export const ChatUserBodySchema = z.object({
  user_id: z.string().uuid(),
  text: z.string().max(8000),
});

export const ChatAssistantBodySchema = z.object({
  text: z.string().max(8000),
  agent_run_id: z.string().uuid().optional(),
  meta: z
    .object({
      trigger: z.string().max(32).optional(),
      started_at: z.string().optional(),
      empty: z.boolean().optional(),
    })
    .optional(),
});

export const RunStartBodySchema = z.object({
  trigger: z.string().max(32),
  eta_p50_ms: z.number().int().nonnegative().optional(),
  eta_p95_ms: z.number().int().nonnegative().optional(),
  eta_basis: z.enum(["tenant", "fleet_default"]).optional(),
  eta_n: z.number().int().nonnegative().optional(),
});

export const ReasoningBodySchema = z.object({
  iter: z.number().int().nonnegative(),
  text: z.string().max(8000),
});

export const ClassifySchema = z.object({
  tier: z.enum(["tier1", "tier2", "tier3"]),
  confidence: z.number().min(0).max(1),
  evidence_needed: z.array(z.string().max(64)).max(8).default([]),
  target_specialist: z.string().max(64).optional(),
});

export const PlanBodySchema = z.object({
  classify: ClassifySchema.optional(),
  summary: z.string().max(2000),
  steps: z.array(z.string().max(280)).max(8),
  files: z.array(z.string().max(512)).max(20),
});

const PlanCriticFindingSchema = z.object({
  severity: z.enum(["P1", "P2", "P3"]),
  location: z.string().max(200),
  problem: z.string().max(500),
  fix: z.string().max(500),
  reviewer: z.enum(["anthropic", "openai"]).optional(),
});
const PlanCriticLaneStatusSchema = z.object({
  anthropic: z.object({
    status: z.enum(["ok", "unavailable"]),
    error: z.string().max(500).optional(),
  }),
  openai: z.object({
    status: z.enum(["ok", "unavailable", "skipped"]),
    error: z.string().max(500).optional(),
  }),
});
export const PlanCriticVerdictBodySchema = z.object({
  status: z.enum(["ok", "unavailable"]),
  verdict: z.enum(["pass", "fail"]),
  top_severity: z.enum(["P1", "P2", "P3"]).nullable(),
  findings: z.array(PlanCriticFindingSchema).max(5),
  model: z.string().max(80),
  cost_usd: z.number().nonnegative(),
  error: z.string().max(500).optional(),
  lanes: PlanCriticLaneStatusSchema.optional(),
});

export const ToolCallBodySchema = z.object({
  tool_name: z.string().max(64),
  target: z.string().max(256),
  ms: z.number().int().nonnegative(),
  code: z.enum(["ok", "err"]),
  output_preview: z.string().max(200),
  error_message: z.string().max(500).optional(),
  call_id: z.string().max(64).optional(),
});

export const FileReadBodySchema = z.object({
  path: z.string().max(512),
  description: z.string().max(280).optional(),
  ms: z.number().int().nonnegative(),
});

export const FileEditBodySchema = z.object({
  path: z.string().max(512),
  diff: z.string().max(4096),
  description: z.string().max(280).optional(),
});

export const FileCreateBodySchema = z.object({
  path: z.string().max(512),
  content_preview: z.string().max(500),
  description: z.string().max(280).optional(),
});

export const DecisionBodySchema = z.object({
  decision_id: z.string().uuid(),
  decision_class: z.string().max(128),
  title: z.string().max(280),
  summary: z.string().max(280).optional(),
  subject: z.string().max(160).optional(),
  before_usd: z.number().nonnegative().optional(),
  after_usd: z.number().nonnegative().optional(),
  full_card: z.boolean().optional(),
  store: z.enum(["decision", "channel_action"]).optional(),
  channel_slug: z.string().max(64).optional(),
  filed_at: z.string().datetime({ offset: true }).optional(),
  from_other_chat: z.boolean().optional(),
});

export const RunEndBodySchema = z.object({
  status: z.enum(["success", "error", "failed", "cancelled"]),
  cost_usd: z.number().nonnegative().nullable(),
  answered: z.boolean().optional(),
  trigger: z.string().max(32).optional(),
  question: z.boolean().optional(),
});

export function runEndTrigger(trigger: string, payload: unknown): string {
  return (payload as { origin?: unknown } | null)?.origin === "staff_console"
    ? "staff_console"
    : trigger;
}

export const CitationSchema = z.object({
  kind: z.enum(["memory_doc", "agent_run"]),
  ref: z.string().min(1).max(256),
  label: z.string().min(1).max(160),
});
export type Citation = z.infer<typeof CitationSchema>;

export const VoiceSessionStartBodySchema = z.object({
  session_id: z.string().uuid(),
  agent_slug: z.string().max(128),
  room: z.string().max(128),
});

export const VoiceSessionEndBodySchema = z.object({
  session_id: z.string().uuid(),
  end_reason: z.enum([
    "user_ended",
    "budget_exhausted",
    "idle_reaped",
    "error",
    "first_wins_displaced",
    "livekit_disconnect",
    "tab_suspended",
  ]),
  duration_seconds: z.number().nonnegative(),
});

export const VoiceAgentUtteranceBodySchema = z.object({
  session_id: z.string().uuid(),
  text: z.string().max(8000),
  interrupted: z.boolean().default(false),
});

export const VoiceTurnStateBodySchema = z.object({
  session_id: z.string().uuid(),
  state: z.enum([
    "listening",
    "transcribing",
    "thinking",
    "speaking",
    "failed_retryable",
    "failed_terminal",
  ]),
  detail: z.string().max(280).optional(),
});

export const VoiceDeviceChangedBodySchema = z.object({
  session_id: z.string().uuid(),
  category: z.enum(["mic_added", "mic_removed", "mic_swapped", "tab_suspended"]),
});

export const BODY_SCHEMAS = {
  chat_user: ChatUserBodySchema,
  chat_assistant: ChatAssistantBodySchema,
  run_start: RunStartBodySchema,
  reasoning: ReasoningBodySchema,
  plan: PlanBodySchema,
  plan_critic_verdict: PlanCriticVerdictBodySchema,
  tool_call: ToolCallBodySchema,
  file_read: FileReadBodySchema,
  file_edit: FileEditBodySchema,
  file_create: FileCreateBodySchema,
  decision: DecisionBodySchema,
  run_end: RunEndBodySchema,
  voice_session_start: VoiceSessionStartBodySchema,
  voice_session_end: VoiceSessionEndBodySchema,
  voice_agent_utterance: VoiceAgentUtteranceBodySchema,
  voice_turn_state: VoiceTurnStateBodySchema,
  voice_device_changed: VoiceDeviceChangedBodySchema,
} as const satisfies Record<ThreadEventKind, z.ZodTypeAny>;

export type ThreadEventBody<K extends ThreadEventKind> = z.infer<(typeof BODY_SCHEMAS)[K]>;
