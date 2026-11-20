import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../daemon-client", () => ({
  callDaemon: vi.fn(),
  ensureDaemonRunning: vi.fn(),
  _resetDaemonReadyCache: vi.fn(),
}));
vi.mock("@/services/sandbox/lifecycle", () => ({
  getSandboxIdForRun: vi.fn(async () => "sandbox-abc"),
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async () => false),
}));
vi.mock("@/services/sandbox/tool-registry", () => ({
  persistImageArtifact: vi.fn(async () => ({ artifact_id: "art-1" })),
}));

type CapturedTool = { name: string; handler: (a: unknown) => Promise<unknown> };
const capturedTools: CapturedTool[] = [];
let capturedServer: { tools: CapturedTool[] } | null = null;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _d: string, _s: unknown, handler: (a: unknown) => Promise<unknown>) => {
    const t = { name, handler };
    capturedTools.push(t);
    return t;
  },
  createSdkMcpServer: (args: { tools: CapturedTool[] }) => {
    capturedServer = args as { tools: CapturedTool[] };
    return { _captured: true } as unknown;
  },
}));

import { mcpBrowser } from "../server";
import { callDaemon } from "../daemon-client";
import { _resetRunEngineCache, claimScreenshotArtifactSlot } from "../backend";
import { _setBrowserActionEmitter } from "../anchor-backend";
import { getBoolSetting } from "@/services/settings";
import { persistImageArtifact } from "@/services/sandbox/tool-registry";

const ctx = { tenant_id: "tnt-1", run_id: "run-1", agent_slug: "qa", repo_full_name: "rravi149/praxis" };
const B64 = Buffer.from("fake-png-bytes").toString("base64");

async function screenshotHandler() {
  await mcpBrowser(ctx);
  return capturedServer!.tools.find((t) => t.name === "browser_screenshot")!.handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedTools.length = 0;
  capturedServer = null;
  _resetRunEngineCache();
  _setBrowserActionEmitter({ emit: vi.fn(async () => "decision-fake") });
  (getBoolSetting as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  (callDaemon as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    result: { path: "/home/user/qa-shots/x.png", image_base64: B64, image_mime: "image/png" },
  });
});

describe("browser_screenshot → chat artifact", () => {
  it("flag OFF: does NOT persist an artifact, but STILL strips base64 from the model result", async () => {
    (getBoolSetting as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const handler = await screenshotHandler();
    const r = (await handler({})) as { content: Array<{ text: string }> };
    expect(persistImageArtifact).not.toHaveBeenCalled();
    expect(r.content[0].text).toContain("/home/user/qa-shots/x.png");
    expect(r.content[0].text).not.toContain(B64);
    expect(r.content[0].text).not.toContain("image_base64");
  });

  it("flag ON: persists the PNG as an artifact + strips base64 from the model result", async () => {
    (getBoolSetting as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const handler = await screenshotHandler();
    const r = (await handler({})) as { content: Array<{ text: string }> };
    expect(persistImageArtifact).toHaveBeenCalledTimes(1);
    const arg = (persistImageArtifact as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.tenant_id).toBe("tnt-1");
    expect(arg.run_id).toBe("run-1");
    expect(arg.mime).toBe("image/png");
    expect(Buffer.isBuffer(arg.bytes)).toBe(true);
    expect(r.content[0].text).not.toContain(B64);
  });

  it("never breaks the screenshot op if persist throws (soft-fail)", async () => {
    (getBoolSetting as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (persistImageArtifact as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const handler = await screenshotHandler();
    const r = (await handler({})) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("/home/user/qa-shots/x.png");
  });
});

describe("claimScreenshotArtifactSlot — per-run cap N=5", () => {
  it("allows 5 then refuses the 6th for the same run", () => {
    _resetRunEngineCache();
    const results = Array.from({ length: 6 }, () => claimScreenshotArtifactSlot("run-cap"));
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it("is per-run — a different run gets its own budget", () => {
    _resetRunEngineCache();
    for (let i = 0; i < 5; i++) claimScreenshotArtifactSlot("run-A");
    expect(claimScreenshotArtifactSlot("run-A")).toBe(false);
    expect(claimScreenshotArtifactSlot("run-B")).toBe(true);
  });
});
