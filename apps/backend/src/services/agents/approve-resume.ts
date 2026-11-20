
import { getBoolSetting } from "@/services/settings";

export const PAUSED_AWAITING_APPROVAL = "paused_awaiting_approval" as const;
export type PausedStatus = typeof PAUSED_AWAITING_APPROVAL;

export async function isApprovePauseResumeEnabled(
  tenant_id?: string | null,
): Promise<boolean> {
  return getBoolSetting("approval_pause_resume_enabled", tenant_id);
}

export type EmitAutonomy = "auto" | "approval" | "forbidden";

export function shouldPauseForApproval(args: {
  enabled: boolean;
  autonomy: EmitAutonomy | string | null | undefined;
}): boolean {
  return args.enabled === true && args.autonomy === "approval";
}

export const INTERACTIVE_RESUME_TRIGGERS: ReadonlySet<string> = new Set([
  "chat",
  "slack",
  "email",
  "teams",
  "telegram",
  "discord",
  "whatsapp",
  "imessage",
]);

export function isInteractiveResumeTrigger(
  trigger: string | null | undefined,
): boolean {
  return typeof trigger === "string" && INTERACTIVE_RESUME_TRIGGERS.has(trigger);
}

const OUTCOME_MAX = 2000;
const SUMMARY_MAX = 400;

export function buildResumeTurn(args: {
  toolName: string;
  decisionSummary?: string | null;
  outcome?: string | null;
  approved: boolean;
}): string {
  const tool = String(args.toolName ?? "").trim().slice(0, 120) || "the proposed action";
  const summary = (args.decisionSummary ?? "").toString().trim().replace(/\s+/g, " ").slice(0, SUMMARY_MAX);
  const outcome = (args.outcome ?? "").toString().trim().slice(0, OUTCOME_MAX);
  const summaryLine = summary ? ` (${summary})` : "";

  if (!args.approved) {
    return (
      `Your proposed action \`${tool}\`${summaryLine} was NOT approved` +
      (outcome ? ` — ${outcome}` : "") +
      `. Do not retry that exact action. Acknowledge this, and if there is a safe alternative or the task can continue without it, do so; otherwise explain what you need.`
    );
  }

  return (
    `Your proposed action \`${tool}\`${summaryLine} was approved and executed.` +
    (outcome ? ` Result: ${outcome}` : ` It completed.`) +
    ` Continue the task from here — verify the result if useful, then do the next step or report completion.`
  );
}

export const RESUME_RESOLVED_STATUS = "success" as const;

export function buildResumePayload(args: {
  originalPayload: unknown;
  resumeTurn: string;
  pausedRunId: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    user_message: args.resumeTurn,
    resume_of_run_id: args.pausedRunId,
  };
  const src =
    args.originalPayload && typeof args.originalPayload === "object"
      ? (args.originalPayload as Record<string, unknown>)
      : {};
  if (typeof src.thread_id === "string" && src.thread_id) {
    out.thread_id = src.thread_id;
  }
  for (const key of ["slack", "email", "teams", "telegram", "discord", "whatsapp", "imessage"] as const) {
    if (src[key] && typeof src[key] === "object") {
      out[key] = src[key];
    }
  }
  for (const key of ["slack_handoff_child", "handoff_child", "whatsapp_handoff_child"] as const) {
    if (src[key] === true) out[key] = true;
  }
  if (typeof src.ask_id === "string" && typeof src.operator_thread_id === "string" && src.operator_thread_id) {
    out.operator_thread_id = src.operator_thread_id;
  }
  return out;
}
