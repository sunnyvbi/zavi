
import {
  looksLikeWriteToolName,
  isDynamicVendorServerId,
  WRITE_VERB_RE,
  deriveToolCapability,
} from "./tool-capability";
export { looksLikeWriteToolName, isDynamicVendorServerId, WRITE_VERB_RE };
import type { FailClosedMode } from "./capability-failclosed";

export const ALLOWED_WRITE_TOOLS: Readonly<Record<string, ReadonlySet<string>>> = {
  higgsfield: new Set<string>(["generate_video", "generate_image", "generate_audio"]),
};

export const READ_BASELINE: ReadonlySet<string> = new Set<string>([
  "web_search__search",
  "web_fetch__fetch",
  "apify__rag_web_browser",
]);

export function isReadBaselineTool(anthropic_name: string): boolean {
  return READ_BASELINE.has(anthropic_name);
}

export function effectiveDeclaredTools(declared: readonly string[]): string[] {
  const out = [...declared];
  const seen = new Set(declared);
  for (const t of READ_BASELINE) {
    if (!seen.has(t)) {
      out.push(t);
      seen.add(t);
    }
  }
  return out;
}

export const MESSAGING_BASELINE: ReadonlySet<string> = new Set<string>([
  "slack__search_users",
  "slack__post_message",
  "slack__open_dm",
  "slack__upload_file",
  "slack__list_channels",
  "slack__get_channel_history",
  "slack__read_thread",
  "slack__read_user_profile",
  "slack__list_channel_members",
  "slack__get_reactions",
]);

export function isMessagingBaselineTool(anthropic_name: string): boolean {
  return MESSAGING_BASELINE.has(anthropic_name);
}

export function withMessagingBaseline(
  declared: readonly string[],
  slackConnected: boolean,
): string[] {
  if (!slackConnected) return [...declared];
  const out = [...declared];
  const seen = new Set(declared);
  for (const t of MESSAGING_BASELINE) {
    if (!seen.has(t)) {
      out.push(t);
      seen.add(t);
    }
  }
  return out;
}

export const UNIVERSAL_TOOL_BASELINE: ReadonlySet<string> = new Set<string>([
  "browser__task",
  "praxis__list_open_cards",
  "praxis__show_card",
]);

export function isUniversalBaselineTool(anthropic_name: string): boolean {
  return UNIVERSAL_TOOL_BASELINE.has(anthropic_name);
}

export function withUniversalBaseline(declared: readonly string[]): string[] {
  const out = [...declared];
  const seen = new Set(declared);
  for (const t of UNIVERSAL_TOOL_BASELINE) {
    if (!seen.has(t)) {
      out.push(t);
      seen.add(t);
    }
  }
  return out;
}

export const READ_TOOL_FALLBACK: Readonly<Record<string, ReadonlySet<string>>> = {
  higgsfield: new Set<string>(["balance", "list_workspaces", "job_display", "job_status", "list_voices"]),
};

export function isAllowedWriteTool(server_id: string, tool_name: string): boolean {
  return ALLOWED_WRITE_TOOLS[server_id]?.has(tool_name) ?? false;
}

export function isReadFallbackTool(server_id: string, tool_name: string): boolean {
  return READ_TOOL_FALLBACK[server_id]?.has(tool_name) ?? false;
}

export function hasWriteAllowlist(server_id: string): boolean {
  return server_id in ALLOWED_WRITE_TOOLS;
}

export function isRemoteCallExecAllowed(server_id: string, tool_name: string): boolean {
  if (!hasWriteAllowlist(server_id)) return true;
  return isAllowedWriteTool(server_id, tool_name) || isReadFallbackTool(server_id, tool_name);
}

export function isRemoteToolAllowed(
  server_id: string,
  tool_name: string,
  annotationsOrReadOnlyHint:
    | boolean
    | { readOnlyHint?: boolean; [k: string]: unknown }
    | undefined,
  opts?: { mode?: FailClosedMode; bypassed?: boolean },
): boolean {
  const annotations =
    typeof annotationsOrReadOnlyHint === "boolean"
      ? { readOnlyHint: annotationsOrReadOnlyHint }
      : annotationsOrReadOnlyHint;
  const readOnlyHint = annotations?.readOnlyHint;
  if (readOnlyHint === true) {
    if (isDynamicVendorServerId(server_id) && looksLikeWriteToolName(tool_name)) {
      return false;
    }
    const positivelyWrite =
      deriveToolCapability({ server_id, tool_name, annotations }).write === "yes";
    if (positivelyWrite) {
      const enforce = (opts?.mode ?? "enforce") === "enforce" && !opts?.bypassed;
      return !enforce;
    }
    return true;
  }
  if (isReadFallbackTool(server_id, tool_name)) return true;
  if (isAllowedWriteTool(server_id, tool_name)) return true;
  return false;
}
