
/* eslint-disable @typescript-eslint/no-explicit-any */

import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { postWhatsAppReply, postWhatsAppWindowTemplate } from "@/services/tools/whatsapp/_client";
import { findEnabledWhatsAppBinding } from "@/services/connectors/whatsapp/binding";
import { whatsappEnabled, whatsappOwnsNumber } from "@/services/connectors/whatsapp/adapter";
import { logEvent } from "@/services/logging/logEvent";
import { handoffChildReplyText } from "@/services/agents/handoff-result";
import type { RunOutcome } from "@/services/agents/outcome-model";

const MAX_BODY = 28_000;

const TERMINAL_FAILED_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "parse_failed",
  "dispatch_error",
  "error",
]);

type RunRow = {
  tenant_id: string;
  trigger: string | null;
  status: string | null;
  output_text: string | null;
  agent_slug: string | null;
  payload: Record<string, unknown> | null;
  outcome: Partial<RunOutcome> | null;
  parsed: Record<string, unknown> | null;
};

export function whatsappReplyText(run: RunRow, run_id: string): string {
  if ((run.payload as { whatsapp_handoff_child?: unknown } | null)?.whatsapp_handoff_child === true) {
    return handoffChildReplyText(run, run_id);
  }
  return (run.output_text ?? "").trim();
}

export async function replyOne(run_id: string): Promise<unknown> {
  const svc = serviceClient();

  const { data: run } = await svc
    .from("agent_runs")
    .select("tenant_id, trigger, status, output_text, agent_slug, payload, outcome, parsed")
    .eq("id", run_id)
    .maybeSingle<RunRow>();
  if (!run) return { skip: "run_not_found" };
  if (run.trigger !== "whatsapp") return { skip: "not_whatsapp_triage" };

  if ((run.payload as { whatsapp_reply_delegated?: unknown })?.whatsapp_reply_delegated === true) {
    return { skip: "whatsapp_reply_delegated" };
  }

  const wa = ((run.payload?.whatsapp as Record<string, unknown>) ?? {}) as {
    wa_id?: string;
    phone_number_id?: string;
  };
  const waId = String(wa.wa_id ?? "");
  const phoneNumberId = String(wa.phone_number_id ?? "");
  if (!waId || !phoneNumberId) return { skip: "no_whatsapp_routing" };

  if (whatsappEnabled() && !whatsappOwnsNumber(phoneNumberId)) {
    await logEvent({
      level: "warn",
      source: "whatsapp-triage-reply",
      code: "whatsapp.reply.number_mismatch",
      message: `whatsapp run ${run_id}: thread belongs to another business number; this host will not reply`,
      tenant_id: run.tenant_id,
    });
    return { skip: "number_mismatch" };
  }

  const binding = await findEnabledWhatsAppBinding({
    phone_number_id: phoneNumberId,
    wa_id: waId,
    tenant_id: run.tenant_id,
  });
  if (!binding) {
    await logEvent({
      level: "warn",
      source: "whatsapp-triage-reply",
      code: "whatsapp.reply.binding_stale",
      message: `whatsapp run ${run_id}: thread is no longer an enabled binding for this tenant; reply dropped`,
      tenant_id: run.tenant_id,
    });
    return { skip: "binding_not_current" };
  }

  const { error: claimErr } = await svc.from("whatsapp_reply_claims").insert({ run_id });
  if (claimErr) {
    return { skip: "reply_already_handled" };
  }

  async function releaseClaim() {
    await svc.from("whatsapp_reply_claims").delete().eq("run_id", run_id);
  }

  const handoffChildTerminalFailure =
    (run.payload as { whatsapp_handoff_child?: unknown } | null)?.whatsapp_handoff_child === true &&
    TERMINAL_FAILED_STATUSES.has(run.status ?? "");
  const refusedWithExplanation = run.status === "failed" && run.outcome?.failure?.class === "policy_refusal" && !!run.output_text?.trim();
  if (run.status !== "success" && !refusedWithExplanation) {
    await logEvent({
      level: "warn",
      source: "whatsapp-triage-reply",
      code: "whatsapp.reply.run_failed",
      message: handoffChildTerminalFailure
        ? `whatsapp run ${run_id} status=${run.status}; posting the status line`
        : `whatsapp run ${run_id} status=${run.status}; no reply sent`,
      tenant_id: run.tenant_id,
    });
    if (!handoffChildTerminalFailure) {
      await releaseClaim();
      return { skip: "run_not_success", status: run.status };
    }
  }

  let body = whatsappReplyText(run, run_id);
  if (!body) {
    await releaseClaim();
    return { skip: "empty_output" };
  }
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);

  const result = await postWhatsAppReply({
    wa_id: waId,
    text: body,
    windowExpiresAt: binding.window_expires_at,
  });

  if (result.ok) return { sent: true, run_id, chunks: result.chunks };

  if (result.windowClosed) {
    if (result.sent === 0) {
      const tpl = await postWhatsAppWindowTemplate({ wa_id: waId });
      await logEvent({
        level: "info",
        source: "whatsapp-triage-reply",
        code: "whatsapp.reply.window_expired",
        message: `whatsapp run ${run_id}: 24h window closed; sent template=${tpl.ok}, answer withheld`,
        tenant_id: run.tenant_id,
      });
      return { skip: "window_expired", template_sent: tpl.ok, run_id };
    }
    await logEvent({
      level: "warn",
      source: "whatsapp-triage-reply",
      code: "whatsapp.reply.window_closed_mid_send",
      message: `whatsapp run ${run_id}: window closed after ${result.sent} chunk(s); tail dropped, claim kept`,
      tenant_id: run.tenant_id,
    });
    return { skip: "window_closed_mid_send", sent: result.sent, run_id };
  }

  if (result.gone) {
    await svc
      .from("whatsapp_threads")
      .update({ status: "deleted", updated_at: new Date().toISOString() })
      .eq("phone_number_id", phoneNumberId)
      .eq("wa_id", waId)
      .eq("tenant_id", run.tenant_id);
    await logEvent({
      level: "warn",
      source: "whatsapp-triage-reply",
      code: "whatsapp.reply.recipient_gone",
      message: `whatsapp recipient gone for run ${run_id}: ${result.error}`,
      tenant_id: run.tenant_id,
    });
    return { skip: "recipient_gone", error: result.error };
  }

  if (result.sent > 0) {
    await logEvent({
      level: "warn",
      source: "whatsapp-triage-reply",
      code: "whatsapp.reply.partial_send",
      message: `whatsapp run ${run_id}: ${result.sent} chunk(s) sent before failure (${result.error}); tail dropped, claim kept`,
      tenant_id: run.tenant_id,
    });
    return { skip: "partial_send", sent: result.sent, error: result.error, run_id };
  }

  if (result.disabled) {
    await releaseClaim();
    return { skip: "whatsapp_disabled", run_id };
  }

  await releaseClaim();
  throw new Error(`whatsapp_send_failed run=${run_id}: ${result.error}`);
}

export const whatsappTriageReplyFn = inngest.createFunction(
  { id: "whatsapp-triage-reply", retries: 1, concurrency: 4 },
  { event: "agent.run.completed" },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id;
    const res = await step.run("reply", () => replyOne(run_id));
    logger.info(`whatsapp-triage-reply ${run_id}: ${JSON.stringify(res)}`);
    return res;
  },
);
