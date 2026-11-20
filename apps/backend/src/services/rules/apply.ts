
import type { AgentContext } from "@/services/agents/types";
import { emailReplyOwnText } from "@/services/agents/email-reply-trust";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { rulesSteerRun, type LoadedRules } from "./load";

async function currentHumanText(ctx: AgentContext, payload: unknown): Promise<string | null> {
  if (ctx.trigger === "chat" || ctx.trigger === "handoff") {
    const p = payload as { current_user_text_raw?: unknown; current_message?: unknown } | null;
    const m = typeof p?.current_user_text_raw === "string" ? p.current_user_text_raw : p?.current_message;
    return typeof m === "string" ? m : null;
  }
  if (ctx.trigger === "email" && ctx.verified_member_email_reply === true) {
    return emailReplyOwnText(ctx.tenant_id, payload);
  }
  return null;
}

export async function applyRulesToRun(
  ctx: AgentContext,
  payload: unknown,
  loaded: LoadedRules,
): Promise<boolean> {
  if (loaded.rules.length === 0) return false;
  if (ctx.runId && loaded.hash) {
    try {
      const { data, error } = await tenantClient(asTenantId(ctx.tenant_id))
        .from("agent_runs")
        .update({ rule_set_hash: loaded.hash })
        .eq("id", ctx.runId)
        .select("id");
      if (error) throw new Error(error.message);
      if (!Array.isArray(data) || data.length !== 1) throw new Error("run row not found");
    } catch (e) {
      console.warn(`[rules] rule_set_hash stamp failed for run ${ctx.runId}; rules left out: ${(e as Error).message}`);
      return false;
    }
  }
  if (
    ctx.trigger === "chat" ||
    ctx.trigger === "handoff" ||
    (ctx.trigger === "email" && ctx.verified_member_email_reply === true)
  ) {
    const text = await currentHumanText(ctx, payload).catch(() => null);
    ctx.rules_steered = rulesSteerRun({ ruleCount: loaded.rules.length, currentHumanText: text });
  }
  return true;
}
