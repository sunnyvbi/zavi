
import { ZodError } from "zod";
import type { McpCallResult, McpTool } from "../types";
import { discoveryWriteAnchorTool } from "@/services/tools/discovery/write-anchor";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const SERVER_ID = "onboarding_discovery";
const TOOLS = [discoveryWriteAnchorTool];

export function listOnboardingDiscoveryTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^onboarding_discovery_/, "");
    return {
      server_id: SERVER_ID,
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callOnboardingDiscoveryTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
  identity?: { run_id?: string; agent_slug?: string },
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `onboarding_discovery_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `${SERVER_ID}/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  }
  if (!identity?.agent_slug) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "discovery_no_agent_identity",
        message: `${SERVER_ID} requires a server-derived agent identity.`,
      }),
      ms: Date.now() - start,
    };
  }

  try {
    const parsedInput = spec.input_schema.parse(args);
    const ctx = {
      tenant_id,
      run_id: identity.run_id,
      agent_slug: identity.agent_slug,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/${SERVER_ID}/${tool_name}] ${msg}`, meta ?? "");
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
    if (e instanceof ZodError) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "discovery_bad_input",
          message: e.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "),
        }),
        ms: Date.now() - start,
      };
    }
    throw e;
  }
}
