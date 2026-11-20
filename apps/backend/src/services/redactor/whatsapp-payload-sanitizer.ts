
import { redactValue } from "./index";

const MAX_DEPTH = 32;
const MAX_NODES = 50_000;

const STRUCTURAL_KEYS = new Set<string>([
  "object",
  "field",
  "messaging_product",
  "phone_number_id",
  "id",
  "type",
  "timestamp",
  "mime_type",
  "sha256",
  "status",
  "code",
  "expiration_timestamp",
  "origin",
  "billable",
  "pricing_model",
  "category",
]);

const WHATSAPP_FIELD_HINT: Record<string, string> = {
  wa_id: "phone",
  from: "phone",
  recipient_id: "phone",
  display_phone_number: "phone",
  name: "name",
  body: "text",
  caption: "text",
  filename: "text",
  description: "text",
  address: "address",
  latitude: "location",
  longitude: "location",
  email: "email",
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
    const col = WHATSAPP_FIELD_HINT[keyHint] ?? keyHint;
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

export function sanitizeWhatsAppPayload(body: unknown): unknown {
  return sanitizeNode(body, "", 0, { n: 0 });
}
