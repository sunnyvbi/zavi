
import { ZodError } from "zod";
import type { McpCallResult, McpTool } from "../types";
import type { CallMcpContext } from "../execute";
import { renderPdfTool } from "@/services/tools/report/render_pdf";
import { renderCsvTool } from "@/services/tools/report/render_csv";
import { renderXlsxTool } from "@/services/tools/report/render_xlsx";
import { renderBlogTool } from "@/services/tools/report/render_blog";
import { renderWireframeTool } from "@/services/tools/report/render_wireframe";
import { renderDeckTool } from "@/services/tools/report/render_deck";
import { renderDocTool } from "@/services/tools/report/render_doc";
import { renderArtifactTool } from "@/services/tools/report/render_artifact";
import { getPageDesignGuideTool } from "@/services/tools/report/get_page_design_guide";
import { generateImageTool } from "@/services/tools/report/generate_image";
import { renderSocialImageTool } from "@/services/tools/report/render_social_image";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";

const TOOLS = [
  renderPdfTool,
  renderCsvTool,
  renderXlsxTool,
  renderBlogTool,
  renderWireframeTool,
  renderDeckTool,
  renderDocTool,
  renderArtifactTool,
  getPageDesignGuideTool,
  generateImageTool,
  renderSocialImageTool,
];

export function listReportTools(): McpTool[] {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.input_schema);
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} must be a top-level z.object()`);
    }
    const tool_name = t.name.replace(/^report_/, "");
    return {
      server_id: "report",
      tool_name,
      description: t.description,
      effect: t.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callReportTool(
  ctx: CallMcpContext,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const legacyName = `report_${tool_name}`;
  const spec = TOOLS.find((t) => t.name === legacyName);
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "tool_unknown",
        message: `report/${tool_name} not registered`,
      }),
      ms: Date.now() - start,
    };
  }
  if (!ctx.run_id) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({
        error: "missing_run_ctx",
        message: "report tools require an active run_id in context",
      }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsedInput = spec.input_schema.parse(args);
    const toolCtx = {
      tenant_id: ctx.tenant_id,
      run_id: ctx.run_id,
      agent_slug: ctx.agent_slug,
      log: (msg: string, meta?: Record<string, unknown>) => {
        console.log(`[mcp/internal/report/${tool_name}] ${msg}`, meta ?? "");
      },
    };
    const output = await (
      spec.execute as (ctx: unknown, input: unknown) => Promise<unknown>
    )(toolCtx, parsedInput);
    return {
      ok: true,
      is_error: false,
      content: JSON.stringify(output),
      ms: Date.now() - start,
    };
  } catch (e) {
    if (e instanceof ZodError) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({
          error: "invalid_input",
          message: e.issues.map((er) => er.message).join("; "),
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
