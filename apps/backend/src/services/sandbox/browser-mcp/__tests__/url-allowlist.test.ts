
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  createSdkMcpServer: (cfg: unknown) => cfg,
}));

import { mcpBrowser } from "../server";
import { callDaemon } from "../daemon-client";

function getNavHandler(): CapturedTool {
  const t = capturedTools.find((c) => c.name === "browser_nav");
  if (!t) throw new Error("browser_nav not registered");
  return t;
}

beforeEach(() => {
  capturedTools.length = 0;
  (callDaemon as ReturnType<typeof vi.fn>).mockReset();
});

describe("browser_nav origin allowlist", () => {
  it("blocks mismatched origin without calling the daemon", async () => {
    await mcpBrowser({
      tenant_id: "t",
      run_id: "r",
      agent_slug: "qa",
      repo_full_name: "x/y",
      staging_origin: "https://staging.example.com",
    });
    const nav = getNavHandler();
    const r = (await nav.handler({ url: "https://prod.example.com/x" })) as {
      content: { text: string }[];
    };
    const body = JSON.parse(r.content[0].text);
    expect(body.error_code).toBe("url_outside_allowlist");
    expect(callDaemon).not.toHaveBeenCalled();
  });

  it("allows same origin (and reaches the daemon)", async () => {
    (callDaemon as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
    });
    await mcpBrowser({
      tenant_id: "t",
      run_id: "r",
      agent_slug: "qa",
      repo_full_name: "x/y",
      staging_origin: "https://staging.example.com",
    });
    const nav = getNavHandler();
    await nav.handler({ url: "https://staging.example.com/login" });
    expect(callDaemon).toHaveBeenCalled();
  });

  it("passes through when staging_origin is undefined (Modes A+C / legacy callers)", async () => {
    (callDaemon as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
    });
    await mcpBrowser({
      tenant_id: "t",
      run_id: "r",
      agent_slug: "qa",
      repo_full_name: "x/y",
    });
    const nav = getNavHandler();
    await nav.handler({ url: "https://anywhere.example.com" });
    expect(callDaemon).toHaveBeenCalled();
  });
});
