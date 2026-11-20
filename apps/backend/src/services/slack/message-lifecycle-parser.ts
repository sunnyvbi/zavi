
export type SlackMessageLifecycle =
  | { kind: "deleted"; channel_id: string; source_ts: string }
  | { kind: "changed"; channel_id: string; source_ts: string; new_text: string }
  | null;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function parseSlackMessageLifecycle(event: unknown): SlackMessageLifecycle {
  if (!event || typeof event !== "object") return null;
  const ev = event as Record<string, unknown>;

  if (str(ev.type) === "app_mention" && ev.edited && typeof ev.edited === "object") {
    const channel_id = str(ev.channel);
    const source_ts = str(ev.ts);
    if (!channel_id || !source_ts) return null;
    return { kind: "changed", channel_id, source_ts, new_text: str(ev.text) };
  }

  if (str(ev.type) !== "message") return null;
  const subtype = str(ev.subtype);

  if (subtype === "message_deleted") {
    const channel_id = str(ev.channel);
    const source_ts = str(ev.deleted_ts);
    if (!channel_id || !source_ts) return null;
    return { kind: "deleted", channel_id, source_ts };
  }

  if (subtype === "message_changed") {
    const msg = (ev.message as Record<string, unknown> | undefined) ?? undefined;
    const channel_id = str(ev.channel) || str(msg?.channel);
    const source_ts = str(msg?.ts);
    if (!channel_id || !source_ts) return null;
    return { kind: "changed", channel_id, source_ts, new_text: str(msg?.text) };
  }

  return null;
}
