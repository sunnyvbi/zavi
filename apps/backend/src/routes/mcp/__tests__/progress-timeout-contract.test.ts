import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

afterEach(() => { vi.useRealTimers(); });
describe("SDK progress and timeout contract", () => {
  it.each([
    { reset: false, maximum: 1_000, succeeds: false },
    { reset: true, maximum: 1_000, succeeds: true },
    { reset: true, maximum: 250, succeeds: false },
  ])("reset=$reset maximum=$maximum", async ({ reset, maximum, succeeds }) => {
    vi.useFakeTimers();
    const server = new Server({ name: "contract-test", version: "1" }, { capabilities: { tools: {} } });
    const client = new Client({ name: "contract-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    let calls = 0;
    let receivedToken: unknown;
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      calls++;
      receivedToken = request.params._meta?.progressToken;
      let progress = 0;
      const heartbeat = setInterval(() => {
        void extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: receivedToken as number, progress: ++progress },
        }).catch(() => {});
      }, 50);
      try {
        await new Promise(resolve => setTimeout(resolve, 350));
        return { content: [{ type: "text", text: "final answer" }] };
      } finally { clearInterval(heartbeat); }
    });
    try {
      await server.connect(st);
      await client.connect(ct);
      const progress = vi.fn();
      const outcome = client.callTool({ name: "slow_operation", arguments: {} }, undefined, {
        timeout: 200, maxTotalTimeout: maximum, resetTimeoutOnProgress: reset, onprogress: progress,
      }).then(result => ({ result, error: null }), error => ({ result: null, error }));
      await vi.advanceTimersByTimeAsync(400);
      const actual = await outcome;
      expect(calls).toBe(1);
      expect(receivedToken).toBeDefined();
      expect(progress).toHaveBeenCalled();
      if (succeeds) {
        expect(actual.error).toBeNull();
        expect(actual.result?.content).toEqual([{ type: "text", text: "final answer" }]);
      } else {
        expect(actual.result).toBeNull();
        expect(actual.error).toBeInstanceOf(Error);
        expect(actual.error.message).toMatch(/tim(?:eout|ed out)/i);
      }
    } finally {
      await client.close(); await server.close();
    }
  });
});
