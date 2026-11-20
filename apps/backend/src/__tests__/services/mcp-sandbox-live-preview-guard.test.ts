import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: vi.fn(async () => ({ stdout: "", stderr: "", exit_code: 0, ms: 1 })),
  readFile: vi.fn(async () => ""),
  readFileBytes: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => undefined),
}));
vi.mock("@/services/sandbox/lifecycle", () => ({
  getSandboxIdForRun: vi.fn(async () => "bakery-sandbox"),
}));

import { mcpSandbox, livePreviewRefusal } from "@/services/agents/sdk/mcp-sandbox";
import { execCommand as execCommandRaw } from "@/services/sandbox/e2b-client";

const execMock = vi.mocked(execCommandRaw);

function handler(server: Awaited<ReturnType<typeof mcpSandbox>>, name: string) {
  const t = (server as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> } })
    .instance._registeredTools[name];
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

const text = (r: unknown) => JSON.stringify(r);
const executed = () => execMock.mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  execMock.mockClear();
});

describe("a run whose repo the live preview serves can never build or restart the app in place", () => {
  it("refuses the exact 12:46 Bakery edit command and app_verify call, and nothing reaches the sandbox", async () => {
    const server = await mcpSandbox({ tenant_id: "23aee413", run_id: "r-live", repo_full_name: "Zavi-Latest-Build/bakery-9fd539ad", servesLivePreview: true });
    const build = await handler(server, "run_bash")({ command: "npx next build 2>&1 | tail -30", timeout_seconds: 120 });
    expect(text(build)).toContain("live preview serves");
    const verify = await handler(server, "app_verify")({ request_path: "/biscuits", expect_body_contains: "Biscuits", start_cmd: "npx next start -p 3000" });
    expect(text(verify)).toContain("live preview serves");
    const verifyDefault = await handler(server, "app_verify")({ request_path: "/" });
    expect(text(verifyDefault)).toContain("live preview serves");
    expect(executed().some((c) => /next (build|start)|npm run dev/.test(c))).toBe(false);
  });

  it("still lets the run typecheck, curl the running preview and build a copy under /tmp", async () => {
    const server = await mcpSandbox({ tenant_id: "23aee413", run_id: "r-live2", repo_full_name: "Zavi-Latest-Build/bakery-9fd539ad", servesLivePreview: true });
    const copyBuild =
      "rm -rf /tmp/verify && mkdir -p /tmp/verify && tar -C /home/user/repo --exclude=node_modules --exclude=.next --exclude=.git -cf - . | tar -C /tmp/verify -xf - && ln -s /home/user/repo/node_modules /tmp/verify/node_modules && cd /tmp/verify && npm run build";
    for (const command of [copyBuild, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/biscuits", "npx tsc --noEmit", "git status --short"]) {
      const r = await handler(server, "run_bash")({ command, timeout_seconds: 60 });
      expect(text(r)).not.toContain("live preview serves");
    }
    expect(executed().some((c) => c.includes("cd /tmp/verify && npm run build"))).toBe(true);
  });

  it("a run with no live preview keeps building in place as before", async () => {
    const server = await mcpSandbox({ tenant_id: "t", run_id: "r-plain", repo_full_name: "acme/app" });
    const r = await handler(server, "run_bash")({ command: "npm run build", timeout_seconds: 60 });
    expect(text(r)).not.toContain("live preview serves");
    expect(executed().some((c) => c.includes("npm run build"))).toBe(true);
  });
});

describe("livePreviewRefusal", () => {
  it.each([
    "npm run build",
    "next build",
    "npx next start -p 3000",
    "npm start",
    "yarn dev",
    "pnpm run build",
    "npx vite build",
    "npm install && npm run build",
    "cd /tmp/verify && npm run build && cd /home/user/repo && npm run build",
    "(npm run build)",
  ])("refuses %s", (command) => {
    expect(livePreviewRefusal(command)).not.toBeNull();
  });

  it.each([
    "npm run typecheck",
    "npm run lint",
    "npm install --save-exact zod",
    "cat next.config.js",
    "grep -rn 'next build' README.md",
    "(cd /tmp/verify && npm run build)",
    "ls .next/static",
  ])("allows %s", (command) => {
    expect(livePreviewRefusal(command)).toBeNull();
  });
});

describe("which runs get the guard", async () => {
  const { sandboxServesLivePreview } = await import("@/services/build/first-build-preview");
  const bakeryEdit = {
    idea: "Build a biscuit shop landing page on the existing bakery site.",
    stage: "build",
    refine_mode: true,
    live_edit_branch: "zavi/draft",
    target: { github_target_mode: "umbrella" },
  };

  it("the Bakery chat edit (a live edit) gets it even with previews switched off and the setting unreadable", async () => {
    const safeVerify = vi.fn(async () => {
      throw new Error("settings down");
    });
    expect(await sandboxServesLivePreview(bakeryEdit, safeVerify, () => false)).toBe(true);
  });

  it("a first build's scaffold and build stages get it while the preview serves the repo", async () => {
    expect(await sandboxServesLivePreview({ stage: "build", target: {} }, async () => true, () => true)).toBe(true);
    expect(await sandboxServesLivePreview({ stage: "scaffold", target: {} }, async () => true, () => true)).toBe(true);
  });

  it("a refine with no live preview, a user's own repo, or previews off does not", async () => {
    expect(await sandboxServesLivePreview({ ...bakeryEdit, live_edit_branch: undefined }, async () => true, () => true)).toBe(false);
    expect(await sandboxServesLivePreview({ stage: "build", target: { github_target_mode: "user_repo" } }, async () => true, () => true)).toBe(false);
    expect(await sandboxServesLivePreview({ stage: "build", target: {} }, async () => true, () => false)).toBe(false);
  });
});
