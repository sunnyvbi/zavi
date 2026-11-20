import type { McpCallResult, McpTool } from "../types";
import { ZodError } from "zod";
import { chatgptAdsReadPerformanceTool } from "@/services/tools/chatgpt-ads/read_performance";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

import { chatgptAdsProposeNewCampaign, chatgptAdsProposeBudgetChange, chatgptAdsProposeStatus, resolveChatgptAdsEmit } from "@/services/tools/chatgpt-ads/propose";
import type { ToolContext } from "@/services/tools/types";
import type { ExecEmitCtx } from "@/services/channels/exec-emit";
const TOOLS = [chatgptAdsReadPerformanceTool, chatgptAdsProposeNewCampaign, chatgptAdsProposeBudgetChange, chatgptAdsProposeStatus];

export function listChatgptAdsTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^chatgpt_ads_/, "");
    return {
      server_id: "chatgpt_ads",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callChatgptAdsTool(
  context: string | (Omit<ToolContext, "log"> & ExecEmitCtx),
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `chatgpt_ads_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `chatgpt_ads/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const supplied = typeof context === "string" ? { tenant_id: context } : context;
    const ctx = {
      ...supplied,
      emit_decision: spec.effect === "write" ? await resolveChatgptAdsEmit(supplied) : undefined,
      tenant_id: supplied.tenant_id,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/chatgpt_ads/${tool_name}] ${msg}`, meta ?? "");
      },
    };
    const output = await spec.execute(ctx, parsedInput);
    return { ok: true, is_error: false, content: JSON.stringify(output), ms: Date.now() - start };
  } catch (e) {
    if (e instanceof ZodError) {
      const schema = zodToJsonSchema(spec.input_schema);
      const properties = (schema.properties ?? {}) as Record<string, unknown>;
      const fields = [...new Set(e.issues.map(issue => issue.path[0]).filter((field): field is string => typeof field === "string"))];
      const fieldSchemas = Object.fromEntries(fields.filter(field => Object.hasOwn(properties, field)).map(field => [field, properties[field]]));
      if (e.issues.some(issue => issue.path.length === 0)) fieldSchemas.$ = schema;
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "invalid_input",
          message: tool_name === "propose_new_campaign"
            ? "Correct the listed fields using field_schemas; use only the declared field names and enum values. Nothing was proposed." + (fields.includes("ads") ? " Ad fields are name, title, body, target_url and exactly one image source: image_artifact_id, image_path or image_url. A generated artifact ID belongs in image_artifact_id, not image_url." : "")
            : "Check the tool schema and correct the listed fields. Nothing changed.",
          issues: e.issues.map(({ path, message }) => ({ path, message })),
          field_schemas: fieldSchemas,
        }),
        ms: Date.now() - start,
      };
    }
    if (e instanceof ExpectedToolError) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: e.code,
          message: e.message,
          ...(e.meta ? { meta: e.meta } : {}),
        }),
        ms: Date.now() - start,
      };
    }
    throw e;
  }
}
