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

import { buildSandboxToolDeps, clearSandboxReadCounter } from "@/services/agents/sdk/mcp-sandbox";
import { makeSandboxExecutor } from "@/services/agents/engine/openai-sandbox-tools";
import { execCommand as execCommandRaw, writeFile as writeFileRaw } from "@/services/sandbox/e2b-client";
import { getSandboxIdForRun as getSandboxIdForRunRaw } from "@/services/sandbox/lifecycle";

const execMock = vi.mocked(execCommandRaw);
const writeMock = vi.mocked(writeFileRaw);
const lookupMock = vi.mocked(getSandboxIdForRunRaw);

const TENANT = "t-1";
const REPO = "acme/app";
const WT_A = "/home/user/wt-childAAA";
const WT_B = "/home/user/wt-childBBB";

beforeEach(() => {
  execMock.mockClear();
  writeMock.mockClear();
  lookupMock.mockClear();
  clearSandboxReadCounter("runA");
});

describe("live executor on a batch child (buildSandboxToolDeps repo_root)", () => {
  it("writes land in the child's own worktree", async () => {
    const ex = makeSandboxExecutor(
      buildSandboxToolDeps({ tenant_id: TENANT, run_id: "runA", repo_full_name: REPO, repo_root: WT_A }),
      "live",
    );
    const r = await ex("write_file", { path: "src/a.ts", content: "// a" });
    expect(r.is_error).toBe(false);
    const written = writeMock.mock.calls.map((c) => c[1] as string);
    expect(written).toEqual([`${WT_A}/src/a.ts`]);
  });

  it("the strict-isolation escape guard still refuses a sibling read (never reaches exec)", async () => {
    const ex = makeSandboxExecutor(
      buildSandboxToolDeps({ tenant_id: TENANT, run_id: "runA", repo_full_name: REPO, repo_root: WT_A }),
      "live",
    );
    const abs = await ex("run_bash", { command: `cat ${WT_B}/notes.txt`, timeout_seconds: 60 });
    expect(abs.is_error).toBe(true);
    expect(abs.content).toContain("escape_guard");
    const rel = await ex("run_bash", { command: "cd ../wt-childBBB && ls", timeout_seconds: 60 });
    expect(rel.is_error).toBe(true);
    expect(rel.content).toContain("escape_guard");
    expect(execMock.mock.calls.some((c) => String(c[1]).includes("wt-childBBB"))).toBe(false);
  });

  it("resolves the sandbox id once per deps (cached) via the same lookup; a known id skips it", async () => {
    const d = buildSandboxToolDeps({ tenant_id: TENANT, run_id: "runA", repo_full_name: REPO });
    await d.getSandboxId();
    await d.getSandboxId();
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledWith(TENANT, REPO);

    lookupMock.mockClear();
    const known = buildSandboxToolDeps({ tenant_id: TENANT, run_id: "runA", repo_full_name: REPO, known_sandbox_id: "sbx-known" });
    expect(await known.getSandboxId()).toBe("sbx-known");
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
