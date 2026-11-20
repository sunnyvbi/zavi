import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: vi.fn(async (_id: string, cmd: string) => ({ stdout: "", stderr: "", exit_code: cmd.startsWith("test ") ? 1 : 0, ms: 1 })),
  readFile: vi.fn(async () => ""),
  readFileBytes: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => undefined),
  writeFileBytes: vi.fn(async () => undefined),
}));
vi.mock("@/services/sandbox/lifecycle", () => ({ getSandboxIdForRun: vi.fn(async () => "sbx-1") }));
vi.mock("@/services/media-router/router", () => ({
  isTaskConfigured: vi.fn(async () => false),
  isTaskConfiguredWithFallback: vi.fn(async () => false),
  isMediaRouterEnabled: vi.fn(async () => false),
  generateMedia: vi.fn(),
  generateMediaWithFallback: vi.fn(),
  routeImage: vi.fn(),
  downloadMedia: vi.fn(),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import { mcpSandbox } from "@/services/agents/sdk/mcp-sandbox";

type Registered = Record<
  string,
  { _meta?: Record<string, unknown>; handler: (a: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }
>;
const tools = (s: unknown) => (s as { instance: { _registeredTools: Registered } }).instance._registeredTools;

describe("mcpSandbox site_images", () => {
  it("registers add_site_images, always loaded, outside the declared tool list", async () => {
    const server = await mcpSandbox({ tenant_id: "t", run_id: "r-img", repo_full_name: "x/site", declared_tools: ["view", "create"], site_images: true });
    const t = tools(server);
    expect(Object.keys(t).sort()).toEqual(["add_site_images", "create", "view"]);
    expect(t.add_site_images._meta?.["anthropic/alwaysLoad"]).toBe(true);
  });

  it("is absent on every other run", async () => {
    const server = await mcpSandbox({ tenant_id: "t", run_id: "r-plain", repo_full_name: "x/app" });
    expect(tools(server).add_site_images).toBeUndefined();
  });

  it("reports a skipped image as a normal result with a note, never an error or a throw (the build continues without photos)", async () => {
    const server = await mcpSandbox({ tenant_id: "t", run_id: "r-down", repo_full_name: "x/site", site_images: true });
    const r = await tools(server).add_site_images.handler({
      images: [{ slug: "hero", prompt: "a calm yoga studio at dawn", alt: "the studio", aspect: "16:9" }],
    });
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0].text);
    expect(out).toMatchObject({ images: [], skipped: [{ slug: "hero", reason: "not_configured" }] });
    expect(out.note).toMatch(/Do not call this tool again/);
  });
});
