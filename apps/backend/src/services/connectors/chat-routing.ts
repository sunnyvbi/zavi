
export type TelegramRouting = { chat_id: number; message_id?: number };
export type DiscordRouting = { guild_id: string; channel_id: string; message_id?: string };
export type WhatsAppRouting = { phone_number_id: string; wa_id: string };

export function whatsappRouting(payload: Record<string, unknown> | null | undefined): WhatsAppRouting | null {
  const w = (payload?.whatsapp ?? {}) as Partial<WhatsAppRouting>;
  const phone_number_id = String(w.phone_number_id ?? "");
  const wa_id = String(w.wa_id ?? "");
  if (!phone_number_id || !wa_id) return null;
  return { phone_number_id, wa_id };
}

export type IMessageRouting = { line: string; handle: string };

export function imessageRouting(payload: Record<string, unknown> | null | undefined): IMessageRouting | null {
  const m = (payload?.imessage ?? {}) as Partial<IMessageRouting>;
  const line = String(m.line ?? "");
  const handle = String(m.handle ?? "");
  if (!line || !handle) return null;
  return { line, handle };
}

export function telegramRouting(payload: Record<string, unknown> | null | undefined): TelegramRouting | null {
  const t = (payload?.telegram ?? {}) as { chat_id?: unknown; message_id?: unknown };
  const chat_id = Number(t.chat_id);
  if (!Number.isFinite(chat_id) || chat_id === 0) return null;
  return { chat_id, message_id: Number(t.message_id) || undefined };
}

export function discordRouting(payload: Record<string, unknown> | null | undefined): DiscordRouting | null {
  const d = (payload?.discord ?? {}) as Partial<DiscordRouting>;
  const guild_id = String(d.guild_id ?? "");
  const channel_id = String(d.channel_id ?? "");
  if (!guild_id || !channel_id) return null;
  return { guild_id, channel_id, message_id: String(d.message_id ?? "") || undefined };
}
