
import { redactValue } from "./index";

const MAX_DEPTH = 32;
const MAX_NODES = 50_000;

const STRUCTURAL_KEYS = new Set<string>([
  "id",
  "type",
  "channelId",
  "serviceUrl",
  "timestamp",
  "localTimestamp",
  "replyToId",
  "aadObjectId",
  "objectId",
  "tenantId",
  "activityId",
  "locale",
  "channelId",
]);

const TEAMS_FIELD_HINT: Record<string, string> = {
  text: "text",
  name: "name",
  content: "text",
  title: "text",
  value: "text",
  displayName: "display_name",
  givenName: "name",
  surname: "name",
  email: "email",
  userPrincipalName: "email",
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
    const col = TEAMS_FIELD_HINT[keyHint] ?? keyHint;
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

export function sanitizeTeamsActivityPayload(activity: unknown): unknown {
  return sanitizeNode(activity, "", 0, { n: 0 });
}
