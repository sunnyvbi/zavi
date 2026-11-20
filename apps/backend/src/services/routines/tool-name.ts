
import { createHash } from "crypto";
import { fromAnthropicName } from "@/services/mcp/types";

export const ROUTINE_SERVER_ID = "tenant_skill";

const RESERVED_SERVER_PREFIXES = [
  "praxis",
  "praxis_corpus",
  "slack",
  "github",
  "stripe",
  "email",
  "google_ads",
  "meta_ads",
  "paid_acquisition",
  "chatgpt_ads",
  "buffer",
  "growth",
  "memory",
  "operator_db",
  "web_search",
  "web_fetch",
  "apify",
  "jira",
  "linear",
  "qa_engineer",
  "report",
  "daytona",
  "pipedream",
];

export const ROUTINE_TOOL_NAME_RE =
  /^tenant_skill__[a-z0-9]+(?:-[a-z0-9]+)*__[0-9a-f]{8}$/;

const AGENT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function shortIdForRoutine(routine_id: string): string {
  return createHash("sha256").update(routine_id).digest("hex").slice(0, 8);
}

export type SynthesizeResult =
  | { ok: true; tool_name: string }
  | { ok: false; reason: string };

export function synthesizeRoutineToolName(
  agent_slug: string,
  routine_id: string,
): SynthesizeResult {
  if (!AGENT_SLUG_RE.test(agent_slug)) {
    return { ok: false, reason: `invalid agent_slug for tool-name synthesis: "${agent_slug}"` };
  }
  if (typeof routine_id !== "string" || routine_id.length === 0) {
    return { ok: false, reason: "empty routine_id for tool-name synthesis" };
  }
  const shortId = shortIdForRoutine(routine_id);
  const tool_name = `${ROUTINE_SERVER_ID}__${agent_slug}__${shortId}`;

  if (collidesWithReservedPrefix(tool_name)) {
    return { ok: false, reason: `synthesized id "${tool_name}" collides with a reserved platform prefix` };
  }
  if (!ROUTINE_TOOL_NAME_RE.test(tool_name)) {
    return { ok: false, reason: `synthesized id "${tool_name}" failed the strict callable-id regex` };
  }
  return { ok: true, tool_name };
}

export function collidesWithReservedPrefix(tool_name: string): boolean {
  const sep = tool_name.indexOf("__");
  const head = sep > 0 ? tool_name.slice(0, sep) : tool_name;
  return RESERVED_SERVER_PREFIXES.includes(head);
}

export function isValidEmittedToolName(
  emitted_tool_name: string | null | undefined,
  agent_slug: string,
): boolean {
  if (typeof emitted_tool_name !== "string" || emitted_tool_name.length === 0) {
    return false;
  }
  if (!ROUTINE_TOOL_NAME_RE.test(emitted_tool_name)) return false;
  if (collidesWithReservedPrefix(emitted_tool_name)) return false;
  const expectedPrefix = `${ROUTINE_SERVER_ID}__${agent_slug}__`;
  return emitted_tool_name.startsWith(expectedPrefix);
}

export function isRoutableRoutineStepTool(tool_name: string): boolean {
  const parts = fromAnthropicName(tool_name);
  if (!parts) return false;
  if (parts.server_id === ROUTINE_SERVER_ID) return false;
  return true;
}
