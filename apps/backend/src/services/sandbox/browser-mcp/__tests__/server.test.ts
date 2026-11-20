import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../daemon-client", () => ({
  callDaemon: vi.fn(),
  ensureDaemonRunning: vi.fn(),
  _resetDaemonReadyCache: vi.fn(),
}));
vi.mock("@/services/sandbox/lifecycle", () => ({
  getSandboxIdForRun: vi.fn(async () => "sandbox-abc"),
}));

type CapturedTool = {
  name: string;
  description: string;
  schema: unknown;
  handler: (a: unknown) => Promise<unknown>;
};
const capturedTools: CapturedTool[] = [];
let capturedServer: {
  name: string;
  version: string;
  tools: CapturedTool[];
} | null = null;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (a: unknown) => Promise<unknown>,
  ) => {
    const t = { name, description, schema, handler };
    capturedTools.push(t);
    return t;
  },
  createSdkMcpServer: (args: {
    name: string;
    version: string;
    tools: CapturedTool[];
  }) => {
    capturedServer = args;
    return { _captured: true } as unknown;
  },
}));

import { mcpBrowser } from "../server";
import { ALL_BROWSER_TOOL_NAMES } from "../types";
import { callDaemon } from "../daemon-client";
import { _resetRunEngineCache } from "../backend";
import { _setBrowserActionEmitter } from "../anchor-backend";

const ctx = {
  tenant_id: "tnt-1",
  run_id: "run-1",
  agent_slug: "qa",
  repo_full_name: "rravi149/praxis",
};

beforeEach(() => {
  vi.clearAllMocks();
  capturedTools.length = 0;
  capturedServer = null;
  _resetRunEngineCache();
  _setBrowserActionEmitter({ emit: vi.fn(async () => "decision-fake") });
});

afterEach(() => {
  _setBrowserActionEmitter(null);
});

describe("mcpBrowser — registration", () => {
  it("registers all 8 tools when declared_tools is omitted", async () => {
    await mcpBrowser(ctx);
    expect(capturedServer).not.toBeNull();
    expect(capturedServer!.name).toBe("praxis-browser");
    const names = capturedServer!.tools.map((t) => t.name).sort();
    expect(names).toEqual([...ALL_BROWSER_TOOL_NAMES].sort());
  });

  it("registers only declared tools when declared_tools is provided", async () => {
    await mcpBrowser({ ...ctx, declared_tools: ["browser_nav", "browser_click"] });
    const names = capturedServer!.tools.map((t) => t.name).sort();
    expect(names).toEqual(["browser_click", "browser_nav"]);
  });
});

describe("mcpBrowser — tool delegation", () => {
  it("browser_nav delegates to callDaemon with op=nav + url", async () => {
    (callDaemon as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    await mcpBrowser(ctx);
    const navHandler = capturedServer!.tools.find((t) => t.name === "browser_nav")!.handler;
    await navHandler({ url: "https://example.com" });
    expect(callDaemon).toHaveBeenCalledWith("sandbox-abc", {
      op: "nav",
      url: "https://example.com",
    });
  });

  it("browser_fill (write) is gated by runBrowserOp and never reaches callDaemon", async () => {
    await mcpBrowser(ctx);
    const handler = capturedServer!.tools.find((t) => t.name === "browser_fill")!.handler;
    const result = (await handler({ selector: "#email", value: "test@example.com" })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error_code).toBe("browser_write_sandbox_unsupported");
    expect(callDaemon).not.toHaveBeenCalled();
  });

  it("propagates ok=false from daemon as isError result", async () => {
    (callDaemon as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error_code: "assert_text_miss",
      error_message: 'expected substring "Welcome" not in "Login"',
    });
    await mcpBrowser(ctx);
    const handler = capturedServer!.tools.find((t) => t.name === "browser_assert_text")!.handler;
    const result = (await handler({ selector: "h1", expected: "Welcome" })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error_code).toBe("assert_text_miss");
  });
});

describe("daemon.js — react-controlled native-setter source guard", () => {
  const daemonSrc = readFileSync(join(__dirname, "..", "daemon.js"), "utf8");

  it("contains the HTMLInputElement.prototype value-setter trick", () => {
    expect(daemonSrc).toMatch(/HTMLInputElement\.prototype/);
    expect(daemonSrc).toMatch(/getOwnPropertyDescriptor[^}]+"value"[^}]+\.set/s);
  });

  it("dispatches both input and change events after the native setter", () => {
    expect(daemonSrc).toMatch(/dispatchEvent\(new Event\("input"/);
    expect(daemonSrc).toMatch(/dispatchEvent\(new Event\("change"/);
  });
});
