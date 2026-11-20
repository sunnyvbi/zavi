
import { effectOf } from "@/services/mcp/tool-effects";
import { isLabSimulatedTool } from "./lab-simulate";
import { fromAnthropicName } from "@/services/mcp/types";
import { isSdkHarnessMetaTool } from "../sdk-builtins";
import type { ToolEffect } from "@/services/tools/types";
import type { ResolvedVariant } from "../engine/variant-config";

export const LAB_ALWAYS_DENY: ReadonlySet<string> = new Set([
  "handoff",
  "handoff_parallel",
  "ask_agent",
  "remind",
  "render_video",
  "enable_database",
  "generate_image",
  "codeact",
]);

export const LAB_ALWAYS_DENY_FULL: ReadonlySet<string> = new Set(["browser__task", "extension__browser_task"]);

export const LAB_DENY_REASON =
  "blocked in variants lab (read-only). Not executed; say what you would do instead.";

export const LAB_DENY_CODE = "variants_lab_readonly";

export function labBareToolName(raw: string): string {
  if (raw.startsWith("mcp__server__")) return raw.slice("mcp__server__".length);
  if (raw.startsWith("mcp__")) return raw.slice("mcp__".length);
  return raw;
}

export function isLabDeniedTool(
  name: string,
  effects?: Map<string, ToolEffect>,
): boolean {
  try {
    if (isSdkHarnessMetaTool(name)) return false;
    const parts = fromAnthropicName(labBareToolName(name));
    if (!parts) return true;
    if (isLabSimulatedTool(parts.server_id, parts.tool_name)) return false;
    if (LAB_ALWAYS_DENY.has(parts.tool_name)) return true;
    if (LAB_ALWAYS_DENY_FULL.has(`${parts.server_id}__${parts.tool_name}`)) return true;
    return effectOf(parts.server_id, parts.tool_name, effects) !== "read";
  } catch {
    return true;
  }
}

export function labVariantOverride(ctx: {
  variants_lab?: boolean;
  variant_override?: ResolvedVariant;
}): ResolvedVariant | undefined {
  return ctx.variants_lab === true ? ctx.variant_override : undefined;
}
