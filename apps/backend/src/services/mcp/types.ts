
import type { ToolEffect } from "@/services/tools/types";

export type McpTransport = "internal" | "streamable-http" | "stdio";

export type McpServerRow = {
  tenant_id: string;
  server_id: string;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  args: string[] | null;
  enabled: boolean;
};

export type McpTool = {
  server_id: string;
  tool_name: string;
  description: string;
  input_schema: { type: "object"; [k: string]: unknown };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
  effect?: ToolEffect;
  requires_approval?: boolean;
};

export type AnthropicMcpTool = {
  name: string;
  description: string;
  input_schema: { type: "object"; [k: string]: unknown };
};

export type McpCallResult = {
  ok: boolean;
  content: string;
  is_error: boolean;
  ms: number;
  access_notes?: import("@/services/data-gateway/types").AccessNote[];
};

export const MCP_NAME_SEPARATOR = "__";

export function toAnthropicName(server_id: string, tool_name: string): string {
  return `${server_id}${MCP_NAME_SEPARATOR}${tool_name}`;
}

export function fromAnthropicName(name: string): { server_id: string; tool_name: string } | null {
  const idx = name.indexOf(MCP_NAME_SEPARATOR);
  if (idx <= 0) return null;
  return {
    server_id: name.slice(0, idx),
    tool_name: name.slice(idx + MCP_NAME_SEPARATOR.length),
  };
}

const TRACE_WRAPPER_ROOT = "mcp";
const TRACE_WRAPPER_INNER = "server";

export function fromTracedToolName(
  name: string,
): { server_id: string; tool_name: string } | null {
  if (typeof name !== "string" || name.length === 0) return null;
  const strip = (s: string, segment: string): string | null => {
    const prefix = segment + MCP_NAME_SEPARATOR;
    return s.startsWith(prefix) ? s.slice(prefix.length) : null;
  };
  let rest = strip(name, TRACE_WRAPPER_ROOT);
  if (rest === null) return fromAnthropicName(name);
  rest = strip(rest, TRACE_WRAPPER_INNER) ?? rest;
  return fromAnthropicName(rest);
}
