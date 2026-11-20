import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: vi.fn(async () => ({ stdout: "pristine", stderr: "", exit_code: 0, ms: 1 })),
  readFile: vi.fn(async () => ""),
  readFileBytes: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => undefined),
}));
vi.mock("@/services/sandbox/lifecycle", () => ({ getSandboxIdForRun: vi.fn(async () => "sbx-1") }));

import { mcpSandbox } from "@/services/agents/sdk/mcp-sandbox";
import { fastSiteSandboxOptions, FAST_BUILD_ALWAYS_LOAD_TOOLS, FAST_BUILD_REPLACEABLE_STARTER_PATHS } from "@/services/agents/fast-build-prompt";
import { writeFile } from "@/services/sandbox/e2b-client";

type Registered = Record<
  string,
  { _meta?: Record<string, unknown>; handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }
>;
const tools = (s: unknown) => (s as { instance: { _registeredTools: Registered } }).instance._registeredTools;
const alwaysLoaded = (s: unknown) =>
  Object.entries(tools(s))
    .filter(([, t]) => t._meta?.["anthropic/alwaysLoad"] === true)
    .map(([n]) => n)
    .sort();

const SITE_PAYLOAD = {
  stage: "build",
  fast_single_pass: true,
  site_id: "site-1",
  target: { github_full_name: "Praxis-build/shop-1" },
};

describe("fastSiteSandboxOptions", () => {
  it("first pass of a site build: always-load verbs + create may replace a pristine file", () => {
    expect(fastSiteSandboxOptions(SITE_PAYLOAD)).toEqual({
      always_load_tools: FAST_BUILD_ALWAYS_LOAD_TOOLS,
      create_replace_pristine_paths: FAST_BUILD_REPLACEABLE_STARTER_PATHS,
    });
    expect(FAST_BUILD_REPLACEABLE_STARTER_PATHS).toEqual(["src/pages/Home.tsx"]);
  });
  it("a repair/refine pass keeps always-load but create refuses existing files", () => {
    expect(fastSiteSandboxOptions({ ...SITE_PAYLOAD, repair_mode: true })).toEqual({ always_load_tools: FAST_BUILD_ALWAYS_LOAD_TOOLS });
    expect(fastSiteSandboxOptions({ ...SITE_PAYLOAD, refine_mode: true })).toEqual({ always_load_tools: FAST_BUILD_ALWAYS_LOAD_TOOLS });
  });
  it("any other payload gets nothing", () => {
    expect(fastSiteSandboxOptions({ stage: "build", target: { github_full_name: "a/b" } })).toEqual({});
    expect(fastSiteSandboxOptions(null)).toEqual({});
  });
});

describe("mcpSandbox with fast-site options", () => {
  it("marks exactly the listed verbs alwaysLoad and replaces a pristine file on create", async () => {
    const server = await mcpSandbox({
      tenant_id: "t",
      run_id: "r-fast",
      repo_full_name: "Praxis-build/shop-1",
      ...fastSiteSandboxOptions(SITE_PAYLOAD),
    });
    expect(alwaysLoaded(server)).toEqual([...FAST_BUILD_ALWAYS_LOAD_TOOLS].sort());
    const r = await tools(server).create.handler({ path: "src/pages/Home.tsx", file_text: "home" });
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, replaced_unmodified_file: true });
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith("sbx-1", "/home/user/repo/src/pages/Home.tsx", "home");
    vi.mocked(writeFile).mockClear();
    const app = await tools(server).create.handler({ path: "src/App.tsx", file_text: "x" });
    expect(JSON.parse(app.content[0].text).error).toBe("existence_probe_failed");
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it("the create tool tells the model which placeholders it may replace (only on that run)", async () => {
    const fast = await mcpSandbox({ tenant_id: "t", run_id: "r-d1", repo_full_name: "x/y", ...fastSiteSandboxOptions(SITE_PAYLOAD) });
    const plain = await mcpSandbox({ tenant_id: "t", run_id: "r-d2", repo_full_name: "x/y" });
    const desc = (s: unknown) => (tools(s).create as unknown as { description: string }).description;
    expect(desc(fast)).toContain("src/pages/Home.tsx");
    expect(desc(plain)).not.toContain("src/pages/Home.tsx");
  });

  it("a default run loads nothing up front and create never treats a file as replaceable", async () => {
    vi.mocked(writeFile).mockClear();
    const server = await mcpSandbox({ tenant_id: "t", run_id: "r-def", repo_full_name: "acme/app" });
    expect(alwaysLoaded(server)).toEqual([]);
    const r = await tools(server).create.handler({ path: "src/pages/Home.tsx", file_text: "x" });
    expect(JSON.parse(r.content[0].text).error).toBe("existence_probe_failed");
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });
});
