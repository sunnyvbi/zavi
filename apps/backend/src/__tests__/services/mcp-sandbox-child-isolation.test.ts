import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: vi.fn(async () => ({ stdout: "", stderr: "", exit_code: 0, ms: 1 })),
  readFile: vi.fn(async () => ""),
  readFileBytes: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => undefined),
}));
vi.mock("@/services/sandbox/lifecycle", () => ({
  getSandboxIdForRun: vi.fn(async () => "shared-sandbox-id"),
}));

import { mcpSandbox, clearSandboxReadCounter } from "@/services/agents/sdk/mcp-sandbox";
import {
  execCommand as execCommandRaw,
  writeFile as writeFileRaw,
} from "@/services/sandbox/e2b-client";

const execMock = vi.mocked(execCommandRaw);
const writeMock = vi.mocked(writeFileRaw);

function getHandler(server: Awaited<ReturnType<typeof mcpSandbox>>, name: string) {
  const registered = (
    server as unknown as {
      instance: {
        _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }>;
      };
    }
  ).instance._registeredTools;
  const t = registered[name];
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

const TENANT = "t-1";
const REPO = "acme/app";
const WT_A = "/home/user/wt-childAAA";
const WT_B = "/home/user/wt-childBBB";

beforeEach(() => {
  execMock.mockClear();
  writeMock.mockClear();
  clearSandboxReadCounter("runA");
  clearSandboxReadCounter("runB");
});

describe("multi-task child worktree isolation (mcpSandbox repo_root)", () => {
  it("each child's write_file lands in ITS OWN worktree, never a sibling's", async () => {
    const childA = await mcpSandbox({ tenant_id: TENANT, run_id: "runA", repo_full_name: REPO, repo_root: WT_A });
    const childB = await mcpSandbox({ tenant_id: TENANT, run_id: "runB", repo_full_name: REPO, repo_root: WT_B });

    await getHandler(childA, "write_file")({ path: "src/a.ts", content: "// a" });
    await getHandler(childB, "write_file")({ path: "src/b.ts", content: "// b" });

    const writtenPaths = writeMock.mock.calls.map((c) => c[1] as string);
    expect(writtenPaths).toContain(`${WT_A}/src/a.ts`);
    expect(writtenPaths).toContain(`${WT_B}/src/b.ts`);
    for (const p of writtenPaths) {
      expect(p.startsWith(`${WT_A}/`) || p.startsWith(`${WT_B}/`)).toBe(true);
      expect(p.startsWith("/home/user/repo/")).toBe(false);
    }
    expect(writtenPaths.filter((p) => p.startsWith(`${WT_A}/`))).toEqual([`${WT_A}/src/a.ts`]);
    expect(writtenPaths.filter((p) => p.startsWith(`${WT_B}/`))).toEqual([`${WT_B}/src/b.ts`]);
  });

  it("each child's run_bash executes cd'd into ITS OWN worktree root", async () => {
    const childA = await mcpSandbox({ tenant_id: TENANT, run_id: "runA", repo_full_name: REPO, repo_root: WT_A });
    const childB = await mcpSandbox({ tenant_id: TENANT, run_id: "runB", repo_full_name: REPO, repo_root: WT_B });

    await getHandler(childA, "run_bash")({ command: "ls", timeout_seconds: 60 });
    await getHandler(childB, "run_bash")({ command: "ls", timeout_seconds: 60 });

    const cmds = execMock.mock.calls.map((c) =>
      (c[1] as string).replace(/^export npm_config_yes=false; /, ""),
    );
    expect(cmds.some((c) => c.startsWith(`cd ${WT_A} &&`))).toBe(true);
    expect(cmds.some((c) => c.startsWith(`cd ${WT_B} &&`))).toBe(true);
    expect(cmds.some((c) => c.startsWith("cd /home/user/repo &&"))).toBe(false);
  });

  it("a child's run_bash CANNOT read or cd into a sibling worktree (escape guard rejects)", async () => {
    const childA = await mcpSandbox({ tenant_id: TENANT, run_id: "runA", repo_full_name: REPO, repo_root: WT_A });

    const abs = (await getHandler(childA, "run_bash")({
      command: `cat ${WT_B}/secret.txt`,
      timeout_seconds: 60,
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(abs.isError).toBe(true);
    expect(abs.content[0].text).toContain("escape_guard");

    const rel = (await getHandler(childA, "run_bash")({
      command: "cd ../wt-childBBB && cat secret.txt",
      timeout_seconds: 60,
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(rel.isError).toBe(true);
    expect(rel.content[0].text).toContain("escape_guard");

    const cmds = execMock.mock.calls.map((c) => c[1] as string);
    expect(cmds.some((c) => c.includes("secret.txt"))).toBe(false);
  });

  it("single-run path (default root) keeps byte-identical run_bash behavior — escape guard bypassed", async () => {
    const single = await mcpSandbox({ tenant_id: TENANT, run_id: "runSolo", repo_full_name: REPO });

    const r = (await getHandler(single, "run_bash")({
      command: "cd .. && ls",
      timeout_seconds: 60,
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(r.isError).toBeUndefined();
    const cmds = execMock.mock.calls.map((c) => c[1] as string);
    expect(
      cmds.some((c) => c === "export npm_config_yes=false; cd /home/user/repo && cd .. && ls"),
    ).toBe(true);
  });
});
