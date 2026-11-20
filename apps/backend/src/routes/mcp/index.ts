
import type { Request, Response } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import rateLimit from "express-rate-limit";
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { TENANT_DISABLED_CODE } from "@/services/tenants/disabled";
import {
  TenantDisabledTokenError,
  verifyAccessToken,
  authInfoToCaller,
  type McpCaller,
} from "@/services/auth/oauth/verifier";
import { MCP_RESOURCE } from "@/services/auth/oauth/tokens";
import {
  ZAVI_INBOUND_TOOL_LIST,
  handleZaviTool,
} from "@/services/mcp/server/zavi-inbound";
import { recordMcpCall } from "@/services/mcp/server/audit";
import { logEvent } from "@/services/logging/logEvent";
import { startMcpProgress } from "@/services/mcp/server/request-progress";

const ALLOWED_ORIGINS = [
  "https://claude.ai",
  "https://chatgpt.com",
  "https://www.zaviagent.com",
  "https://api.zaviagent.com",
];

const RESOURCE_METADATA_URL = getOAuthProtectedResourceMetadataUrl(new URL(MCP_RESOURCE));
const WWW_AUTH = `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`;

const IP_SALT = process.env.MCP_IP_HASH_SALT ?? "praxis-mcp-ip";
function ipHash(ip: string): string {
  return createHash("sha256").update(IP_SALT).update(ip).digest("hex");
}

const failWindow = new Map<string, { n: number; resetAt: number }>();
function noteAuthFailure(ipH: string): boolean {
  const now = Date.now();
  const cur = failWindow.get(ipH);
  if (!cur || cur.resetAt < now) {
    failWindow.set(ipH, { n: 1, resetAt: now + 60_000 });
    return false;
  }
  cur.n += 1;
  return cur.n > 10;
}

const patLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const c = (req as { mcpCaller?: McpCaller }).mcpCaller;
    return c?.pat_id ?? c?.oauth_access_token_id ?? req.ip ?? "unknown";
  },
  handler: (_req, res) =>
    res.status(429).json({ error: { code: "rate_limited", message: "60 req/min exceeded" } }),
});

const runAgentCounts = new Map<string, { n: number; resetAt: number }>();
function runAgentAllowed(tenantId: string): boolean {
  const now = Date.now();
  const cur = runAgentCounts.get(tenantId);
  if (!cur || cur.resetAt < now) {
    runAgentCounts.set(tenantId, { n: 1, resetAt: now + 60_000 });
    return true;
  }
  if (cur.n >= 10) return false;
  cur.n += 1;
  return true;
}

async function authenticate(req: Request, res: Response): Promise<McpCaller | null> {
  const origin = req.get("origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    res.status(403).json({ error: { code: "bad_origin", message: "Origin not allowed" } });
    return null;
  }
  const ipH = ipHash(req.ip ?? "unknown");
  const hdr = req.get("authorization") ?? "";
  const raw = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  try {
    const authInfo = await verifyAccessToken(raw);
    const caller = authInfoToCaller(authInfo);
    (req as { mcpCaller?: McpCaller }).mcpCaller = caller;
    return caller;
  } catch (e) {
    if (e instanceof TenantDisabledTokenError) {
      res.status(403).json({ error: { code: TENANT_DISABLED_CODE, message: e.message } });
      return null;
    }
    if (e instanceof ServerError) {
      res.status(503).json({ error: { code: "auth_unavailable", message: "try again shortly" } });
      return null;
    }
    const blocked = noteAuthFailure(ipH);
    res.setHeader("WWW-Authenticate", WWW_AUTH);
    res.status(blocked ? 429 : 401).json({
      error: {
        code: blocked ? "rate_limited" : "unauthorized",
        message: blocked ? "too many failed auth attempts" : "invalid or missing token",
      },
    });
    return null;
  }
}

export function buildServer(caller: McpCaller, ip?: string, origin?: string): Server {
  const server = new Server(
    { name: "zavi", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...ZAVI_INBOUND_TOOL_LIST],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (reqMsg, extra) => {
    const name = reqMsg.params.name;
    const args = reqMsg.params.arguments;
    if (
      (name === "zavi_run_agent" || name === "praxis_run_agent") &&
      !runAgentAllowed(caller.tenant_id)
    ) {
      await recordMcpCall(caller, name, args, 0, "rate_limited", ip);
      return {
        content: [{ type: "text", text: '{"error":"10 run_agent/min/tenant exceeded"}' }],
        isError: true,
      };
    }
    if (name === "zavi_ask" || name === "praxis_ask") {
      const token = reqMsg.params._meta?.progressToken;
      const present = typeof token === "string" || typeof token === "number";
      const stage = origin === "https://chatgpt.com" ? "chatgpt_origin"
        : origin === "https://claude.ai" ? "claude_origin"
        : origin === "https://www.zaviagent.com" || origin === "https://api.zaviagent.com"
          ? "zavi_origin" : "unknown_origin";
      void logEvent({
        level: "info", source: "mcp-progress",
        code: present ? "mcp.progress_token.present" : "mcp.progress_token.absent",
        tenant_id: caller.tenant_id, meta: { tool_name: "zavi_ask", stage },
      });
    }
    const stopProgress = name === "zavi_ask" || name === "praxis_ask"
      ? startMcpProgress(reqMsg.params._meta?.progressToken, extra)
      : () => {};
    try {
      const t0 = Date.now();
      const out = await handleZaviTool(name, args, caller);
      const code = !out.isError
        ? "ok"
        : /scope_denied/.test(out.content[0]?.text ?? "")
          ? "scope_denied"
          : "error";
      await recordMcpCall(caller, name, args, Date.now() - t0, code, ip);
      return out;
    } finally {
      stopProgress();
    }
  });
  return server;
}

export async function mcpPost(req: Request, res: Response): Promise<void> {
  const caller = await authenticate(req, res);
  if (!caller) return;
  patLimiter(req, res, async () => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = buildServer(caller, req.ip, req.get("origin"));
    res.once("close", () => { void server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      req.body,
    );
  });
}

export async function mcpGet(req: Request, res: Response): Promise<void> {
  const caller = await authenticate(req, res);
  if (!caller) return;
  res
    .status(405)
    .json({ error: { code: "method_not_allowed", message: "GET stream not offered" } });
}
