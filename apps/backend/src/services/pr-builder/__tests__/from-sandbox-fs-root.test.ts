import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/sandbox/e2b-client", () => ({ execCommand: vi.fn() }));

import { buildPrFilesFromSandboxFs } from "../from-sandbox-fs";
import { execCommand } from "@/services/sandbox/e2b-client";

const execMock = vi.mocked(execCommand);
beforeEach(() => { execMock.mockReset(); });
const emptyStatus = { stdout: "", stderr: "", exit_code: 0, ms: 0 };

describe("buildPrFilesFromSandboxFs repo_root threading", () => {
  it("defaults to /home/user/repo when repo_root omitted (behavior-preserving)", async () => {
    execMock.mockResolvedValue(emptyStatus);
    await buildPrFilesFromSandboxFs({ sandbox_id: "sbx" });
    const firstCmd = (execMock.mock.calls[0]?.[1] as string) ?? "";
    expect(firstCmd).toContain("cd /home/user/repo &&");
    expect(firstCmd).not.toContain("/home/user/wt-");
  });

  it("uses the provided worktree root when repo_root is set", async () => {
    execMock.mockResolvedValue(emptyStatus);
    await buildPrFilesFromSandboxFs({ sandbox_id: "sbx", repo_root: "/home/user/wt-abc123" });
    const firstCmd = (execMock.mock.calls[0]?.[1] as string) ?? "";
    expect(firstCmd).toContain("cd /home/user/wt-abc123 &&");
    expect(firstCmd).not.toContain("cd /home/user/repo &&");
  });

  it("uses --untracked-files=all so untracked DIRECTORIES expand into individual files (w31 ground-truth ship blocker)", async () => {
    execMock.mockResolvedValue(emptyStatus);
    await buildPrFilesFromSandboxFs({ sandbox_id: "sbx" });
    const firstCmd = (execMock.mock.calls[0]?.[1] as string) ?? "";
    expect(firstCmd).toContain("--untracked-files=all");
    expect(firstCmd).toContain("git status --porcelain=v1");
  });
});
