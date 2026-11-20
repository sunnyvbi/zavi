
import { fromAnthropicName } from "@/services/mcp/types";
import { isMessagingBaselineTool } from "@/services/mcp/write-allowlist";
import { SKILL_LOAD_TOOL_NAME } from "./skill-runtime";
import { SANDBOX_TOOL_NAMES, type SandboxToolName } from "@/services/sandbox/tool-registry";
import { toCanonicalSandboxName } from "./engine/openai-sandbox-tools";

export function canonicalizeDeclaredForSearch(declared: readonly string[]): string[] {
  return declared.map((d) =>
    (SANDBOX_TOOL_NAMES as readonly string[]).includes(d)
      ? toCanonicalSandboxName(d as SandboxToolName)
      : d,
  );
}

export function isInjectedRunTool(name: string): boolean {
  return (
    name === SKILL_LOAD_TOOL_NAME ||
    fromAnthropicName(name)?.server_id === "tenant_skill" ||
    isMessagingBaselineTool(name)
  );
}
