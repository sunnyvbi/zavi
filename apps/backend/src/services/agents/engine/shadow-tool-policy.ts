
import { effectOf } from "@/services/mcp/tool-effects";
import { fromAnthropicName } from "@/services/mcp/types";
import type { ToolCallTrace } from "@/services/tools/types";

const SHADOW_READ_SERVERS: ReadonlySet<string> = new Set([
  "memory",
  "operator_db",
  "praxis_corpus",
  "code_index",
  "report",
  "praxis",
  "github",
  "slack",
  "jira",
  "linear",
  "qa_engineer",
  "web_fetch",
  "web_search",
  "apify",
  "competitor_intel",
  "product",
  "google_ads",
  "meta_ads",
  "paid_acquisition",
  "chatgpt_ads",
  "growth",
]);

const SHADOW_DENY_TOOLS: ReadonlySet<string> = new Set([
  "growth__read_cohort",
  "operator_db__codeact",
]);

export const SHADOW_DENY_BODY =
  "shadow mode: this tool is disabled for an offline evaluation run, so no " +
  "side-effecting or external call can be made. Continue and produce your best " +
  "answer using only the information already available to you.";

export const SHADOW_DENY_CODE = "shadow_no_side_effect";

export function isShadowReadAllowed(
  server_id: string | undefined,
  bare_tool_name: string | undefined,
): boolean {
  if (!server_id || !bare_tool_name) return false;
  if (!SHADOW_READ_SERVERS.has(server_id)) return false;
  if (SHADOW_DENY_TOOLS.has(`${server_id}__${bare_tool_name}`)) return false;
  return effectOf(server_id, bare_tool_name) === "read";
}

export function isShadowReadAllowedByName(
  tool_name: string,
  pre_server_id?: string,
  pre_bare?: string,
): boolean {
  if (pre_server_id && pre_bare) {
    return isShadowReadAllowed(pre_server_id, pre_bare);
  }
  const parts = fromAnthropicName(tool_name);
  if (!parts) return false;
  return isShadowReadAllowed(parts.server_id, parts.tool_name);
}

export const SHADOW_READ_SERVERS_FOR_TEST = SHADOW_READ_SERVERS;
export const SHADOW_DENY_TOOLS_FOR_TEST = SHADOW_DENY_TOOLS;

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function canonicalToolName(name: string): string {
  return name.startsWith("mcp__server__") ? name.slice("mcp__server__".length) : name;
}

export function shadowSig(toolName: string, input: unknown): string {
  const canon = canonicalToolName(toolName);
  const parts = fromAnthropicName(canon);
  const norm = parts ? `${parts.server_id}__${parts.tool_name}` : canon;
  return `${norm}|${stableStringify(input)}`;
}

export type ShadowToolResult = { content: string; is_error: boolean };

export function buildShadowToolResults(
  traces: ReadonlyArray<ToolCallTrace> | null | undefined,
): Map<string, ShadowToolResult[]> {
  const map = new Map<string, ShadowToolResult[]>();
  for (const t of traces ?? []) {
    const parts = fromAnthropicName(canonicalToolName(t.name));
    if (!parts) continue;
    if (!isShadowReadAllowed(parts.server_id, parts.tool_name)) continue;
    if (!t.input_preview || t.input_preview.includes("…[truncated")) continue;
    let input: unknown;
    try {
      input = JSON.parse(t.input_preview);
    } catch {
      continue;
    }
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const keys = Object.keys(input as Record<string, unknown>);
      if (keys.length === 1 && keys[0] === "input") {
        input = (input as Record<string, unknown>).input;
      }
    }
    const sig = shadowSig(t.name, input);
    const arr = map.get(sig) ?? [];
    arr.push({ content: t.output_preview ?? "", is_error: t.status !== "ok" });
    map.set(sig, arr);
  }
  return map;
}
