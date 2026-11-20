import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execCommand: vi.fn(async () => ({ stdout: "", stderr: "", exit_code: 0, ms: 1 })),
}));
vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: mocks.execCommand,
  readFile: vi.fn(async () => ""),
  readFileBytes: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => undefined),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/tools/slack/upload_file", () => ({ uploadFileToThread: vi.fn() }));
vi.mock("@/services/reports/guard", () => ({ assertRunTenantOwnership: vi.fn() }));

import {
  buildStructuredGitDiff,
  gitUnquotePath,
  parseGitDiffSections,
  sandboxToolRegistry,
  GIT_DIFF_OVERALL_CAP,
  GIT_DIFF_SINGLE_FILE_CAP,
  type SandboxToolDeps,
  type StructuredGitDiff,
} from "@/services/sandbox/tool-registry";

afterEach(() => {
  delete process.env.SANDBOX_EXEC_OUTPUT_CAPS;
  mocks.execCommand.mockClear();
});

function fileSection(path: string, body = "+added line\n-removed line\n context"): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,2 +1,2 @@",
    body,
  ].join("\n");
}

function makeDeps(overrides?: Partial<SandboxToolDeps>): SandboxToolDeps {
  return {
    getSandboxId: async () => {
      throw new Error("getSandboxId should not be called for a rejected path");
    },
    root: "/home/user/repo",
    refusalFor: () => null,
    run_id: "run-test",
    bumpRead: () => 1,
    bumpView: () => 1,
    tenant_id: "t-test",
    ...overrides,
  };
}

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe("parseGitDiffSections", () => {
  it("splits on the `diff --git ` boundary and derives path + status", () => {
    const raw = [
      fileSection("apps/a.ts"),
      [
        "diff --git a/apps/new.ts b/apps/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/apps/new.ts",
        "@@ -0,0 +1 @@",
        "+hello",
      ].join("\n"),
      [
        "diff --git a/apps/gone.ts b/apps/gone.ts",
        "deleted file mode 100644",
        "--- a/apps/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
      ].join("\n"),
    ].join("\n");
    const sections = parseGitDiffSections(raw);
    expect(sections.map((s) => [s.path, s.status])).toEqual([
      ["apps/a.ts", "modified"],
      ["apps/new.ts", "added"],
      ["apps/gone.ts", "deleted"],
    ]);
  });

  it("returns [] for an empty diff", () => {
    expect(parseGitDiffSections("")).toEqual([]);
    expect(parseGitDiffSections("   \n  ")).toEqual([]);
  });

  it("decodes git-quoted special-char paths to the real repo-relative name (P3)", () => {
    const raw = [
      'diff --git "a/apps/we\\"ird\\tname.ts" "b/apps/we\\"ird\\tname.ts"',
      "index 1111111..2222222 100644",
      '--- "a/apps/we\\"ird\\tname.ts"',
      '+++ "b/apps/we\\"ird\\tname.ts"',
      "@@ -1 +1 @@",
      "+x",
    ].join("\n");
    const [sec] = parseGitDiffSections(raw);
    expect(sec.path).toBe('apps/we"ird\tname.ts');
  });
});

describe("gitUnquotePath", () => {
  it("passes a normal path through untouched", () => {
    expect(gitUnquotePath("apps/web/page.tsx")).toBe("apps/web/page.tsx");
  });
  it("unescapes quotes/tabs and decodes octal UTF-8 bytes", () => {
    expect(gitUnquotePath('"a\\tb"')).toBe("a\tb");
    expect(gitUnquotePath('"caf\\303\\251"')).toBe("café");
  });
});

describe("buildStructuredGitDiff", () => {
  it("small multi-file diff → all files present, none omitted, not truncated", () => {
    const raw = [fileSection("a.ts"), fileSection("b.ts"), fileSection("c.ts")].join("\n");
    const out: StructuredGitDiff = buildStructuredGitDiff(raw, 20 * 1024);
    expect(out.files.map((f) => f.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(out.files.every((f) => !f.truncated)).toBe(true);
    expect(out.omitted).toEqual([]);
    expect(out._truncated).toBeUndefined();
    expect(out.truncated).toBeUndefined();
    expect(out.files[0].diff).toBe(fileSection("a.ts"));
    expect(out.summary).toContain("3 files changed");
    expect(out.summary).toMatch(/\+\d+\/-\d+/);
  });

  it("oversized diff → first files complete, later files in omitted[] with sizes + _truncated", () => {
    const big = "+" + "x".repeat(900) + "\n";
    const s1 = fileSection("first.ts", big);
    const s2 = fileSection("second.ts", big);
    const s3 = fileSection("third.ts", big);
    const cap = Buffer.byteLength(s1, "utf8") + 50;
    const out = buildStructuredGitDiff([s1, s2, s3].join("\n"), cap);

    expect(out.files.map((f) => f.path)).toEqual(["first.ts"]);
    expect(out.files[0].truncated).toBe(false);
    expect(out.files[0].diff).toBe(s1);

    expect(out.omitted.map((o) => o.path)).toEqual(["second.ts", "third.ts"]);
    for (const o of out.omitted) {
      expect(o.approx_bytes).toBeGreaterThan(0);
    }

    expect(out._truncated).toBe(true);
    expect(out.truncated?.hint).toBeTruthy();
  });

  it("single file bigger than the whole budget → capped in place + truncated:true (never empty)", () => {
    const huge = fileSection("huge.ts", "+" + "y".repeat(40 * 1024) + "\n");
    const cap = 2 * 1024;
    const out = buildStructuredGitDiff(huge, cap);
    expect(out.files).toHaveLength(1);
    expect(out.files[0].path).toBe("huge.ts");
    expect(out.files[0].truncated).toBe(true);
    expect(out.files[0].diff.length).toBeGreaterThan(0);
    expect(out._truncated).toBe(true);
  });

  it("empty diff → no files, no omitted, not truncated", () => {
    const out = buildStructuredGitDiff("", 20 * 1024);
    expect(out.files).toEqual([]);
    expect(out.omitted).toEqual([]);
    expect(out._truncated).toBeUndefined();
    expect(out.summary).toContain("0 files changed");
  });
});

describe("git_diff handler path guard", () => {
  it("rejects a traversal path before touching the sandbox", async () => {
    const r = await sandboxToolRegistry.git_diff(makeDeps(), { path: "../etc/passwd" });
    expect(parse(r)).toMatchObject({ error: "path_rejected" });
    expect((r as { isError?: boolean }).isError).toBe(true);
  });

  it("rejects an absolute path", async () => {
    const r = await sandboxToolRegistry.git_diff(makeDeps(), { path: "/etc/passwd" });
    expect((parse(r) as { error: string }).error).toBe("path_rejected");
  });

  it("shell-escapes (does NOT reject) an apostrophe — valid git path, no injection", async () => {
    const deps = makeDeps({ getSandboxId: async () => "sb-id" });
    await sandboxToolRegistry.git_diff(deps, { path: "a'; rm -rf /.ts" });
    expect(mocks.execCommand).toHaveBeenCalledWith(
      "sb-id",
      "cd /home/user/repo && git diff --no-ext-diff HEAD -- ':(literal)a'\\''; rm -rf /.ts'",
      30_000,
    );
  });

  it("quotes + literal-pathspecs the path into the -- arg (no escape-guard on git_diff)", async () => {
    const deps = makeDeps({ getSandboxId: async () => "sb-id" });
    await sandboxToolRegistry.git_diff(deps, { path: "apps/web/page.tsx" });
    expect(mocks.execCommand).toHaveBeenCalledWith(
      "sb-id",
      "cd /home/user/repo && git diff --no-ext-diff HEAD -- ':(literal)apps/web/page.tsx'",
      30_000,
    );
  });

  it("uses :(literal) so pathspec metacharacters match only that file (P2)", async () => {
    const deps = makeDeps({ getSandboxId: async () => "sb-id" });
    await sandboxToolRegistry.git_diff(deps, { path: "src/a[1].ts" });
    expect(mocks.execCommand).toHaveBeenCalledWith(
      "sb-id",
      "cd /home/user/repo && git diff --no-ext-diff HEAD -- ':(literal)src/a[1].ts'",
      30_000,
    );
  });

  it("path-scoped recovery uses the larger SINGLE_FILE budget so a big file's diff fits (P2)", async () => {
    process.env.SANDBOX_EXEC_OUTPUT_CAPS = "1";
    const deps = makeDeps({ getSandboxId: async () => "sb-id" });
    const body = "+" + "z".repeat(GIT_DIFF_OVERALL_CAP + 5000) + "\n";
    const oneFile = fileSection("big.ts", body);
    expect(Buffer.byteLength(oneFile, "utf8")).toBeGreaterThan(GIT_DIFF_OVERALL_CAP);
    expect(Buffer.byteLength(oneFile, "utf8")).toBeLessThan(GIT_DIFF_SINGLE_FILE_CAP);
    mocks.execCommand.mockResolvedValueOnce({ stdout: oneFile, stderr: "", exit_code: 0, ms: 2 });
    const r = await sandboxToolRegistry.git_diff(deps, { path: "big.ts" });
    const p = parse(r) as unknown as StructuredGitDiff;
    expect(p.files).toHaveLength(1);
    expect(p.files[0].truncated).toBe(false);
    expect(p._truncated).toBeUndefined();
  });
});
