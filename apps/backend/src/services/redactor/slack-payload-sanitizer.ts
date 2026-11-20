
import { redactValue } from "./index";

const MAX_DEPTH = 32;
const MAX_NODES = 50_000;

const SLACK_FIELD_HINT: Record<string, string> = {
  display_name: "display_name",
  real_name: "real_name",
  username: "username",
  text: "text",
  fallback: "text",
  pretext: "text",
  title: "text",
  name: "name",
};

const SLACK_OPAQUE_ID_FIELDS = new Set<string>([
  "ts",
  "thread_ts",
  "deleted_ts",
  "event_ts",
  "client_msg_id",
  "channel",
  "channel_id",
  "team",
  "team_id",
  "source_team_id",
  "user_team",
  "event_id",
  "api_app_id",
  "app_id",
  "bot_id",
  "bot_user_id",
  "user",
  "user_id",
  "authed_user",
  "source_user_id",
  "previous_user",
  "inviter",
  "id",
  "file_id",
  "subtype",
  "type",
  "channel_type",
  "permalink",
  "deleted_user",
  "previous_message_user",
]);

type SanitizeCounters = {
  nodes: number;
  truncatedDepth: boolean;
  truncatedNodes: boolean;
};

function sanitizeNode(
  value: unknown,
  fieldName: string,
  depth: number,
  counters: SanitizeCounters,
): unknown {
  counters.nodes += 1;
  if (counters.nodes > MAX_NODES) {
    counters.truncatedNodes = true;
    return value;
  }
  if (depth > MAX_DEPTH) {
    counters.truncatedDepth = true;
    return value;
  }

  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (SLACK_OPAQUE_ID_FIELDS.has(fieldName)) return value;
    const hint = SLACK_FIELD_HINT[fieldName] ?? fieldName;
    return redactValue(hint, value);
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map((el) => sanitizeNode(el, fieldName, depth + 1, counters));
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = sanitizeNode(v, k, depth + 1, counters);
    }
    return out;
  }

  return value;
}

export function sanitizeSlackEventPayload(payload: unknown): unknown {
  const counters: SanitizeCounters = {
    nodes: 0,
    truncatedDepth: false,
    truncatedNodes: false,
  };
  const sanitized = sanitizeNode(payload, "$root", 0, counters);
  if (counters.truncatedDepth || counters.truncatedNodes) {
    // eslint-disable-next-line no-console
    console.warn(
      `[slack-payload-sanitizer] truncated walk (depth=${counters.truncatedDepth}, nodes=${counters.truncatedNodes}, total_nodes=${counters.nodes}); some leaf strings may not be redacted`,
    );
  }
  return sanitized;
}

export const _internals = {
  MAX_DEPTH,
  MAX_NODES,
  SLACK_FIELD_HINT,
  SLACK_OPAQUE_ID_FIELDS,
};
