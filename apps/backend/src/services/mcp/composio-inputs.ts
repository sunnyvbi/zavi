import { validateStepArgs } from "@/services/routines/arg-validate";
import type { McpTool, McpCallResult } from "./types";
import { composioSchemaError } from "./composio-schema-error";

const schemas = new Map<string, Map<string, McpTool["input_schema"]>>();

export function rememberComposioInputs(tenantId: string, tools: readonly McpTool[]): void {
  schemas.set(tenantId, new Map(tools.map((tool) => [tool.tool_name, tool.input_schema])));
}

export function composioInputSchema(tenantId: string, toolName: string): McpTool["input_schema"] | undefined {
  return schemas.get(tenantId)?.get(toolName);
}

export function validateComposioInputs(tenantId: string, toolName: string, args: unknown): McpCallResult | null {
  const schema = schemas.get(tenantId)?.get(toolName);
  if (!schema) return null;
  const input = args ?? {};
  const result = typeof input === "object" && !Array.isArray(input)
    ? validateStepArgs(toolName, input as Record<string, unknown>, schema)
    : { ok: false, reason: "Tool arguments must be an object." };
  const error = result.ok ? composioSchemaError(input, schema) : result.reason;
  if (!error) return null;
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({
      error: "composio_invalid_arguments",
      message: error,
      recovery: toolName === "TIKTOK_ADS_GET_CREATIVE_ASSETS"
        ? "Supply asset_type and known asset_ids from verified data. No request was sent and no approval was created. This tool looks up specified assets; it does not list the library."
        : "Supply the required inputs from verified data. No request was sent and no approval was created.",
    }),
    ms: 0,
  };
}
