
import { apiFetch } from "@/lib/api";
import type { ChannelThread } from "./channelThreadsApi";

type Row = {
  id: string;
  title: string | null;
  last_message_at: string | null;
  last_message: string | null;
  from_home?: boolean;
  from_email?: boolean;
};

export async function listAgentChats(slug: string): Promise<ChannelThread[]> {
  const res = await apiFetch(`/api/agents/${encodeURIComponent(slug)}/threads`);
  const body = (await res.json().catch(() => ({}))) as {
    threads?: Row[];
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const err = body.error;
    throw new Error((typeof err === "string" ? err : err?.message) ?? `HTTP ${res.status}`);
  }
  const rows = Array.isArray(body.threads) ? body.threads : [];
  const at = (r: Row) => (r.last_message_at ? Date.parse(r.last_message_at) || 0 : 0);
  return [...rows]
    .sort((a, b) => at(b) - at(a))
    .map((r) => ({
      id: r.id,
      title: r.title,
      preview: r.last_message ? r.last_message.replace(/\s+/g, " ").trim() : null,
      last_message_at: r.last_message_at,
      channel_action_id: null,
      card_title: null,
      ...(r.from_home === true ? { from_home: true } : {}),
      ...(r.from_email === true ? { from_email: true } : {}),
    }));
}
