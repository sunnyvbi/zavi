
export const RESERVED_RUN_PAYLOAD_KEYS: readonly string[] = [
  "staff_model",
  "source_decision_id",
  "origin_decision_id",
  "dispatched_by",
  "cgo_brief",
  "cgo_hire",
  "goal_id",
  "goal_rev",
  "problem",
  "current_user_text_raw",
  "brief_journey_fix",
  "brief_journey_fix_token",
  "vision_fix",
  "vision_fix_token",
  "build_conductor_run_id",
  "refine_mode",
  "site_pr_card",
  "site_pr_content",
  "user_message_id",
  "thread_id",
  "resume_of_run_id",
  "internal_resume_turn",
  "operator_thread_id",
  "attachment_paths",
  "inherited_actor",
  "founder_message_ref",
  "founder_message_ref_unreadable",
  "email_plan",
  "top_action",
];

export function stripReservedRunPayloadKeys<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const k of RESERVED_RUN_PAYLOAD_KEYS) delete out[k];
  return out as T;
}
