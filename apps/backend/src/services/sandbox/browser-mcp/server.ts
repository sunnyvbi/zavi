
import { z } from "zod";
import type { AnyZodRawShape } from "@anthropic-ai/claude-agent-sdk";
import { runBrowserOp, claimScreenshotArtifactSlot } from "./backend";
import { persistImageArtifact } from "@/services/sandbox/tool-registry";
import { getBoolSetting } from "@/services/settings";
import { isAutoExecuteBrowserAgent } from "./browser-auto-execute-policy";
import { isNavOriginAllowed } from "./portal-allowlist";

type ToolRawShape = Record<string, z.ZodType>;
type SdkTool = typeof import("@anthropic-ai/claude-agent-sdk")["tool"];
function makeTool(sdkTool: SdkTool) {
  return function tool<S extends ToolRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (
      args: { [K in keyof S]: z.infer<S[K]> },
      extra: unknown,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
  ) {
    return sdkTool(name, description, inputSchema as unknown as AnyZodRawShape, handler as never);
  };
}
import {
  ALL_BROWSER_TOOL_NAMES,
  type BrowserToolCtx,
  type DaemonResult,
} from "./types";

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

function errorResult(code: string, message: string) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error_code: code, error_message: message }) },
    ],
    isError: true,
  };
}

function unwrapDaemonResult(r: DaemonResult): ReturnType<typeof textResult> {
  if (r.ok) return textResult(r);
  return errorResult(r.error_code, r.error_message);
}

const WAIT_FOR_MAX_MS = 45_000;

export async function mcpBrowser(ctx: BrowserToolCtx) {
  const { createSdkMcpServer, tool: sdkTool } = await import(
    "@anthropic-ai/claude-agent-sdk"
  );
  const tool = makeTool(sdkTool);

  const navTool = tool(
    "browser_nav",
    "Navigate the browser to a URL. Waits for `domcontentloaded` before returning. Returns { ok: true } on success.",
    { url: z.string().url() },
    async (args) => {
      if (ctx.staging_origin) {
        let reqOrigin: string;
        try {
          reqOrigin = new URL(args.url).origin;
        } catch {
          return errorResult(
            "url_invalid",
            `couldn't parse url: ${args.url}`,
          );
        }
        if (reqOrigin !== ctx.staging_origin) {
          return errorResult(
            "url_outside_allowlist",
            `requested origin ${reqOrigin} doesn't match allowlist ${ctx.staging_origin}`,
          );
        }
      }
      const portal = await isNavOriginAllowed(ctx.tenant_id, args.url);
      if (portal.hadAllowlist && !portal.allowed) {
        return errorResult(
          "url_outside_portal_allowlist",
          `origin ${portal.origin || "(unparseable)"} is not in this tenant's ` +
            `browser portal allowlist`,
        );
      }
      try {
        const r = await runBrowserOp(ctx, { op: "nav", url: args.url });
        return unwrapDaemonResult(r);
      } catch (e) {
        return errorResult("nav_failed", (e as Error).message);
      }
    },
  );

  const clickTool = tool(
    "browser_click",
    "Click the element matching the CSS selector. Throws if not found within 5s. Returns { ok: true } on success.",
    { selector: z.string().min(1) },
    async (args) => {
      try {
        const r = await runBrowserOp(ctx, { op: "click", selector: args.selector });
        return unwrapDaemonResult(r);
      } catch (e) {
        return errorResult("click_failed", (e as Error).message);
      }
    },
  );

  const fillTool = tool(
    "browser_fill",
    "Type a value into an <input> or <textarea> matching the CSS selector. Uses the native value-setter so React-controlled inputs fire onChange. Returns { ok: true } on success.",
    { selector: z.string().min(1), value: z.string() },
    async (args) => {
      try {
        const r = await runBrowserOp(ctx, { op: "fill", selector: args.selector, value: args.value });
        return unwrapDaemonResult(r);
      } catch (e) {
        return errorResult("fill_failed", (e as Error).message);
      }
    },
  );

  const textTool = tool(
    "browser_text",
    "Read the innerText of the element matching the CSS selector. Returns { ok: true, result: <text> }.",
    { selector: z.string().min(1) },
    async (args) => {
      try {
        const r = await runBrowserOp(ctx, { op: "text", selector: args.selector });
        return unwrapDaemonResult(r);
      } catch (e) {
        return errorResult("text_failed", (e as Error).message);
      }
    },
  );

  const assertTextTool = tool(
    "browser_assert_text",
    "Assert that the element matching the CSS selector contains the given substring. Returns { ok: true } if found, { ok: false, error_code: 'assert_text_miss', ... } if not.",
    { selector: z.string().min(1), expected: z.string().min(1) },
    async (args) => {
      try {
        const r = await runBrowserOp(ctx, {
          op: "assert_text",
          selector: args.selector,
          expected: args.expected,
        });
        return unwrapDaemonResult(r);
      } catch (e) {
        return errorResult("assert_text_failed", (e as Error).message);
      }
    },
  );

  const assertUrlTool = tool(
    "browser_assert_url",
    "Assert that the current page URL matches the given pattern. Pattern is treated as regex if it looks regex-y (starts with ^, ends with $, or contains \\); otherwise treated as a substring match.",
    { expected: z.string().min(1) },
    async (args) => {
      try {
        const r = await runBrowserOp(ctx, { op: "assert_url", expected: args.expected });
        return unwrapDaemonResult(r);
      } catch (e) {
        return errorResult("assert_url_failed", (e as Error).message);
      }
    },
  );

  const screenshotTool = tool(
    "browser_screenshot",
    "Save a full-page PNG screenshot. Defaults to /home/user/qa-shots/auto/<ts>.png if path omitted. Returns { ok: true, result: { path } }.",
    { path: z.string().optional() },
    async (args) => {
      try {
        const r = await runBrowserOp(ctx, { op: "screenshot", path: args.path });
        if (r.ok && r.result && typeof r.result === "object") {
          const res = r.result as {
            image_base64?: string;
            image_mime?: string;
            path?: string;
          };
          const b64 = res.image_base64;
          if (b64) {
            delete res.image_base64;
            delete res.image_mime;
            try {
              const screenshotEvidenceOn =
                isAutoExecuteBrowserAgent(ctx.agent_slug) ||
                (await getBoolSetting(
                  "screenshot_artifact_render_enabled",
                  ctx.tenant_id,
                ));
              if (screenshotEvidenceOn && claimScreenshotArtifactSlot(ctx.run_id)) {
                await persistImageArtifact({
                  tenant_id: ctx.tenant_id,
                  run_id: ctx.run_id,
                  bytes: Buffer.from(b64, "base64"),
                  filename: `screenshot-${Date.now()}.png`,
                  mime: "image/png",
                });
              }
            } catch (e) {
              console.warn(
                `[browser_screenshot] artifact persist soft-failed: ${(e as Error).message}`,
              );
            }
          }
        }
        return unwrapDaemonResult(r);
      } catch (e) {
        return errorResult("screenshot_failed", (e as Error).message);
      }
    },
  );

  const waitForTool = tool(
    "browser_wait_for",
    `Wait for an element matching the CSS selector to appear. Times out after timeout_ms (default 5000, max ${WAIT_FOR_MAX_MS}). Returns { ok: true } on appearance.`,
    {
      selector: z.string().min(1),
      timeout_ms: z.number().int().positive().max(WAIT_FOR_MAX_MS).optional(),
    },
    async (args) => {
      try {
        const r = await runBrowserOp(ctx, {
          op: "wait_for",
          selector: args.selector,
          timeout_ms: args.timeout_ms,
        });
        return unwrapDaemonResult(r);
      } catch (e) {
        return errorResult("wait_for_failed", (e as Error).message);
      }
    },
  );

  const allTools = [
    navTool,
    clickTool,
    fillTool,
    textTool,
    assertTextTool,
    assertUrlTool,
    screenshotTool,
    waitForTool,
  ];

  const declared = ctx.declared_tools;
  const WRITE_TOOLS: ReadonlySet<string> = new Set(["browser_click", "browser_fill"]);
  const toolsToRegister = (() => {
    let filtered = declared
      ? allTools.filter((_, i) => declared.includes(ALL_BROWSER_TOOL_NAMES[i]))
      : allTools;
    if (ctx.read_only) {
      filtered = filtered.filter((_, i) => !WRITE_TOOLS.has(ALL_BROWSER_TOOL_NAMES[i]));
    }
    return filtered;
  })();

  return createSdkMcpServer({
    name: "praxis-browser",
    version: "0.1.0",
    tools: toolsToRegister,
  });
}
