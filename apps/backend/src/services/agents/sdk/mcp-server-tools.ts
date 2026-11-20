
import { z } from "zod";
import type { AnyZodRawShape } from "@anthropic-ai/claude-agent-sdk";
import { listToolsForTenant } from "@/services/mcp/discovery";

export {
  buildToolInputShape,
  repairArgsFromSchema,
  unwrapToolArgs,
  type ToolRawShape,
} from "./tool-input-shape";
import {
  buildToolInputShape,
  repairArgsFromSchema,
  sdkToolDescription,
  unwrapToolArgs,
  type ToolRawShape,
} from "./tool-input-shape";
type SdkTool = typeof import("@anthropic-ai/claude-agent-sdk")["tool"];
export function normalizeToolName(name: string): string {
  return name.replace(/^mcp__server__/, "").replace(/_+/g, "_").toLowerCase();
}

function makeTool(sdkTool: SdkTool) {
  return function tool<S extends ToolRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (
      args: { [K in keyof S]: z.infer<S[K]> },
      extra: unknown,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
    alwaysLoad?: boolean,
  ) {
    return sdkTool(
      name,
      description,
      inputSchema as unknown as AnyZodRawShape,
      handler as never,
      alwaysLoad ? { alwaysLoad: true } : undefined,
    );
  };
}
import { callMcpTool } from "@/services/mcp/execute";
import { fromAnthropicName } from "@/services/mcp/types";
import { isToolServerBlockedForAgent } from "@/services/billing/tiers";
import { stripMemoryToolsIfOff } from "../memory-mode";
import { stripProposeToolsOnRedo } from "../redo-mode";
import { stripVariantDisabledTools } from "../engine/variant-config";
import type { DispatchTool } from "../engine/dispatch-tool";
import type { EngineToolResult } from "../engine/types";

export type BackendToolCtx = {
  tenant_id: string;
  run_id: string;
  agent_slug?: string;
  trigger?: string;
  untrusted_context?: boolean;
  captured_page_context?: boolean;
  verified_member_email_reply?: boolean;
  top_action_run?: boolean;
  founder_chat_order?: boolean;
  founder_order_unverified?: boolean;
  founder_order_tell?: boolean;
  founder_order_group?: string;
  rules_steered?: { budget: boolean; status: boolean };
  chat_thread_id?: string;
  user_id?: string;
  actor?: import("@/services/agents/actor-envelope").ActorAuthorityEnvelopeV1;
  memory_mode?: "on" | "off";
  redo?: boolean;
  chat_answer_turn?: boolean;
  disabled_tools?: readonly string[];
  suppress_skill_runtime?: boolean;
  repo_full_name?: string;
  emit_decision?: (decision_class: string, body: unknown) => Promise<string>;
  writes_suppressed?: boolean;
  slack_routing?: {
    channel_id: string;
    thread_ts: string;
    original_ts: string;
    event_id: string;
    team_id?: string;
  };
  slack_target_team_id?: string;
  slack_post_blocked?: boolean;
  email_routing?: {
    thread_id: string;
    email_message_id: string;
    rfc_message_id: string | null;
    from: string;
    envelope_to: string;
    identity_id: string | null;
  };
};

function textResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
    ],
  };
}

function errorResult(error: string, message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify({ error, message }) }],
    isError: true,
  };
}

const SANDBOX_TOOL_NAMES = new Set([
  "write_file",
  "read_file",
  "run_bash",
  "run_tests",
  "git_diff",
  "git_status",
  "app_verify",
  "run_typecheck",
]);

export function isBackendResidentTool(anthropicName: string): boolean {
  const parts = fromAnthropicName(anthropicName);
  if (!parts) return true;
  if (parts.server_id === "daytona") return false;
  if (
    SANDBOX_TOOL_NAMES.has(parts.tool_name) &&
    (parts.server_id === "sandbox" || parts.server_id === "daytona")
  ) {
    return false;
  }
  return true;
}

export async function mcpServerTools(
  ctx: BackendToolCtx,
  declaredTools: string[],
  dispatchTool?: DispatchTool,
  alwaysLoadTools: readonly string[] = [],
) {
  const { createSdkMcpServer, tool: sdkTool } = await import(
    "@anthropic-ai/claude-agent-sdk"
  );
  const alwaysLoadSet = new Set(alwaysLoadTools.map(normalizeToolName));
  const tool = makeTool(sdkTool);

  const resolved = await listToolsForTenant(ctx.tenant_id, declaredTools, ctx.agent_slug, {
    suppressSkillTool: ctx.suppress_skill_runtime === true,
  });

  const backendTools = stripVariantDisabledTools(
    stripProposeToolsOnRedo(
      stripMemoryToolsIfOff(
        resolved.filter(
          (t) =>
            isBackendResidentTool(t.name) &&
            !isToolServerBlockedForAgent(ctx.agent_slug, fromAnthropicName(t.name)?.server_id ?? ""),
        ),
        { memory_mode: ctx.memory_mode },
      ),
      ctx.redo === true,
      ctx.chat_answer_turn === true,
    ),
    ctx.disabled_tools,
  );

  const sdkTools = backendTools.map((t) => {
    const parts = fromAnthropicName(t.name);
    if (!parts) {
      throw new Error(`mcp-server-tools: malformed tool name '${t.name}'`);
    }
    const description = sdkToolDescription(t.description, t.input_schema);

    const { shape: toolShape, declaresOwnInput } = buildToolInputShape(t.input_schema);

    let invocationSeq = 0;
    return tool(
      t.name,
      description,
      toolShape,
      async (args) => {
        try {
          const realInput = repairArgsFromSchema(
            t.input_schema,
            unwrapToolArgs(args, declaresOwnInput),
          );
          const tool_use_id = `${ctx.run_id}__${t.name}__inv${invocationSeq++}`;

          let result: EngineToolResult;
          if (dispatchTool) {
            result = await dispatchTool({
              tool_name: t.name,
              server_id: parts.server_id,
              bare_tool_name: parts.tool_name,
              input: realInput,
              tool_use_id,
            });
          } else {
            const raw = await callMcpTool(
              {
                tenant_id: ctx.tenant_id,
                run_id: ctx.run_id,
                agent_slug: ctx.agent_slug,
                trigger: ctx.trigger,
                untrusted_context: ctx.untrusted_context,
                captured_page_context: ctx.captured_page_context,
                verified_member_email_reply: ctx.verified_member_email_reply,
                top_action_run: ctx.top_action_run,
                founder_chat_order: ctx.founder_chat_order,
                founder_order_unverified: ctx.founder_order_unverified,
                founder_order_tell: ctx.founder_order_tell,
                founder_order_group: ctx.founder_order_group,
                rules_steered: ctx.rules_steered,
                chat_thread_id: ctx.chat_thread_id,
                user_id: ctx.user_id,
                actor: ctx.actor,
                repo_full_name: ctx.repo_full_name,
                emit_decision: ctx.emit_decision,
                writes_suppressed: ctx.writes_suppressed,
                redo: ctx.redo,
                slack_routing: ctx.slack_routing,
                slack_target_team_id: ctx.slack_target_team_id,
                slack_post_blocked: ctx.slack_post_blocked,
                email_routing: ctx.email_routing,
                tool_use_id,
              },
              parts.server_id,
              parts.tool_name,
              realInput,
            );
            result = { is_error: raw.is_error, content: raw.content, ms: raw.ms };
          }
          if (result.is_error) {
            return {
              content: [{ type: "text" as const, text: result.content }],
              isError: true,
            };
          }
          return textResult(result.content);
        } catch (e) {
          return errorResult("dispatch_failed", (e as Error).message);
        }
      },
      alwaysLoadSet.has(normalizeToolName(t.name)),
    );
  });

  return createSdkMcpServer({
    name: "praxis-server",
    version: "0.1.0",
    tools: sdkTools,
  });
}
