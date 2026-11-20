
import { apiFetch } from "@/lib/api";

export type ChannelThread = {
  id: string;
  title: string | null;
  preview: string | null;
  last_message_at: string | null;
  channel_action_id: string | null;
  card_title: string | null;
  from_home?: boolean;
  from_email?: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listChannelThreads(
  channel: string,
  actionId?: string | null,
): Promise<ChannelThread[]> {
  if (actionId != null && !UUID_RE.test(actionId)) return [];
  const q = new URLSearchParams({ channel });
  if (actionId) q.set("action", actionId);
  const res = await apiFetch(`/api/workspace/channel-threads?${q.toString()}`);
  const body = (await res.json().catch(() => ({}))) as {
    threads?: ChannelThread[];
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const err = body.error;
    throw new Error((typeof err === "string" ? err : err?.message) ?? `HTTP ${res.status}`);
  }
  return Array.isArray(body.threads) ? body.threads : [];
}
