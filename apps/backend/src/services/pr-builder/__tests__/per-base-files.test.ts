import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: vi.fn(),
  refreshOriginUrlStep: vi.fn(() => ""),
}));

import { buildPerBaseFiles } from "../per-base-files";
import { execCommand } from "@/services/sandbox/e2b-client";

const execMock = vi.mocked(execCommand);
beforeEach(() => { execMock.mockReset(); });
const res = (stdout: string, exit_code = 0) => ({ stdout, stderr: "", exit_code, ms: 0 });

describe("buildPerBaseFiles (compare, no cherry-pick)", () => {
  it("NEW FILE fan-out to dev+main needs no git network and builds both", async () => {
    const defaultFiles = [{ path: "QA.md", action: "create" as const, content: "new\n" }];
    const r = await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "development",
      bases: ["development", "main"], defaultFiles,
    });
    expect(r.perBase.development).toBe(defaultFiles);
    expect(r.perBase.main).toEqual([{ path: "QA.md", action: "create", content: "new\n", diff: undefined }]);
    expect(r.conflicts).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(execMock).not.toHaveBeenCalled();
  });

  it("MODIFY where base matches HEAD pre-image is kept (byte-equal fast path, no merge)", async () => {
    const defaultFiles = [{ path: "f.ts", action: "modify" as const, content: "EDITED" }];
    const cmds: string[] = [];
    execMock.mockImplementation((...a: unknown[]) => {
      const cmd = (a[1] as string) ?? "";
      cmds.push(cmd);
      if (cmd.includes("git fetch")) return Promise.resolve(res(""));
      if (cmd.includes("git merge-file")) return Promise.resolve(res("SHOULD-NOT-RUN"));
      if (cmd.includes("git show HEAD:")) return Promise.resolve(res("PREEDIT"));
      if (cmd.includes("git show origin/'main':")) return Promise.resolve(res("PREEDIT"));
      return Promise.resolve(res(""));
    });
    const r = await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "development",
      bases: ["main"], defaultFiles,
    });
    expect(r.perBase.main).toEqual([{ path: "f.ts", action: "modify", content: "EDITED", diff: undefined }]);
    expect(r.conflicts).toEqual([]);
    expect(cmds.some((c) => c.includes("git merge-file"))).toBe(false);
  });

  it("DIVERGENT base, clean 3-way merge → ships the MERGED content (eng-review 2026-06-27)", async () => {
    const defaultFiles = [{ path: "f.ts", action: "modify" as const, content: "EDITED" }];
    execMock.mockImplementation((...a: unknown[]) => {
      const cmd = (a[1] as string) ?? "";
      if (cmd.includes("git fetch")) return Promise.resolve(res(""));
      if (cmd.includes("git merge-file")) return Promise.resolve(res("MERGED-DEV+EDIT", 0));
      if (cmd.includes("git show HEAD:")) return Promise.resolve(res("PREEDIT"));
      if (cmd.includes("git show origin/'development':")) return Promise.resolve(res("DEV-DIVERGED"));
      return Promise.resolve(res(""));
    });
    const r = await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "main",
      bases: ["development"], defaultFiles,
    });
    expect(r.perBase.development).toEqual([
      { path: "f.ts", action: "modify", content: "MERGED-DEV+EDIT", diff: undefined },
    ]);
    expect(r.conflicts).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("DIVERGENT base, TRUE textual conflict (merge-file exit>0) → refused, never clobbered", async () => {
    const defaultFiles = [{ path: "f.ts", action: "modify" as const, content: "EDITED" }];
    execMock.mockImplementation((...a: unknown[]) => {
      const cmd = (a[1] as string) ?? "";
      if (cmd.includes("git fetch")) return Promise.resolve(res(""));
      if (cmd.includes("git merge-file")) return Promise.resolve(res("<<<<<<< conflict markers", 1));
      if (cmd.includes("git show HEAD:")) return Promise.resolve(res("PREEDIT"));
      if (cmd.includes("git show origin/'release':")) return Promise.resolve(res("CONFLICTING-EDIT"));
      return Promise.resolve(res(""));
    });
    const r = await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "main",
      bases: ["release"], defaultFiles,
    });
    expect(r.conflicts).toContain("release");
    expect(r.perBase.release).toBeUndefined();
  });

  it("REGRESSION (apna 2026-06-26): default branch moved past the edit — base still matching HEAD is NOT a false-conflict", async () => {
    const defaultFiles = [{ path: "messaging.ts", action: "modify" as const, content: "FIXED" }];
    execMock.mockImplementation((...a: unknown[]) => {
      const cmd = (a[1] as string) ?? "";
      if (cmd.includes("git fetch")) return Promise.resolve(res(""));
      if (cmd.includes("git show HEAD:")) return Promise.resolve(res("BUGGY"));
      if (cmd.includes("git show origin/'development':")) return Promise.resolve(res("BUGGY"));
      if (cmd.includes("git show origin/'main':")) return Promise.resolve(res("FIXED"));
      return Promise.resolve(res(""));
    });
    const r = await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "main",
      bases: ["development"], defaultFiles,
    });
    expect(r.perBase.development).toEqual([
      { path: "messaging.ts", action: "modify", content: "FIXED", diff: undefined },
    ]);
    expect(r.conflicts).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("MODIFY refused when HEAD pre-image is unreadable (cannot verify → never clobber)", async () => {
    const defaultFiles = [{ path: "f.ts", action: "modify" as const, content: "EDITED" }];
    execMock.mockImplementation((...a: unknown[]) => {
      const cmd = (a[1] as string) ?? "";
      if (cmd.includes("git fetch")) return Promise.resolve(res(""));
      if (cmd.includes("git show HEAD:")) return Promise.resolve(res("", 128));
      if (cmd.includes("git show origin/'development':")) return Promise.resolve(res("X"));
      return Promise.resolve(res(""));
    });
    const r = await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "main", bases: ["development"], defaultFiles,
    });
    expect(r.conflicts).toContain("development");
    expect(r.perBase.development).toBeUndefined();
  });

  it("MODIFY of a file absent on the base becomes a clean add there", async () => {
    const defaultFiles = [{ path: "f.ts", action: "modify" as const, content: "EDITED" }];
    execMock.mockImplementation((...a: unknown[]) => {
      const cmd = (a[1] as string) ?? "";
      if (cmd.includes("git fetch")) return Promise.resolve(res(""));
      if (cmd.includes("git show origin/'main':")) return Promise.resolve(res("", 128));
      return Promise.resolve(res("X"));
    });
    const r = await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "development", bases: ["main"], defaultFiles,
    });
    expect(r.perBase.main).toEqual([{ path: "f.ts", action: "create", content: "EDITED", diff: undefined }]);
  });

  it("fetch failure on a modify refuses the base (cannot verify → never clobber)", async () => {
    const defaultFiles = [{ path: "f.ts", action: "modify" as const, content: "EDITED" }];
    execMock.mockImplementation((...a: unknown[]) => {
      const cmd = (a[1] as string) ?? "";
      if (cmd.includes("git fetch")) return Promise.resolve(res("auth failed", 128));
      return Promise.resolve(res(""));
    });
    const r = await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "development", bases: ["main"], defaultFiles,
    });
    expect(r.errors).toContain("main");
    expect(r.perBase.main).toBeUndefined();
  });

  it("HONORS repo_root: HEAD pre-image is read from the worktree, not /home/user/repo", async () => {
    const defaultFiles = [{ path: "f.ts", action: "modify" as const, content: "EDITED" }];
    const cmds: string[] = [];
    execMock.mockImplementation((...a: unknown[]) => {
      const cmd = (a[1] as string) ?? "";
      cmds.push(cmd);
      if (cmd.includes("git fetch")) return Promise.resolve(res(""));
      return Promise.resolve(res("SAME"));
    });
    await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "main", bases: ["development"],
      defaultFiles, repo_root: "/home/user/wt-abc",
    });
    const headCmd = cmds.find((c) => c.includes("git show HEAD:"));
    expect(headCmd).toContain("cd /home/user/wt-abc &&");
    expect(headCmd).not.toContain("/home/user/repo");
  });

  it("unsafe branch name → error; no non-default base → no work", async () => {
    const r1 = await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "main",
      bases: ["main", "bad branch"], defaultFiles: [{ path: "x", action: "create", content: "y" }],
    });
    expect(r1.errors).toContain("bad branch");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("check-ref-format-equivalent guard rejects dangerous ref names (no git round-trip)", async () => {
    const bad = [
      "a..b", "a//b", "/lead", "trail/", ".dot", "dot.", "x.lock", "-flag",
      "foo/.bar", "foo/bar.lock",
    ];
    const r = await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "main",
      bases: ["main", ...bad], defaultFiles: [{ path: "x", action: "create", content: "y" }],
    });
    for (const b of bad) expect(r.errors).toContain(b);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe("buildPerBaseFiles keeps binary post-images binary", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]).toString("base64");

  it("a CREATED image fanned out to a second base keeps encoding=base64 so the blob writer does not UTF-8 it", async () => {
    const defaultFiles = [{ path: "public/images/hero.png", action: "create" as const, content: png, encoding: "base64" as const }];
    const r = await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "main",
      bases: ["main", "development"], defaultFiles,
    });
    expect(r.perBase.development).toEqual([
      { path: "public/images/hero.png", action: "create", content: png, diff: undefined, encoding: "base64" },
    ]);
    expect(Buffer.from(r.perBase.development[0].content!, "base64")[0]).toBe(0x89);
  });

  it("a MODIFIED image whose base matches HEAD keeps encoding; a MODIFIED image absent on the base becomes a base64 create", async () => {
    const defaultFiles = [{ path: "public/images/hero.png", action: "modify" as const, content: png, encoding: "base64" as const }];
    execMock.mockImplementation((...a: unknown[]) => {
      const cmd = (a[1] as string) ?? "";
      if (cmd.includes("git fetch")) return Promise.resolve(res(""));
      if (cmd.includes("git merge-file")) return Promise.resolve(res("MERGED-TEXT"));
      if (cmd.includes("git show HEAD:")) return Promise.resolve(res("OLD-BYTES"));
      if (cmd.includes("git show origin/'development':")) return Promise.resolve(res("OLD-BYTES"));
      if (cmd.includes("git show origin/'staging':")) return Promise.resolve(res("", 128));
      return Promise.resolve(res(""));
    });
    const r = await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "main",
      bases: ["development", "staging"], defaultFiles,
    });
    expect(r.perBase.development).toEqual([
      { path: "public/images/hero.png", action: "modify", content: png, diff: undefined, encoding: "base64" },
    ]);
    expect(r.perBase.staging).toEqual([
      { path: "public/images/hero.png", action: "create", content: png, diff: undefined, encoding: "base64" },
    ]);
    expect(r.conflicts).toEqual([]);
  });

  it("a MODIFIED image whose base diverged is refused instead of text-merged into a corrupt blob", async () => {
    const defaultFiles = [{ path: "public/images/hero.png", action: "modify" as const, content: png, encoding: "base64" as const }];
    const cmds: string[] = [];
    execMock.mockImplementation((...a: unknown[]) => {
      const cmd = (a[1] as string) ?? "";
      cmds.push(cmd);
      if (cmd.includes("git fetch")) return Promise.resolve(res(""));
      if (cmd.includes("git merge-file")) return Promise.resolve(res("MERGED-TEXT"));
      if (cmd.includes("git show HEAD:")) return Promise.resolve(res("OLD-BYTES"));
      if (cmd.includes("git show origin/'development':")) return Promise.resolve(res("OTHER-BYTES"));
      return Promise.resolve(res(""));
    });
    const r = await buildPerBaseFiles({
      sandbox_id: "s", defaultBranch: "main",
      bases: ["development"], defaultFiles,
    });
    expect(r.perBase.development).toBeUndefined();
    expect(r.conflicts).toEqual(["development"]);
    expect(cmds.some((c) => c.includes("git merge-file"))).toBe(false);
  });
});
