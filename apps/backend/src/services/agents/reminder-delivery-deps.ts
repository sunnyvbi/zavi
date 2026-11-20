
import type { ReminderDeliveryDeps } from "./reminders";
import { serviceClient } from "@/services/supabase";
import { slackFetch } from "@/services/tools/slack/_client";
import { postWhatsAppReply, postWhatsAppWindowTemplate } from "@/services/tools/whatsapp/_client";
import { postTelegramReply } from "@/services/tools/telegram/_client";
import { postDiscordReply } from "@/services/tools/discord/_client";
import { findEnabledWhatsAppBinding } from "@/services/connectors/whatsapp/binding";
import { whatsappOwnsNumber } from "@/services/connectors/whatsapp/adapter";
import { discordChannelMembership } from "@/services/connectors/discord/adapter";
import { findEnabledIMessageBinding } from "@/services/connectors/imessage/binding";
import { imessageOwnsLine } from "@/services/connectors/imessage/sendblue";
import { postIMessageReply } from "@/services/tools/imessage/_client";
import { notifyThreadOwner } from "@/services/notifications/push-fanout";

export const REMINDER_DEFER_PREFIX = "__defer__:";
export const REMINDER_TRANSIENT_PREFIX = "__transient__:";

export function isReminderDefer(err: string | null): boolean {
  return !!err && err.startsWith(REMINDER_DEFER_PREFIX);
}

export function isReminderTransient(err: string | null): boolean {
  return !!err && err.startsWith(REMINDER_TRANSIENT_PREFIX);
}

export function reminderDeliveryDeps(opts: {
  scrub: (text: string) => string;
  threadMeta?: { agent_run_id?: string; from_agent_slug?: string };
}): ReminderDeliveryDeps {
  const sb = serviceClient();
  const meta = opts.threadMeta;

  return {
    scrub: opts.scrub,

    postToThread: async (p) => {
      const { data: thread } = await sb
        .from("agent_threads")
        .select("id")
        .eq("id", p.thread_id)
        .eq("tenant_id", p.tenant_id)
        .maybeSingle();
      if (!thread) return "destination thread not found for tenant";
      const { error } = await sb.from("agent_thread_messages").insert({
        thread_id: p.thread_id,
        tenant_id: p.tenant_id,
        sender_role: "assistant",
        body: p.body,
        ...(meta?.agent_run_id ? { agent_run_id: meta.agent_run_id } : {}),
        meta: {
          ...(meta?.from_agent_slug ? { from_agent_slug: meta.from_agent_slug } : {}),
          reminder: true,
        },
      });
      if (error) return error.message;
      await sb
        .from("agent_threads")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", p.thread_id);
      void notifyThreadOwner({
        tenant_id: p.tenant_id,
        thread_id: p.thread_id,
        agent_slug: meta?.from_agent_slug ?? "operator",
        body: "Zavi posted a new message.",
      }).catch(() => {});
      return null;
    },

    postToSlack: async (p) => {
      try {
        await slackFetch(
          p.tenant_id,
          "chat.postMessage",
          { channel: p.channel_id, text: p.text, thread_ts: p.thread_ts },
          p.team_id,
        );
        return null;
      } catch (e) {
        return (e as Error).message.slice(0, 500);
      }
    },

    postToSlackDm: async (p) => {
      try {
        const im = await slackFetch<{ channel?: { id?: string } }>(
          p.tenant_id,
          "conversations.open",
          { users: p.slack_user_id },
          p.team_id,
        );
        const dmChannel = im?.channel?.id;
        if (!dmChannel) return "conversations.open returned no channel";
        await slackFetch(
          p.tenant_id,
          "chat.postMessage",
          { channel: dmChannel, text: p.text },
          p.team_id,
        );
        return null;
      } catch (e) {
        return (e as Error).message.slice(0, 500);
      }
    },

    postToWhatsApp: async (p) => {
      try {
        if (!whatsappOwnsNumber(p.phone_number_id)) {
          return `${REMINDER_DEFER_PREFIX}whatsapp number ${p.phone_number_id} is not served by this host`;
        }
        const binding = await findEnabledWhatsAppBinding({
          tenant_id: p.tenant_id,
          wa_id: p.wa_id,
          phone_number_id: p.phone_number_id,
        });
        if (!binding) return "whatsapp thread no longer enabled for this tenant";
        const res = await postWhatsAppReply({
          wa_id: p.wa_id,
          text: p.text,
          windowExpiresAt: binding.window_expires_at,
        });
        if (res.ok) return null;
        if (res.windowClosed) {
          const tpl = await postWhatsAppWindowTemplate({ wa_id: p.wa_id });
          return tpl.ok
            ? null
            : `whatsapp window closed and template failed: ${tpl.error ?? "unknown"}`;
        }
        return res.error ?? "whatsapp send failed";
      } catch (e) {
        return (e as Error).message.slice(0, 500);
      }
    },

    postToIMessage: async (p) => {
      try {
        if (!imessageOwnsLine(p.line)) {
          return `${REMINDER_DEFER_PREFIX}imessage line ${p.line} is not served by this host`;
        }
        if (!(await findEnabledIMessageBinding({ line: p.line, handle: p.handle, tenant_id: p.tenant_id }))) {
          return "imessage thread no longer enabled for this tenant";
        }
        const res = await postIMessageReply({ handle: p.handle, text: p.text });
        return res.ok ? null : res.error;
      } catch (e) {
        return (e as Error).message.slice(0, 500);
      }
    },

    postToTelegram: async (p) => {
      try {
        const { data } = await sb
          .from("telegram_chats")
          .select("tenant_id")
          .eq("chat_id", p.chat_id)
          .eq("tenant_id", p.tenant_id)
          .eq("status", "enabled")
          .maybeSingle<{ tenant_id: string }>();
        if (!data) return "telegram chat is no longer an enabled binding for this tenant";
        const res = await postTelegramReply({ chat_id: p.chat_id, text: p.text });
        return res.ok ? null : (res.error ?? "telegram send failed");
      } catch (e) {
        return (e as Error).message.slice(0, 500);
      }
    },

    postToDiscord: async (p) => {
      try {
        if (!p.guild_id) return "discord target has no guild_id to revalidate";
        const { data } = await sb
          .from("discord_guilds")
          .select("tenant_id")
          .eq("guild_id", p.guild_id)
          .eq("tenant_id", p.tenant_id)
          .eq("status", "enabled")
          .maybeSingle<{ tenant_id: string }>();
        if (!data) return "discord guild is no longer an enabled binding for this tenant";
        const membership = await discordChannelMembership(p.channel_id, p.guild_id);
        if (membership === "other") return "discord channel is not in this tenant's guild";
        if (membership === "bot_error") return "discord bot token is missing or was rejected";
        if (membership === "unknown") return `${REMINDER_TRANSIENT_PREFIX}discord channel lookup failed`;
        const res = await postDiscordReply({ channel_id: p.channel_id, text: p.text });
        return res.ok ? null : (res.error ?? "discord send failed");
      } catch (e) {
        return (e as Error).message.slice(0, 500);
      }
    },
  };
}
