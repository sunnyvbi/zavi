import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpCaller } from "@/services/auth/oauth/verifier";

vi.mock("express-rate-limit", () => ({ default: vi.fn(() => vi.fn()) }));
vi.mock("@/services/auth/oauth/verifier", () => ({
  verifyAccessToken: vi.fn(), authInfoToCaller: vi.fn(),
  TenantDisabledTokenError: class extends Error {},
}));
vi.mock("@/services/auth/oauth/tokens", () => ({ MCP_RESOURCE: "https://api.example.test/mcp" }));
vi.mock("@/services/mcp/server/zavi-inbound", () => ({
  ZAVI_INBOUND_TOOL_LIST: [], handleZaviTool: vi.fn(),
}));
vi.mock("@/services/mcp/server/audit", () => ({ recordMcpCall: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import { buildServer } from "../index";
import { handleZaviTool } from "@/services/mcp/server/zavi-inbound";
import { recordMcpCall } from "@/services/mcp/server/audit";
import { logEvent } from "@/services/logging/logEvent";

const actor = {
  user_id: "test-user", tenant_id: "test-tenant", credential_kind: "pat",
  pat_id: "test-pat", oauth_access_token_id: null, scopes: ["read", "run"],
} as McpCaller;
const answer = { content: [{ type: "text" as const, text: '{"answer":"ready"}' }] };
const clients: Client[] = [];
const servers: Server[] = [];
async function connect(origin?: string) {
  const server = buildServer(actor, undefined, origin);
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  clients.push(client); servers.push(server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(logEvent).mockResolvedValue(undefined);
  vi.mocked(recordMcpCall).mockResolvedValue(undefined);
  vi.mocked(handleZaviTool).mockResolvedValue(answer);
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...clients.splice(0), ...servers.splice(0)].map(x => x.close()));
});

describe("MCP progress capability observation", () => {
  it.each(["private-progress-token", 0, ""])("records presence without storing token %j", async token => {
    const client = await connect("https://chatgpt.com");
    const args = { message: "private question" };
    expect(await client.callTool({ name: "zavi_ask", arguments: args, _meta: { progressToken: token } })).toEqual(answer);
    expect(logEvent).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith({
      level: "info", source: "mcp-progress", code: "mcp.progress_token.present",
      tenant_id: actor.tenant_id, meta: { tool_name: "zavi_ask", stage: "chatgpt_origin" },
    });
    expect(handleZaviTool).toHaveBeenCalledWith("zavi_ask", args, actor);
    expect(recordMcpCall).toHaveBeenCalledWith(actor, "zavi_ask", args, expect.any(Number), "ok", undefined);
  });

  it.each([
    ["https://claude.ai", "claude_origin"],
    [undefined, "unknown_origin"],
    ["https://private.example/account?secret=private", "unknown_origin"],
    ["https://www.zaviagent.com", "zavi_origin"],
  ])("records absent token and bounded origin hint for %s", async (origin, stage) => {
    const client = await connect(origin);
    await client.callTool({ name: "praxis_ask", arguments: {} });
    expect(logEvent).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith({
      level: "info", source: "mcp-progress", code: "mcp.progress_token.absent",
      tenant_id: actor.tenant_id, meta: { tool_name: "zavi_ask", stage },
    });
  });

  it("does not add telemetry for status polls or other tools", async () => {
    const client = await connect();
    await client.callTool({ name: "zavi_get_run_status", arguments: { run_id: "run" } });
    await client.callTool({ name: "zavi_read_brain", arguments: {} });
    expect(logEvent).not.toHaveBeenCalled();
    expect(recordMcpCall).toHaveBeenCalledTimes(2);
  });

  it("does not wait for diagnostic storage before returning the answer", async () => {
    vi.mocked(logEvent).mockImplementation(() => new Promise(() => {}));
    const client = await connect();
    expect(await client.callTool({ name: "zavi_ask", arguments: {} }, undefined, { timeout: 500 })).toEqual(answer);
    expect(logEvent).toHaveBeenCalledOnce();
    expect(recordMcpCall).toHaveBeenCalledOnce();
  });

  it("preserves tool errors and their mandatory audit", async () => {
    const denied = { content: [{ type: "text" as const, text: "scope_denied" }], isError: true };
    vi.mocked(handleZaviTool).mockResolvedValue(denied);
    const client = await connect();
    expect(await client.callTool({ name: "zavi_ask", arguments: {} })).toEqual(denied);
    expect(recordMcpCall).toHaveBeenCalledWith(actor, "zavi_ask", {}, expect.any(Number), "scope_denied", undefined);
  });
});


describe("MCP request progress delivery", () => {
  it.each(["zavi_ask", "praxis_ask"])("%s returns a slow answer in one call when the client resets its idle timeout", async name => {
    vi.useFakeTimers();
    vi.mocked(handleZaviTool).mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 35_000));
      return answer;
    });
    const client = await connect();
    const progress = vi.fn();
    const result = client.callTool({ name, arguments: { message: "growth question" } }, undefined, {
      onprogress: progress, timeout: 15_000, resetTimeoutOnProgress: true, maxTotalTimeout: 50_000,
    }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    await vi.advanceTimersByTimeAsync(36_000);
    const actual = await result;
    expect(actual.error).toBeNull();
    expect(actual.value).toEqual(answer);
    expect(progress.mock.calls.map(([p]) => p.progress)).toEqual([10, 20, 30]);
    expect(progress.mock.calls.every(([p]) => p.total === undefined && p.message === undefined)).toBe(true);
    expect(handleZaviTool).toHaveBeenCalledOnce();
    expect(handleZaviTool).toHaveBeenCalledWith(name, { message: "growth question" }, actor);
    expect(recordMcpCall).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(progress).toHaveBeenCalledTimes(3);
  });

  it("does not bypass a client's absolute timeout or enqueue a retry", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    vi.mocked(handleZaviTool).mockImplementation(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return answer;
    });
    const client = await connect();
    const progress = vi.fn();
    const result = client.callTool({ name: "zavi_ask", arguments: {} }, undefined, {
      onprogress: progress, timeout: 15_000, resetTimeoutOnProgress: true, maxTotalTimeout: 25_000,
    }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    await vi.advanceTimersByTimeAsync(31_000);
    expect((await result).error).toBeInstanceOf(Error);
    expect(progress).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(progress).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(handleZaviTool).toHaveBeenCalledOnce();
    expect(recordMcpCall).toHaveBeenCalledOnce();
  });
});


describe("progress leaves existing tool behavior intact", () => {
  it.each(["zavi_get_run_status", "zavi_read_brain"])("does not send progress for %s", async name => {
    vi.useFakeTimers();
    vi.mocked(handleZaviTool).mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 12_000)); return answer;
    });
    const client = await connect(); const progress = vi.fn();
    const result = client.callTool({ name, arguments: {} }, undefined, { onprogress: progress });
    await vi.advanceTimersByTimeAsync(13_000);
    expect(await result).toEqual(answer);
    expect(progress).not.toHaveBeenCalled();
  });

  it("stops reporting on a thrown handler error", async () => {
    vi.useFakeTimers();
    vi.mocked(handleZaviTool).mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 12_000)); throw new Error("unavailable");
    });
    const client = await connect(); const progress = vi.fn();
    const result = client.callTool({ name: "zavi_ask", arguments: {} }, undefined, { onprogress: progress })
      .then(() => null, error => error);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(await result).toBeInstanceOf(Error);
    expect(progress).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(progress).toHaveBeenCalledOnce();
  });

  it("keeps concurrent progress tokens on their own requests", async () => {
    vi.useFakeTimers();
    vi.mocked(handleZaviTool).mockImplementation(async (_name, args) => {
      await new Promise(resolve => setTimeout(resolve, (args as { delay: number }).delay)); return answer;
    });
    const client = await connect(); const short = vi.fn(); const long = vi.fn();
    const a = client.callTool({ name: "zavi_ask", arguments: { delay: 12_000 } }, undefined, { onprogress: short });
    const b = client.callTool({ name: "zavi_ask", arguments: { delay: 22_000 } }, undefined, { onprogress: long });
    await vi.advanceTimersByTimeAsync(23_000);
    expect(await a).toEqual(answer); expect(await b).toEqual(answer);
    expect(short.mock.calls.map(([p]) => p.progress)).toEqual([10]);
    expect(long.mock.calls.map(([p]) => p.progress)).toEqual([10, 20]);
    expect(recordMcpCall).toHaveBeenCalledTimes(2);
  });
});
