
import { isScreenshotPageContext } from "@/services/agents/page-context";

export function isUntrustedContextPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const pc = (payload as { page_context?: unknown }).page_context;
  if (pc == null) return false;
  if (isScreenshotPageContext(payload)) return false;
  return true;
}

export function carriesCapturedPageContext(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { page_context?: unknown }).page_context != null;
}

export function hasUntrustedContext(ctx: {
  untrusted_context?: boolean;
}): boolean {
  return ctx.untrusted_context === true;
}

export function isHumanAuthoredChat(ctx: {
  run_trigger?: string;
  untrusted_context?: boolean;
  captured_page_context?: boolean;
}): boolean {
  return (
    ctx.run_trigger === "chat" &&
    ctx.untrusted_context !== true &&
    ctx.captured_page_context !== true
  );
}

export function isHumanAuthoredCommand(
  ctx: {
    run_trigger?: string;
    untrusted_context?: boolean;
    captured_page_context?: boolean;
    verified_member_email_reply?: boolean;
    rules_steered?: { budget: boolean; status: boolean };
    top_action_run?: boolean;
  },
  op?: "budget" | "status",
): boolean {
  if (ctx.top_action_run === true) return true;
  if (op ? isRulesSteered(ctx, op) : isRulesSteered(ctx, "budget") || isRulesSteered(ctx, "status")) return false;
  if (isHumanAuthoredChat(ctx)) return true;
  return ctx.run_trigger === "email" && ctx.verified_member_email_reply === true;
}

export function isFounderChatOrder(ctx: {
  run_trigger?: string;
  untrusted_context?: boolean;
  captured_page_context?: boolean;
  founder_chat_order?: boolean;
}): boolean {
  if (ctx.run_trigger === "handoff" || ctx.run_trigger === "slack") return ctx.founder_chat_order === true && ctx.untrusted_context !== true && ctx.captured_page_context !== true;
  return ctx.founder_chat_order === true && isHumanAuthoredChat(ctx);
}

export function isUnverifiedEmailRun(ctx: {
  run_trigger?: string;
  verified_member_email_reply?: boolean;
}): boolean {
  return ctx.run_trigger === "email" && ctx.verified_member_email_reply !== true;
}

export function isRulesSteered(
  ctx: { rules_steered?: { budget: boolean; status: boolean } },
  op: "budget" | "status",
): boolean {
  return ctx.rules_steered?.[op] === true;
}
