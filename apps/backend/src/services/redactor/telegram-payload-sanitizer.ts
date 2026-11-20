
import { redactValue } from "./index";

const MAX_DEPTH = 32;
const MAX_NODES = 50_000;

const STRUCTURAL_KEYS = new Set<string>([
  "type",
  "file_id",
  "file_unique_id",
  "media_group_id",
  "custom_emoji_id",
  "language_code",
  "status",
]);

const TELEGRAM_FIELD_HINT: Record<string, string> = {
  text: "text",
  caption: "text",
  title: "text",
  first_name: "name",
  last_name: "name",
  username: "name",
  file_name: "text",
  phone_number: "phone",
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
    const col = TELEGRAM_FIELD_HINT[keyHint] ?? keyHint;
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

export function sanitizeTelegramUpdatePayload(update: unknown): unknown {
  return sanitizeNode(update, "", 0, { n: 0 });
}
