
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((opts: { tools: unknown[] }) => ({
    _registeredTools: opts.tools,
  })),
  tool: vi.fn(
    (name: string, _desc: string, _schema: unknown, _handler: unknown) => ({
      _name: name,
    }),
  ),
}));

vi.mock("../backend", () => ({
  runBrowserOp: vi.fn(async () => ({ ok: true })),
  _resetRunEngineCache: vi.fn(),
  _clearRunBrowserState: vi.fn(),
}));

import { mcpBrowser } from "../server";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

describe("P1-c: server.ts mcpBrowser tool registration with read_only", () => {
  beforeEach(() => {
    (createSdkMcpServer as ReturnType<typeof vi.fn>).mockClear();
  });

  it("read_only=true: browser_click + browser_fill are excluded from registered tools", async () => {
    await mcpBrowser({
      tenant_id: "t-qa",
      run_id: "r-srv",
      agent_slug: "browser-operator",
      repo_full_name: "",
      declared_tools: [
        "browser_nav",
        "browser_click",
        "browser_fill",
        "browser_text",
        "browser_screenshot",
      ],
      read_only: true,
    });

    const callArgs = (createSdkMcpServer as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      tools: Array<{ _name: string }>;
    };
    const registeredNames = callArgs.tools.map((t) => t._name);

    expect(registeredNames).toContain("browser_nav");
    expect(registeredNames).toContain("browser_text");
    expect(registeredNames).toContain("browser_screenshot");
    expect(registeredNames).not.toContain("browser_click");
    expect(registeredNames).not.toContain("browser_fill");
  });

  it("read_only=false: all declared tools are registered (write tools present)", async () => {
    await mcpBrowser({
      tenant_id: "t-qa",
      run_id: "r-srv-norm",
      agent_slug: "browser-operator",
      repo_full_name: "",
      declared_tools: ["browser_nav", "browser_click", "browser_fill", "browser_text"],
      read_only: false,
    });

    const callArgs = (createSdkMcpServer as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      tools: Array<{ _name: string }>;
    };
    const registeredNames = callArgs.tools.map((t) => t._name);

    expect(registeredNames).toContain("browser_click");
    expect(registeredNames).toContain("browser_fill");
    expect(registeredNames).toContain("browser_nav");
    expect(registeredNames).toContain("browser_text");
  });

  it("read_only=true with no declared_tools: all 8 tools minus click/fill = 6 tools registered", async () => {
    await mcpBrowser({
      tenant_id: "t-qa",
      run_id: "r-srv-nodecl",
      agent_slug: "browser-operator",
      repo_full_name: "",
      read_only: true,
    });

    const callArgs = (createSdkMcpServer as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      tools: Array<{ _name: string }>;
    };
    const registeredNames = callArgs.tools.map((t) => t._name);

    expect(registeredNames).toHaveLength(6);
    expect(registeredNames).not.toContain("browser_click");
    expect(registeredNames).not.toContain("browser_fill");
  });
});
