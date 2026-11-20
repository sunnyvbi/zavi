
import { redactValue } from "./index";

const MAX_DEPTH = 32;
const MAX_NODES = 50_000;

const STRUCTURAL_KEYS = new Set<string>([
  "id",
  "type",
  "channel_id",
  "guild_id",
  "author_id",
  "message_id",
  "application_id",
  "webhook_id",
  "timestamp",
  "edited_timestamp",
  "url",
  "proxy_url",
  "content_type",
]);

const DISCORD_FIELD_HINT: Record<string, string> = {
  content: "text",
  username: "name",
  global_name: "name",
  nick: "name",
  filename: "text",
  title: "text",
  description: "text",
};

function sanitizeNode(
  value: unknown,
  keyHint: string,
  depth: number,
  counter: { n: number },
): unknown {
  if (depth > MAX_DEPTH || counter.n > MAX_NODES) return value;
  counter.n += 1;

  if (typeof value === "string") {
    if (STRUCTURAL_KEYS.has(keyHint)) return value;
    const col = DISCORD_FIELD_HINT[keyHint] ?? keyHint;
    return redactValue(col, value) as unknown;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeNode(v, keyHint, depth + 1, counter));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeNode(v, k, depth + 1, counter);
    }
    return out;
  }
  return value;
}

export function sanitizeDiscordMessagePayload(message: unknown): unknown {
  return sanitizeNode(message, "", 0, { n: 0 });
}
