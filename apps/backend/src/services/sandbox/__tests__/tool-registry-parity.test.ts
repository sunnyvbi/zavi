import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    readFileImpl: async (_id: string, _path: string): Promise<string> => "",
    readFileBytesImpl: async (_id: string, _path: string): Promise<Uint8Array> =>
      new Uint8Array(),
    uploadShouldThrow: false,
    guardShouldThrow: null as null | { code: string; message: string },
  };
  return {
    state,
    execCommand: vi.fn(async (_id: string, _cmd: string, _timeout?: number) => ({
      stdout: "",
      stderr: "",
      exit_code: 0,
      ms: 1,
    })),
    readFile: vi.fn((id: string, p: string) => state.readFileImpl(id, p)),
    readFileBytes: vi.fn((id: string, p: string) => state.readFileBytesImpl(id, p)),
    writeFile: vi.fn(async (_id: string, _path: string, _content: string) => undefined),
    getSandboxIdForRun: vi.fn(async () => "sb-test-id"),
    uploadFileToThread: vi.fn(async () => {
      if (state.uploadShouldThrow) throw new Error("slack boom");
    }),
    assertRunTenantOwnership: vi.fn(async () => {
      if (state.guardShouldThrow) {
        const { ExpectedToolError } = await import("@/services/tools/types");
        throw new ExpectedToolError(
          state.guardShouldThrow.code,
          state.guardShouldThrow.message,
        );
      }
    }),
    stageHtmlPreviewArtifact: vi.fn(async () => ({
      ok: true as const,
      preview_id: "550e8400-e29b-41d4-a716-446655440000",
      version: 2 as const,
      state: "html_preview_ready" as const,
      title: "Preview",
      summary: "Ready",
      sanitized_bytes: 42,
    })),
    serviceClient: vi.fn(() => ({
      storage: {
        from: () => ({
          upload: vi.fn(async () => ({ error: null })),
        }),
      },
      from: () => ({
        upsert: () => ({
          select: () => ({
            single: vi.fn(async () => ({ data: { id: "artifact-xyz" }, error: null })),
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: () => ({
              eq: vi.fn(async () => ({ error: null })),
            }),
          }),
        }),
      }),
    })),
  };
});

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: mocks.execCommand,
  readFile: mocks.readFile,
  readFileBytes: mocks.readFileBytes,
  writeFile: mocks.writeFile,
}));

vi.mock("@/services/sandbox/lifecycle", () => ({
  getSandboxIdForRun: mocks.getSandboxIdForRun,
}));

vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClient }));
vi.mock("@/services/tools/slack/upload_file", () => ({
  uploadFileToThread: mocks.uploadFileToThread,
}));
vi.mock("@/services/reports/guard", () => ({
  assertRunTenantOwnership: mocks.assertRunTenantOwnership,
}));
vi.mock("@/services/agents/html-preview-artifacts", () => ({
  stageHtmlPreviewArtifact: mocks.stageHtmlPreviewArtifact,
}));

import {
  sandboxToolRegistry,
  SANDBOX_TOOL_NAMES,
  type SandboxToolDeps,
} from "@/services/sandbox/tool-registry";
import { mcpSandbox } from "@/services/agents/sdk/mcp-sandbox";

const execMockImpl = mocks.execCommand;
const writeMock = mocks.writeFile;
const setReadFile = (fn: (id: string, p: string) => Promise<string>) => {
  mocks.state.readFileImpl = fn;
};
const setReadFileBytes = (fn: (id: string, p: string) => Promise<Uint8Array>) => {
  mocks.state.readFileBytesImpl = fn;
};

function makeDeps(overrides?: Partial<SandboxToolDeps>): SandboxToolDeps {
  const reads = { n: 0 };
  const views = { n: 0 };
  return {
    getSandboxId: async () => "sb-test-id",
    root: "/home/user/repo",
    refusalFor: () => null,
    run_id: "run-test",
    bumpRead: () => ++reads.n,
    bumpView: () => ++views.n,
    tenant_id: "t-test",
    ...overrides,
  };
}

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

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

beforeEach(() => {
  process.env.SANDBOX_EXEC_OUTPUT_CAPS = "0";
  execMockImpl.mockClear();
  writeMock.mockClear();
  mocks.uploadFileToThread.mockClear();
  mocks.assertRunTenantOwnership.mockClear();
  setReadFile(async () => "");
  setReadFileBytes(async () => new Uint8Array());
  mocks.state.uploadShouldThrow = false;
  mocks.state.guardShouldThrow = null;
});

describe("SANDBOX_TOOL_NAMES", () => {
  it("has exactly 14 entries matching the registry keys", () => {
    expect(SANDBOX_TOOL_NAMES).toHaveLength(14);
    expect([...SANDBOX_TOOL_NAMES].sort()).toEqual(
      Object.keys(sandboxToolRegistry).sort(),
    );
  });

  it("matches the tools registered by mcpSandbox (no declared_tools filter)", async () => {
    const server = await mcpSandbox({
      tenant_id: "t",
      run_id: "r",
      repo_full_name: "acme/app",
    });
    const registered = Object.keys(
      (server as unknown as { instance: { _registeredTools: Record<string, unknown> } })
        .instance._registeredTools,
    );
    expect(registered.sort()).toEqual([...SANDBOX_TOOL_NAMES].sort());
  });
});

describe("write_file", () => {
  it("mkdir's parent + writes + returns {ok,path}", async () => {
    const r = await sandboxToolRegistry.write_file(makeDeps(), {
      path: "src/a.ts",
      content: "// a",
    });
    expect(parse(r)).toEqual({ ok: true, path: "src/a.ts" });
    expect(execMockImpl).toHaveBeenCalledWith("sb-test-id", "mkdir -p '/home/user/repo/src'", 10_000);
    expect(writeMock).toHaveBeenCalledWith("sb-test-id", "/home/user/repo/src/a.ts", "// a");
  });

  it("returns write_failed on a thrown e2b error", async () => {
    writeMock.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    const r = await sandboxToolRegistry.write_file(makeDeps(), { path: "a.ts", content: "x" });
    expect(parse(r)).toEqual({ error: "write_failed", message: "disk full" });
    expect((r as { isError?: boolean }).isError).toBe(true);
  });
});

describe("read_file caps", () => {
  it("returns content untruncated under the byte cap", async () => {
    setReadFile(async () => "hello");
    const r = await sandboxToolRegistry.read_file(makeDeps(), { path: "a.ts" });
    expect(parse(r)).toEqual({ content: "hello", truncated: false, reads_used: 1 });
  });

  it("truncates at the 8KB byte cap with the [truncated N bytes] marker", async () => {
    const big = "x".repeat(9000);
    setReadFile(async () => big);
    const r = await sandboxToolRegistry.read_file(makeDeps(), { path: "a.ts" });
    const p = parse(r) as { content: string; truncated: boolean; truncated_bytes: number };
    expect(p.truncated).toBe(true);
    expect(p.truncated_bytes).toBe(9000 - 8 * 1024);
    expect(p.content).toContain(`[truncated ${9000 - 8 * 1024} bytes]`);
  });

  it("fires read_cap_exceeded on the 25th read (cap 24)", async () => {
    const deps = makeDeps();
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) {
      last = parse(await sandboxToolRegistry.read_file(deps, { path: "a.ts" }));
    }
    expect(last.error).toBe("read_cap_exceeded");
  });
});

describe("run_bash STRICT_ISOLATION refusal", () => {
  it("does NOT refuse when refusalFor returns null (default single-run path)", async () => {
    const r = await sandboxToolRegistry.run_bash(makeDeps(), { command: "ls", timeout_seconds: 60 });
    expect(parse(r)).toMatchObject({ exit_code: 0 });
    expect(execMockImpl).toHaveBeenCalledWith(
      "sb-test-id",
      "export npm_config_yes=false; cd /home/user/repo && ls",
      60_000,
    );
  });

  it("returns escape_guard ONLY when refusalFor returns non-null", async () => {
    const r = await sandboxToolRegistry.run_bash(
      makeDeps({ refusalFor: () => "refused: nope" }),
      { command: "cat /etc/passwd", timeout_seconds: 60 },
    );
    expect(parse(r)).toEqual({ error: "escape_guard", message: "refused: nope" });
    expect(execMockImpl).not.toHaveBeenCalled();
  });
});

describe("run_tests", () => {
  it("defaults the command to `npm test` and honors the 120s default timeout", async () => {
    const r = await sandboxToolRegistry.run_tests(makeDeps(), {});
    expect(parse(r)).toMatchObject({ exit_code: 0 });
    expect(execMockImpl).toHaveBeenCalledWith(
      "sb-test-id",
      "export npm_config_yes=false; cd /home/user/repo && npm test",
      120_000,
    );
  });
});

describe("git_diff / git_status", () => {
  it("git_diff runs `git diff --no-ext-diff HEAD` (not a hardcoded origin/main — broke non-main-default repos + per-run worktrees) and returns {diff,ms}", async () => {
    execMockImpl.mockResolvedValueOnce({ stdout: "DIFF", stderr: "", exit_code: 0, ms: 7 });
    const r = await sandboxToolRegistry.git_diff(makeDeps(), {});
    expect(parse(r)).toEqual({ diff: "DIFF", ms: 7 });
    expect(execMockImpl).toHaveBeenCalledWith(
      "sb-test-id",
      "cd /home/user/repo && git diff --no-ext-diff HEAD",
      30_000,
    );
  });

  it("git_status runs porcelain and returns {status,ms}", async () => {
    execMockImpl.mockResolvedValueOnce({ stdout: " M x", stderr: "", exit_code: 0, ms: 3 });
    const r = await sandboxToolRegistry.git_status(makeDeps(), {});
    expect(parse(r)).toEqual({ status: " M x", ms: 3 });
  });
});

describe("view caps + line numbering", () => {
  it("returns 1-indexed numbered lines + total_lines", async () => {
    setReadFile(async () => "a\nb\nc");
    const r = await sandboxToolRegistry.view(makeDeps(), { path: "f.ts" });
    const p = parse(r) as { content: string; total_lines: number; views_used: number };
    expect(p.content).toBe("1\ta\n2\tb\n3\tc");
    expect(p.total_lines).toBe(3);
    expect(p.views_used).toBe(1);
  });

  it("rejects a reversed view_range with view_range_invalid", async () => {
    setReadFile(async () => "a\nb\nc\nd");
    const r = await sandboxToolRegistry.view(makeDeps(), { path: "f.ts", view_range: [3, 2] });
    expect((parse(r) as { error: string }).error).toBe("view_range_invalid");
  });

  it("fires view_cap_exceeded on the 25th view (cap 24)", async () => {
    setReadFile(async () => "x");
    const deps = makeDeps();
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) {
      last = parse(await sandboxToolRegistry.view(deps, { path: "f.ts" }));
    }
    expect(last.error).toBe("view_cap_exceeded");
  });
});

describe("str_replace exact-once semantics", () => {
  it("0 matches → no_match", async () => {
    setReadFile(async () => "alpha beta");
    const r = await sandboxToolRegistry.str_replace(makeDeps(), {
      path: "f.ts",
      old_str: "gamma",
      new_str: "x",
    });
    expect((parse(r) as { error: string }).error).toBe("no_match");
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("2 matches → not_unique", async () => {
    setReadFile(async () => "x foo y foo z");
    const r = await sandboxToolRegistry.str_replace(makeDeps(), {
      path: "f.ts",
      old_str: "foo",
      new_str: "bar",
    });
    expect((parse(r) as { error: string }).error).toBe("not_unique");
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("exactly 1 match → replaces + writes", async () => {
    setReadFile(async () => "keep foo keep");
    const r = await sandboxToolRegistry.str_replace(makeDeps(), {
      path: "f.ts",
      old_str: "foo",
      new_str: "bar",
    });
    expect(parse(r)).toEqual({ ok: true, path: "f.ts" });
    expect(writeMock).toHaveBeenCalledWith("sb-test-id", "/home/user/repo/f.ts", "keep bar keep");
  });

  it("strict path resolution rejects absolute paths (path_must_be_repo_relative)", async () => {
    const r = await sandboxToolRegistry.str_replace(makeDeps(), {
      path: "/etc/passwd",
      old_str: "a",
      new_str: "b",
    });
    const p = parse(r) as { error: string; message: string };
    expect(p.error).toBe("str_replace_failed");
    expect(p.message).toContain("path_must_be_repo_relative");
  });
});

describe("create existence-probe", () => {
  it("already_exists when the probe reports exists", async () => {
    execMockImpl.mockResolvedValueOnce({ stdout: "exists", stderr: "", exit_code: 0, ms: 1 });
    const r = await sandboxToolRegistry.create(makeDeps(), { path: "new.ts", file_text: "x" });
    expect((parse(r) as { error: string }).error).toBe("already_exists");
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("writes when the probe reports missing", async () => {
    execMockImpl
      .mockResolvedValueOnce({ stdout: "missing", stderr: "", exit_code: 0, ms: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exit_code: 0, ms: 1 });
    const r = await sandboxToolRegistry.create(makeDeps(), { path: "dir/new.ts", file_text: "x" });
    expect(parse(r)).toEqual({ ok: true, path: "dir/new.ts" });
    expect(writeMock).toHaveBeenCalledWith("sb-test-id", "/home/user/repo/dir/new.ts", "x");
  });

  it("fails closed (existence_probe_failed) on an indeterminate probe", async () => {
    execMockImpl.mockResolvedValueOnce({ stdout: "???", stderr: "", exit_code: 0, ms: 1 });
    const r = await sandboxToolRegistry.create(makeDeps(), { path: "new.ts", file_text: "x" });
    expect((parse(r) as { error: string }).error).toBe("existence_probe_failed");
  });
  it("fast build first pass: create over a pristine starter file replaces it", async () => {
    execMockImpl.mockResolvedValueOnce({ stdout: "pristine", stderr: "", exit_code: 0, ms: 1 });
    const r = await sandboxToolRegistry.create(makeDeps({ createReplacePristinePaths: ["src/pages/Home.tsx"] }), {
      path: "src/pages/Home.tsx",
      file_text: "home",
    });
    expect(parse(r)).toEqual({ ok: true, path: "src/pages/Home.tsx", replaced_unmodified_file: true });
    expect(writeMock).toHaveBeenCalledWith("sb-test-id", "/home/user/repo/src/pages/Home.tsx", "home");
    expect(String(execMockImpl.mock.calls[0][1])).toContain("ls-files --error-unmatch");
  });

  it("fast build first pass: a file the run already changed still fails already_exists", async () => {
    execMockImpl.mockResolvedValueOnce({ stdout: "exists", stderr: "", exit_code: 0, ms: 1 });
    const r = await sandboxToolRegistry.create(makeDeps({ createReplacePristinePaths: ["src/pages/Home.tsx"] }), { path: "./src/pages/Home.tsx", file_text: "x" });
    expect((parse(r) as { error: string }).error).toBe("already_exists");
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("a path outside the allowlist (App.tsx carries the routes) never gets the pristine probe", async () => {
    execMockImpl.mockResolvedValueOnce({ stdout: "exists", stderr: "", exit_code: 0, ms: 1 });
    const r = await sandboxToolRegistry.create(makeDeps({ createReplacePristinePaths: ["src/pages/Home.tsx"] }), { path: "src/App.tsx", file_text: "x" });
    expect((parse(r) as { error: string }).error).toBe("already_exists");
    expect(String(execMockImpl.mock.calls[0][1])).not.toContain("ls-files");
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("a whitespace-padded path is a different file and never matches the allowlist", async () => {
    for (const path of [" src/pages/Home.tsx", "src/pages/Home.tsx ", "src/pages/Home.tsx\n", "\tsrc/pages/Home.tsx"]) {
      execMockImpl.mockClear();
      execMockImpl.mockResolvedValueOnce({ stdout: "exists", stderr: "", exit_code: 0, ms: 1 });
      const r = await sandboxToolRegistry.create(makeDeps({ createReplacePristinePaths: ["src/pages/Home.tsx"] }), { path, file_text: "x" });
      expect((parse(r) as { error: string }).error).toBe("already_exists");
      expect(String(execMockImpl.mock.calls[0][1])).not.toContain("ls-files");
    }
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("without the flag a 'pristine' answer is indeterminate (never an overwrite)", async () => {
    execMockImpl.mockResolvedValueOnce({ stdout: "pristine", stderr: "", exit_code: 0, ms: 1 });
    const r = await sandboxToolRegistry.create(makeDeps(), { path: "src/pages/Home.tsx", file_text: "x" });
    expect((parse(r) as { error: string }).error).toBe("existence_probe_failed");
    expect(writeMock).not.toHaveBeenCalled();
    expect(String(execMockImpl.mock.calls[0][1])).not.toContain("ls-files");
  });
});

describe("insert", () => {
  it("inserts after the given 1-indexed line", async () => {
    setReadFile(async () => "a\nb\nc");
    const r = await sandboxToolRegistry.insert(makeDeps(), {
      path: "f.ts",
      insert_line: 1,
      new_str: "X",
    });
    expect(parse(r)).toEqual({ ok: true, path: "f.ts" });
    expect(writeMock).toHaveBeenCalledWith("sb-test-id", "/home/user/repo/f.ts", "a\nX\nb\nc");
  });

  it("rejects insert_line past EOF with insert_line_out_of_range", async () => {
    setReadFile(async () => "a\nb");
    const r = await sandboxToolRegistry.insert(makeDeps(), {
      path: "f.ts",
      insert_line: 9,
      new_str: "X",
    });
    expect((parse(r) as { error: string }).error).toBe("insert_line_out_of_range");
  });
});

describe("emit_artifact validation gate (pre-side-effect error codes)", () => {
  it("filename_invalid when sanitization leaves nothing usable", async () => {
    const r = await sandboxToolRegistry.emit_artifact(makeDeps(), {
      path: "out/x.pdf",
      filename: "///",
    });
    expect((parse(r) as { error: string }).error).toBe("filename_invalid");
  });

  it("mime_not_allowed for a non-allowlisted extension", async () => {
    const r = await sandboxToolRegistry.emit_artifact(makeDeps(), {
      path: "out/x.txt",
      filename: "report.txt",
    });
    expect((parse(r) as { error: string }).error).toBe("mime_not_allowed");
  });

  it("artifact_empty for a 0-byte file", async () => {
    setReadFileBytes(async () => new Uint8Array());
    const r = await sandboxToolRegistry.emit_artifact(makeDeps(), {
      path: "out/x.pdf",
      filename: "report.pdf",
    });
    expect((parse(r) as { error: string }).error).toBe("artifact_empty");
  });

  it("content_mime_mismatch when the bytes don't match the declared MIME", async () => {
    setReadFileBytes(async () => new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]));
    const r = await sandboxToolRegistry.emit_artifact(makeDeps(), {
      path: "out/x.pdf",
      filename: "report.pdf",
    });
    expect((parse(r) as { error: string }).error).toBe("content_mime_mismatch");
  });
});

describe("app_verify escape guard", () => {
  it("returns escape_guard when refusalFor refuses the start_cmd", async () => {
    const r = await sandboxToolRegistry.app_verify(
      makeDeps({ refusalFor: () => "refused: nope" }),
      { request_path: "/api/health" } as never,
    );
    expect((parse(r) as { error: string }).error).toBe("escape_guard");
  });
});

import {
  clearSandboxReadCounter,
  escapeGuardRefusal,
} from "@/services/agents/sdk/mcp-sandbox";

describe("live SDK closure == registry — byte-identical, all verbs", () => {
  let seq = 0;
  const TENANT = "t-test";
  const REPO = "acme/app";

  async function pair(opts?: { repo_root?: string; slack_post_blocked?: boolean }) {
    const run_id = `parity-run-${++seq}`;
    clearSandboxReadCounter(run_id);
    const ctx = {
      tenant_id: TENANT,
      run_id,
      repo_full_name: REPO,
      ...opts,
    };
    const server = await mcpSandbox(ctx);
    const root = opts?.repo_root ?? "/home/user/repo";
    const STRICT = opts?.repo_root != null && opts.repo_root !== "/home/user/repo";
    const reads = { n: 0 };
    const views = { n: 0 };
    const deps: SandboxToolDeps = {
      getSandboxId: async () => "sb-test-id",
      root,
      refusalFor: STRICT ? (cmd) => escapeGuardRefusal(cmd, root) : () => null,
      run_id,
      bumpRead: () => ++reads.n,
      bumpView: () => ++views.n,
      tenant_id: TENANT,
      slack_post_blocked: opts?.slack_post_blocked,
    };
    return {
      run_id,
      deps,
      closure: (name: string, args: unknown) =>
        getHandler(server, name)(args) as Promise<{ content: Array<{ text: string }> }>,
      reg: <K extends keyof typeof sandboxToolRegistry>(
        name: K,
        args: Parameters<(typeof sandboxToolRegistry)[K]>[1],
      ) => sandboxToolRegistry[name](deps, args as never),
    };
  }

  async function expectByteIdentical(
    name: keyof typeof sandboxToolRegistry,
    args: unknown,
    opts?: { repo_root?: string; slack_post_blocked?: boolean },
  ) {
    const p = await pair(opts);
    const reg = await p.reg(name, args as never);
    const clo = await p.closure(name, args);
    expect(clo.content[0].text).toBe(reg.content[0].text);
    return { reg, clo };
  }

  it("write_file (success)", async () => {
    await expectByteIdentical("write_file", { path: "src/a.ts", content: "// a" });
  });

  it("read_file (success under cap)", async () => {
    setReadFile(async () => "hello world");
    await expectByteIdentical("read_file", { path: "a.ts" });
  });

  it("read_file (byte-cap truncation)", async () => {
    setReadFile(async () => "z".repeat(9000));
    await expectByteIdentical("read_file", { path: "big.ts" });
  });

  it("read_file (READ_COUNT_CAP fires identically on the 25th read)", async () => {
    setReadFile(async () => "x");
    const p = await pair();
    let clo: { content: Array<{ text: string }> } | undefined;
    let reg: { content: Array<{ text: string }> } | undefined;
    for (let i = 0; i < 25; i++) {
      clo = await p.closure("read_file", { path: "a.ts" });
      reg = await p.reg("read_file", { path: "a.ts" });
    }
    expect(clo!.content[0].text).toBe(reg!.content[0].text);
    expect((JSON.parse(clo!.content[0].text) as { error: string }).error).toBe(
      "read_cap_exceeded",
    );
  });

  it("run_bash (success, no refusal)", async () => {
    await expectByteIdentical("run_bash", { command: "ls", timeout_seconds: 60 });
  });

  it("run_bash (STRICT_ISOLATION refusal — refusalFor non-null)", async () => {
    const { clo } = await expectByteIdentical(
      "run_bash",
      { command: "cat /etc/passwd", timeout_seconds: 60 },
      { repo_root: "/home/user/wt-x" },
    );
    expect((JSON.parse(clo.content[0].text) as { error: string }).error).toBe("escape_guard");
  });

  it("run_tests (default npm test)", async () => {
    await expectByteIdentical("run_tests", {});
  });

  it("run_tests (STRICT_ISOLATION refusal)", async () => {
    const { clo } = await expectByteIdentical(
      "run_tests",
      { command: "cd ../wt-other && npm test", timeout_seconds: 120 },
      { repo_root: "/home/user/wt-x" },
    );
    expect((JSON.parse(clo.content[0].text) as { error: string }).error).toBe("escape_guard");
  });

  it("git_diff (success)", async () => {
    execMockImpl.mockResolvedValue({ stdout: "DIFF", stderr: "", exit_code: 0, ms: 5 });
    await expectByteIdentical("git_diff", {});
    execMockImpl.mockReset();
    execMockImpl.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0, ms: 1 });
  });

  it("git_status (success)", async () => {
    execMockImpl.mockResolvedValue({ stdout: " M f", stderr: "", exit_code: 0, ms: 2 });
    await expectByteIdentical("git_status", {});
    execMockImpl.mockReset();
    execMockImpl.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0, ms: 1 });
  });

  it("view (success + 1-indexed numbering)", async () => {
    setReadFile(async () => "a\nb\nc");
    await expectByteIdentical("view", { path: "f.ts" });
  });

  it("view (VIEW_COUNT_CAP fires identically on the 25th view)", async () => {
    setReadFile(async () => "x");
    const p = await pair();
    let clo: { content: Array<{ text: string }> } | undefined;
    let reg: { content: Array<{ text: string }> } | undefined;
    for (let i = 0; i < 25; i++) {
      clo = await p.closure("view", { path: "f.ts" });
      reg = await p.reg("view", { path: "f.ts" });
    }
    expect(clo!.content[0].text).toBe(reg!.content[0].text);
    expect((JSON.parse(clo!.content[0].text) as { error: string }).error).toBe(
      "view_cap_exceeded",
    );
  });

  it("str_replace (no_match)", async () => {
    setReadFile(async () => "alpha");
    await expectByteIdentical("str_replace", { path: "f.ts", old_str: "zzz", new_str: "x" });
  });

  it("str_replace (exactly-one match success)", async () => {
    setReadFile(async () => "keep foo keep");
    await expectByteIdentical("str_replace", { path: "f.ts", old_str: "foo", new_str: "bar" });
  });

  it("create (already_exists — probe reports exists)", async () => {
    execMockImpl.mockResolvedValue({ stdout: "exists", stderr: "", exit_code: 0, ms: 1 });
    await expectByteIdentical("create", { path: "n.ts", file_text: "x" });
    execMockImpl.mockReset();
    execMockImpl.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0, ms: 1 });
  });

  it("create (existence_probe_failed — indeterminate probe)", async () => {
    execMockImpl.mockResolvedValue({ stdout: "???", stderr: "", exit_code: 0, ms: 1 });
    await expectByteIdentical("create", { path: "n.ts", file_text: "x" });
    execMockImpl.mockReset();
    execMockImpl.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0, ms: 1 });
  });

  it("insert (success)", async () => {
    setReadFile(async () => "a\nb\nc");
    await expectByteIdentical("insert", { path: "f.ts", insert_line: 1, new_str: "X" });
  });

  it("stage_preview (server-managed artifact metadata only)", async () => {
    const { reg } = await expectByteIdentical("stage_preview", {
      title: "Preview",
      summary: "Ready",
      html: '<div title="quotes">नमस्ते</div>',
    });
    expect(JSON.parse(reg.content[0].text)).toMatchObject({
      state: "html_preview_ready",
      preview_id: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(reg.content[0].text).not.toContain("<div");
  });

  it("emit_artifact (validation gate: filename_invalid)", async () => {
    await expectByteIdentical("emit_artifact", { path: "out/x.pdf", filename: "///" });
  });

  it("emit_artifact (validation gate: mime_not_allowed)", async () => {
    await expectByteIdentical("emit_artifact", { path: "out/x.txt", filename: "r.txt" });
  });

  it("emit_artifact (validation gate: artifact_empty)", async () => {
    setReadFileBytes(async () => new Uint8Array());
    await expectByteIdentical("emit_artifact", { path: "out/x.pdf", filename: "r.pdf" });
  });

  it("emit_artifact (validation gate: content_mime_mismatch)", async () => {
    setReadFileBytes(async () => new Uint8Array([0, 1, 2, 3, 4]));
    await expectByteIdentical("emit_artifact", { path: "out/x.pdf", filename: "r.pdf" });
  });

  it("emit_artifact (SUCCESS disposition — full side-effect path, no slack)", async () => {
    setReadFileBytes(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]));
    const { reg } = await expectByteIdentical("emit_artifact", {
      path: "out/x.pdf",
      filename: "report.pdf",
    });
    expect(JSON.parse(reg.content[0].text)).toMatchObject({
      artifact_id: "artifact-xyz",
      slack_ok: false,
    });
  });

  it("emit_artifact (SLACK-BLOCKED disposition — channel_id set but slack_post_blocked)", async () => {
    setReadFileBytes(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]));
    const { reg } = await expectByteIdentical(
      "emit_artifact",
      { path: "out/x.pdf", filename: "report.pdf", channel_id: "C123" },
      { slack_post_blocked: true },
    );
    expect(JSON.parse(reg.content[0].text).slack_ok).toBe(false);
    expect(mocks.uploadFileToThread).not.toHaveBeenCalled();
  });

  it("app_verify (STRICT_ISOLATION refusal on start_cmd)", async () => {
    const { clo } = await expectByteIdentical(
      "app_verify",
      { request_path: "/api/health", start_cmd: "cd /etc && npm run dev" },
      { repo_root: "/home/user/wt-x" },
    );
    expect((JSON.parse(clo.content[0].text) as { error: string }).error).toBe("escape_guard");
  });

  it("app_verify (success — booted + asserted)", async () => {
    execMockImpl.mockResolvedValue({
      stdout: "VERIFY_BOOTED=1\nVERIFY_STATUS=200\n",
      stderr: "",
      exit_code: 0,
      ms: 42,
    });
    await expectByteIdentical("app_verify", {
      request_path: "/api/health",
      expected_status: 200,
      port: 3000,
      host: "127.0.0.1",
      boot_timeout_seconds: 60,
    });
    execMockImpl.mockReset();
    execMockImpl.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0, ms: 1 });
  });

  it("run_typecheck (probe picks the script, runs it in the run's root)", async () => {
    execMockImpl.mockImplementation(async (_id: string, cmd: string) =>
      cmd.includes("node -e")
        ? {
            stdout: `__TCPROBE__${JSON.stringify({
              root: { script: "typecheck", tsconfig: true, tsc: true },
              changed_ts: 1,
              pkgs: [],
            })}`,
            stderr: "",
            exit_code: 0,
            ms: 1,
          }
        : { stdout: "", stderr: "", exit_code: 0, ms: 5 },
    );
    const { reg } = await expectByteIdentical("run_typecheck", {}, { repo_root: "/home/user/wt-x" });
    expect(JSON.parse(reg.content[0].text)).toMatchObject({
      status: "passed",
      command: "npm run typecheck --silent",
    });
    const ran = execMockImpl.mock.calls.map((c) => c[1] as string);
    expect(ran.some((c) => c.includes("cd '/home/user/wt-x' && npm run typecheck --silent"))).toBe(true);
    execMockImpl.mockReset();
    execMockImpl.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0, ms: 1 });
  });
});
