import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

vi.mock("express-rate-limit", () => ({ default: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("@/services/auth/oauth/verifier", () => ({
  verifyAccessToken: vi.fn().mockResolvedValue({}),
  authInfoToCaller: () => ({ user_id: "test-user", tenant_id: "test-tenant", credential_kind: "pat", pat_id: "test-pat", oauth_access_token_id: null, scopes: ["read", "run"] }),
  TenantDisabledTokenError: class extends Error {},
}));
vi.mock("@/services/auth/oauth/tokens", () => ({ MCP_RESOURCE: "https://api.example.test/mcp" }));
vi.mock("@/services/mcp/server/zavi-inbound", () => ({ ZAVI_INBOUND_TOOL_LIST: [], handleZaviTool: vi.fn() }));
vi.mock("@/services/mcp/server/audit", () => ({ recordMcpCall: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

import { mcpPost, mcpGet } from "../index";
import { handleZaviTool } from "@/services/mcp/server/zavi-inbound";
import { recordMcpCall } from "@/services/mcp/server/audit";
let http: Server | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close(); client = undefined;
  if (http) {
    const instance = http; http = undefined;
    await new Promise<void>((resolve, reject) => {
      instance.close(error => error ? reject(error) : resolve());
      instance.closeAllConnections();
    });
  }
});

describe("Z-268 over real Streamable HTTP", () => {
  it("delivers a final answer on one tool call across an idle timeout when progress resets it", async () => {
    const answer = { content: [{ type: "text" as const, text: "synthetic final answer" }] };
    vi.mocked(handleZaviTool).mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 12_000)); return answer;
    });
    const app = express(); app.use(express.json());
    app.post("/mcp", (req, res, next) => { void mcpPost(req, res).catch(next); });
    app.get("/mcp", (req, res, next) => { void mcpGet(req, res).catch(next); });
    http = await new Promise<Server>((resolve, reject) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
      instance.on("error", reject);
    });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`));
    client = new Client({ name: "local-http-proof", version: "1" });
    await client.connect(transport);
    const progress = vi.fn();
    const result = await client.callTool({ name: "zavi_ask", arguments: { message: "test question" } }, undefined, {
      timeout: 11_000, maxTotalTimeout: 20_000, resetTimeoutOnProgress: true, onprogress: progress,
    });
    expect(result).toEqual(answer);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls[0][0].progress).toBeGreaterThanOrEqual(10);
    expect(handleZaviTool).toHaveBeenCalledOnce();
    expect(vi.mocked(handleZaviTool).mock.calls[0][0]).toBe("zavi_ask");
    expect(recordMcpCall).toHaveBeenCalledOnce();
  }, 25_000);
});
