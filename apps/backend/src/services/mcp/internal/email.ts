
import type { McpCallResult, McpTool } from "../types";
import { emailSendTool } from "@/services/tools/email/send";
import { emailListInboxTool, emailGetThreadTool } from "@/services/tools/email/inbox";
import { BULK_SEND_CLASS, emailProposeCampaignTool } from "@/services/tools/email/propose_campaign";
import { emailListPlanTool, emailPlanSendTool } from "@/services/tools/email/plan_send";
import { resolveEmailCampaignEmit } from "@/services/tools/email-campaign/_exec-action";
import type { EmitDecisionFn, ExecEmitCtx } from "@/services/channels/exec-emit";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { isChatAnswerTurnEmit } from "@/services/agents/redo-mode";
import { zodToolErrorResult } from "./_zod-tool-error";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [emailSendTool, emailListInboxTool, emailGetThreadTool, emailProposeCampaignTool, emailPlanSendTool, emailListPlanTool] as ToolSpec[];

async function campaignEmit(run: Omit<ExecEmitCtx, "tenant_id">, tenant_id: string): Promise<EmitDecisionFn | undefined> {
  if (!run.emit_decision) return undefined;
  const raw = run.emit_decision;
  const tool = await resolveEmailCampaignEmit({ tenant_id, ...run });
  return (cls, body) => (cls === BULK_SEND_CLASS ? raw(cls, body) : tool ? tool(cls, body) : raw(cls, body));
}

export function listEmailTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^email_/, "");
    return {
      server_id: "email",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callEmailTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
  run: Omit<ExecEmitCtx, "tenant_id"> = {},
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `email_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `email/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  const input = spec.input_schema.safeParse(args);
  if (!input.success) return zodToolErrorResult({ tenant_id, run_id: run.run_id ?? null }, "email", tool_name, input.error, Date.now() - start);
  try {
    const parsedInput = input.data;
    const ctx = {
      tenant_id,
      run_id: run.run_id,
      run_trigger: run.run_trigger,
      writes_suppressed: run.writes_suppressed,
      chat_answer_turn: isChatAnswerTurnEmit(run.emit_decision),
      emit_decision: spec === (emailProposeCampaignTool as ToolSpec) ? await campaignEmit(run, tenant_id) : undefined,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/email/${tool_name}] ${msg}`, meta ?? "");
      },
    };
    const output = await spec.execute(ctx, parsedInput);
    return {
      ok: true,
      is_error: false,
      content: JSON.stringify(output),
      ms: Date.now() - start,
    };
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          message: e.message,
          error: e.code,
          ...(e.meta ? { meta: e.meta } : {}),
        }),
        ms: Date.now() - start,
      };
    }
    throw e;
  }
}
