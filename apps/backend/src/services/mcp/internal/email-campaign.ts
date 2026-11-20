
import type { McpCallResult, McpTool } from "../types";
import { emailCampaignListAudiencesTool } from "@/services/tools/email-campaign/list_audiences";
import { emailCampaignGetResultsTool } from "@/services/tools/email-campaign/get_results";
import type { EmitDecisionFn } from "@/services/channels/exec-emit";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToolErrorResult } from "./_zod-tool-error";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [emailCampaignListAudiencesTool, emailCampaignGetResultsTool];

export function listEmailCampaignTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^email_campaign_/, "");
    return {
      server_id: "email_campaign",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export type EmailCampaignToolCtx = {
  tenant_id: string;
  run_trigger?: string;
  run_id?: string;
  writes_suppressed?: boolean;
  redo?: boolean;
  emit_decision?: EmitDecisionFn;
};

export async function callEmailCampaignTool(
  ctx: EmailCampaignToolCtx,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `email_campaign_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `email_campaign/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  }
  const input = spec.input_schema.safeParse(args);
  if (!input.success) return zodToolErrorResult({ tenant_id: ctx.tenant_id, run_id: ctx.run_id ?? null }, "email_campaign", tool_name, input.error, Date.now() - start);
  try {
    const parsedInput = input.data;
    const toolCtx = {
      tenant_id: ctx.tenant_id,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/email-campaign/${tool_name}] ${msg}`, meta ?? "");
      },
    };
    const output = await spec.execute(toolCtx, parsedInput);
    return { ok: true, is_error: false, content: JSON.stringify(output), ms: Date.now() - start };
  } catch (e) {
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
