
import type { McpCallResult, McpTool } from "../types";
import { listChannelsTool } from "@/services/tools/slack/list_channels";
import { getChannelHistoryTool } from "@/services/tools/slack/get_channel_history";
import { postMessageTool } from "@/services/tools/slack/post_message";
import { openDmTool } from "@/services/tools/slack/open_dm";
import { uploadFileTool } from "@/services/tools/slack/upload_file_tool";
import { readThreadTool } from "@/services/tools/slack/read_thread";
import { readFileTool } from "@/services/tools/slack/read_file";
import { searchUsersTool } from "@/services/tools/slack/search_users";
import { readUserProfileTool } from "@/services/tools/slack/read_user_profile";
import { listChannelMembersTool } from "@/services/tools/slack/list_channel_members";
import { serviceClient } from "@/services/supabase";
import { withRequestedByFooter } from "@/services/tools/slack/provenance-footer";
import type { ActorAuthorityEnvelopeV1 } from "@/services/agents/actor-envelope";
import { getReactionsTool } from "@/services/tools/slack/get_reactions";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [
  listChannelsTool,
  getChannelHistoryTool,
  postMessageTool,
  openDmTool,
  uploadFileTool,
  readThreadTool,
  readFileTool,
  searchUsersTool,
  readUserProfileTool,
  listChannelMembersTool,
  getReactionsTool,
];

export function listSlackTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^slack_/, "");
    return {
      server_id: "slack",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callSlackTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
  team_id?: string,
  actor?: ActorAuthorityEnvelopeV1,
  run_id?: string,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `slack_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `slack/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    if (tool_name === "post_message" && actor) {
      const p = parsedInput as { text?: unknown };
      if (typeof p.text === "string" && p.text) {
        p.text = await withRequestedByFooter(serviceClient(), tenant_id, actor, p.text);
      }
    }
    const ctx = {
      tenant_id,
      slack_team_id: team_id,
      run_id,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/slack/${tool_name}] ${msg}`, meta ?? "");
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
          error: e.code,
          message: e.message,
          ...(e.meta ? { meta: e.meta } : {}),
        }),
        ms: Date.now() - start,
      };
    }
    const isZod = (e as { name?: string })?.name === "ZodError";
    if (isZod) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "tool_input_invalid",
          message: (e as Error).message,
        }),
        ms: Date.now() - start,
      };
    }
    throw e;
  }
}
