
import { tool } from "langchain";
import * as z from "zod";
import { INTERNAL_SERVERS } from "@/services/mcp/tool-effect-classifier";
import { effectOf } from "@/services/mcp/tool-effects";
import type { AgentEngineRunSpec, EngineToolSpec } from "../engine/types";

export function splitToolName(name: string): { serverId: string; bare: string } {
  const i = name.indexOf("__");
  if (i < 0) return { serverId: "", bare: name };
  return { serverId: name.slice(0, i), bare: name.slice(i + 2) };
}

export function isUsableObjectSchema(jsonSchema: unknown): boolean {
  if (!jsonSchema || typeof jsonSchema !== "object") return false;
  const s = jsonSchema as { type?: unknown; properties?: unknown };
  return s.type === "object" && !!s.properties && typeof s.properties === "object";
}

export function buildToolDescription(spec: EngineToolSpec): string {
  if (isUsableObjectSchema(spec.jsonSchema)) return spec.description;
  let schema: string;
  try {
    schema = JSON.stringify(spec.jsonSchema);
  } catch {
    schema = "{}";
  }
  return `${spec.description}\n\nInput JSON Schema:\n${schema}`;
}

export function wrapAsLangChainTool(
  spec: EngineToolSpec,
  run: Pick<AgentEngineRunSpec, "dispatchTool">,
) {
  const { serverId, bare } = splitToolName(spec.name);
  return tool(
    async (input: unknown, config?: { toolCall?: { id?: string } }) => {
      const result = await run.dispatchTool({
        tool_name: spec.name,
        server_id: serverId,
        bare_tool_name: bare,
        input,
        tool_use_id: config?.toolCall?.id ?? `${spec.name}-${Date.now()}`,
      });
      return result.content;
    },
    {
      name: spec.name,
      description: buildToolDescription(spec),
      schema: isUsableObjectSchema(spec.jsonSchema)
        ? (spec.jsonSchema as never)
        : (z.record(z.string(), z.unknown()) as never),
    },
  );
}

export function buildLangChainTools(spec: AgentEngineRunSpec) {
  return spec.tools.map((t) => wrapAsLangChainTool(t, spec));
}

const REMOTE_READ_VERBS = [
  "list", "get", "read", "search", "fetch", "find", "query",
  "describe", "check", "probe", "recent", "daily", "analyst",
];

export function isReadOnlyToolName(name: string): boolean {
  const { serverId, bare } = splitToolName(name);
  if (INTERNAL_SERVERS.has(serverId)) return effectOf(serverId, bare) === "read";
  return REMOTE_READ_VERBS.some((v) => bare === v || bare.startsWith(`${v}_`));
}

export function readOnlyToolSpecs(specs: readonly EngineToolSpec[]): EngineToolSpec[] {
  return specs.filter((s) => isReadOnlyToolName(s.name));
}
