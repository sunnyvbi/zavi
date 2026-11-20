
import { redactValue } from "./index";

const STRUCTURAL = ["message_handle", "date_sent", "service", "message_type", "status", "was_downgraded", "sendblue_number"] as const;

export function sanitizeIMessagePayload(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of STRUCTURAL) if (body[k] !== undefined) out[k] = body[k];
  out.from = redactValue("phone", String(body.from_number ?? body.number ?? ""));
  out.content = redactValue("text", String(body.content ?? ""));
  out.has_media = Boolean(body.media_url);
  return out;
}
