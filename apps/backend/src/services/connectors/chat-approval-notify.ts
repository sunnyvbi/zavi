
import { approvalPendingText } from "./chat-copy";
import { telegramRouting, discordRouting, whatsappRouting, imessageRouting } from "./chat-routing";
import { postTelegramReply } from "@/services/tools/telegram/_client";
import { postDiscordReply } from "@/services/tools/discord/_client";
import { postWhatsAppReply } from "@/services/tools/whatsapp/_client";
import { findEnabledWhatsAppBinding } from "./whatsapp/binding";
import { findEnabledIMessageBinding } from "./imessage/binding";
import { imessageOwnsLine } from "./imessage/sendblue";
import { postIMessageReply } from "@/services/tools/imessage/_client";

export async function notifyChatApprovalPending(args: {
  trigger: string | null | undefined;
  payload: unknown;
  tenant_id?: string | null;
}): Promise<{ posted: boolean }> {
  const p = (args.payload ?? null) as Record<string, unknown> | null;
  try {
    if (args.trigger === "telegram") {
      const r = telegramRouting(p);
      if (!r) return { posted: false };
      const res = await postTelegramReply({
        chat_id: r.chat_id,
        reply_to_message_id: r.message_id,
        text: approvalPendingText(args.tenant_id),
      });
      return { posted: res.ok };
    }
    if (args.trigger === "discord") {
      const r = discordRouting(p);
      if (!r) return { posted: false };
      const res = await postDiscordReply({
        channel_id: r.channel_id,
        reply_to_message_id: r.message_id,
        text: approvalPendingText(args.tenant_id),
      });
      return { posted: res.ok };
    }
    if (args.trigger === "whatsapp") {
      const r = whatsappRouting(p);
      if (!r || !args.tenant_id) return { posted: false };
      const binding = await findEnabledWhatsAppBinding({
        phone_number_id: r.phone_number_id,
        wa_id: r.wa_id,
        tenant_id: args.tenant_id,
      });
      if (!binding) return { posted: false };
      const res = await postWhatsAppReply({
        wa_id: r.wa_id,
        text: approvalPendingText(args.tenant_id),
        windowExpiresAt: binding.window_expires_at,
      });
      return { posted: res.ok };
    }
    if (args.trigger === "imessage") {
      const r = imessageRouting(p);
      if (!r || !args.tenant_id || !imessageOwnsLine(r.line)) return { posted: false };
      if (!(await findEnabledIMessageBinding({ ...r, tenant_id: args.tenant_id }))) return { posted: false };
      const res = await postIMessageReply({ handle: r.handle, text: approvalPendingText(args.tenant_id) });
      return { posted: res.ok };
    }
  } catch {
  }
  return { posted: false };
}

export async function postSlackApprovalsOnPause(args: { tenant_id: string; run_id: string; decision_ids?: string[] }): Promise<{ posted: number }> {
  try {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const { data, error } = await tenantClient(asTenantId(args.tenant_id))
      .from("agent_runs")
      .select("trigger, enqueued_by, payload")
      .eq("id", args.run_id)
      .eq("tenant_id", args.tenant_id)
      .maybeSingle();
    const run = data as { trigger?: unknown; enqueued_by?: unknown; payload?: unknown } | null;
    if (error || !run || run.trigger !== "slack" || run.enqueued_by != null) return { posted: 0 };
    const slack = ((run.payload as Record<string, unknown> | null)?.slack ?? null) as Record<string, unknown> | null;
    const channel_id = typeof slack?.channel_id === "string" ? slack.channel_id : "";
    const thread_ts = typeof slack?.thread_ts === "string" ? slack.thread_ts : "";
    const team_id = typeof slack?.team_id === "string" ? slack.team_id : undefined;
    if (!channel_id || !thread_ts) return { posted: 0 };
    const { postPendingApprovalBubblesForRun } = await import("@/../workers/functions/approval-slack-notify");
    const r = await postPendingApprovalBubblesForRun({
      tenant_id: args.tenant_id,
      run_id: args.run_id,
      channel_id,
      thread_ts,
      team_id,
      ...(args.decision_ids?.length ? { decision_ids: args.decision_ids } : {}),
    });
    return { posted: r.posted };
  } catch (e) {
    console.warn(`[chat-approval-notify] slack approval bubbles on pause failed for run ${args.run_id}: ${(e as Error).message}`);
    return { posted: 0 };
  }
}
