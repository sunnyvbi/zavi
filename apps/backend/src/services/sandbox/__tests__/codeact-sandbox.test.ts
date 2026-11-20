import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

const createSandbox = vi.fn(async () => "sbx_codeact_test");
const destroySandbox = vi.fn(async () => undefined);
const wipeEnv = vi.fn(async () => undefined);
const writes: Array<{ path: string; content: string }> = [];
const writeFile = vi.fn(async (_id: string, path: string, content: string) => {
  writes.push({ path, content });
});
const execCommands: string[] = [];
const execCommand = vi.fn(async (_id: string, command: string) => {
  execCommands.push(command);
  return { stdout: "", stderr: "", exit_code: 0, ms: 1 };
});

vi.mock("../e2b-client", () => ({
  createSandbox: (...a: unknown[]) => createSandbox(...(a as [])),
  destroySandbox: (...a: unknown[]) => destroySandbox(...(a as [])),
  wipeEnv: (...a: unknown[]) => wipeEnv(...(a as [])),
  writeFile: (...a: unknown[]) => (writeFile as unknown as (...x: unknown[]) => Promise<void>)(...a),
  execCommand: (...a: unknown[]) => (execCommand as unknown as (...x: unknown[]) => Promise<unknown>)(...a),
}));

import {
  buildCodeActRunner,
  runCodeActPython,
  PYTHON_IMPORT_DENYLIST,
  FIXED_RUNNER_CMD,
  CODEACT_RUNNER_PATH,
  CODEACT_USER_CODE_PATH,
  CODEACT_INPUT_PATH,
} from "../codeact-sandbox";

beforeEach(() => {
  createSandbox.mockClear();
  destroySandbox.mockClear();
  wipeEnv.mockClear();
  writeFile.mockClear();
  execCommand.mockClear();
  writes.length = 0;
  execCommands.length = 0;
});

describe("codeact-sandbox · no-egress + no-secret posture (security)", () => {
  it("creates the sandbox with allow_internet_access=false", async () => {
    execCommand.mockImplementation(async (_id: string, command: string) => {
      execCommands.push(command);
      if (command.startsWith("head -c")) {
        return { stdout: JSON.stringify({ ok: true, result: 42 }), stderr: "", exit_code: 0, ms: 1 };
      }
      return { stdout: "CODEACT_DONE", stderr: "", exit_code: 0, ms: 1 };
    });
    await runCodeActPython({
      tenant_id: "t1",
      input: { rows: [], reads: [] },
      python_code: "result = 1",
    });
    expect(createSandbox).toHaveBeenCalledTimes(1);
    const arg = (createSandbox.mock.calls[0] as unknown[])[0] as { allow_internet_access?: boolean };
    expect(arg.allow_internet_access).toBe(false);
  });

  it("wipes env before exec (no PRAXIS_ENV_FILE secrets reachable)", async () => {
    execCommand.mockImplementation(async (_id: string, command: string) => {
      execCommands.push(command);
      if (command.startsWith("head -c")) {
        return { stdout: JSON.stringify({ ok: true, result: null }), stderr: "", exit_code: 0, ms: 1 };
      }
      return { stdout: "CODEACT_DONE", stderr: "", exit_code: 0, ms: 1 };
    });
    await runCodeActPython({
      tenant_id: "t1",
      input: { rows: [], reads: [] },
      python_code: "result = None",
    });
    expect(wipeEnv).toHaveBeenCalledTimes(1);
  });

  it("never writes OPERATOR_DB_URL / a connection string into the sandbox", async () => {
    execCommand.mockImplementation(async (_id: string, command: string) => {
      if (command.startsWith("head -c")) {
        return { stdout: JSON.stringify({ ok: true, result: null }), stderr: "", exit_code: 0, ms: 1 };
      }
      return { stdout: "CODEACT_DONE", stderr: "", exit_code: 0, ms: 1 };
    });
    await runCodeActPython({
      tenant_id: "t1",
      input: { rows: [{ index: 0, row_count: 1, truncated: false, rows: [{ a: 1 }] }], reads: [] },
      python_code: "result = sum(r['a'] for r in rows[0]['rows'])",
    });
    const allWritten = writes.map((w) => w.content).join("\n");
    expect(allWritten).not.toMatch(/postgres:\/\//);
    expect(allWritten).not.toMatch(/OPERATOR_DB_URL/);
    expect(allWritten).not.toMatch(/password/i);
  });

  it("runs the FIXED runner command — never a model-supplied shell string", async () => {
    execCommand.mockImplementation(async (_id: string, command: string) => {
      execCommands.push(command);
      if (command.startsWith("head -c")) {
        return { stdout: JSON.stringify({ ok: true, result: null }), stderr: "", exit_code: 0, ms: 1 };
      }
      return { stdout: "CODEACT_DONE", stderr: "", exit_code: 0, ms: 1 };
    });
    await runCodeActPython({
      tenant_id: "t1",
      input: { rows: [], reads: [] },
      python_code: "; rm -rf / # this is just text written to a file",
    });
    expect(execCommands).toContain(FIXED_RUNNER_CMD);
    expect(execCommands.some((c) => c.includes("rm -rf"))).toBe(false);
    const userCodeWrite = writes.find((w) => w.path === CODEACT_USER_CODE_PATH);
    expect(userCodeWrite?.content).toContain("rm -rf");
  });

  it("always destroys the ephemeral sandbox, even when exec throws", async () => {
    execCommand.mockImplementation(async () => {
      throw new Error("sandbox boom");
    });
    await runCodeActPython({
      tenant_id: "t1",
      input: { rows: [], reads: [] },
      python_code: "result = 1",
    }).catch(() => undefined);
    expect(destroySandbox).toHaveBeenCalledTimes(1);
  });
});

describe("codeact-sandbox · runner source contains the denylist", () => {
  it("denylist covers the egress + process surface", () => {
    for (const m of ["os", "subprocess", "socket", "requests", "urllib"]) {
      expect(PYTHON_IMPORT_DENYLIST).toContain(m);
    }
  });
  it("runner strips __import__ + open + eval/exec from builtins", () => {
    const src = buildCodeActRunner();
    expect(src).toContain("__import__");
    expect(src).toContain("'open'");
    expect(src).toContain("_DenyFinder");
  });
});

describe("codeact-sandbox · denylist enforced by REAL python3", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeact-test-"));
    writeFileSync(join(dir, "runner.py"), buildCodeActRunner());
    writeFileSync(
      join(dir, "input.json"),
      JSON.stringify({ rows: [{ index: 0, rows: [{ a: 1 }, { a: 2 }, { a: 3 }] }], reads: [] }),
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function runUser(code: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const userPath = join(dir, "user.py");
    const outPath = join(dir, "out.json");
    writeFileSync(userPath, code);
    try {
      await execFileP("python3", ["-I", join(dir, "runner.py"), userPath, join(dir, "input.json"), outPath]);
    } catch {
    }
    return JSON.parse(readFileSync(outPath, "utf8"));
  }

  it("blocks `import os`", async () => {
    const out = await runUser("import os\nresult = 'leaked'");
    expect(out.ok).toBe(false);
    expect(out.error).toBe("ImportError");
  });

  it("blocks `import socket`", async () => {
    const out = await runUser("import socket\nresult = 'leaked'");
    expect(out.ok).toBe(false);
    expect(out.error).toBe("ImportError");
  });

  it("blocks `import requests`", async () => {
    const out = await runUser("import requests\nresult = 'leaked'");
    expect(out.ok).toBe(false);
    expect(out.error).toBe("ImportError");
  });

  it("blocks `from urllib.request import urlopen`", async () => {
    const out = await runUser("from urllib.request import urlopen\nresult = 'leaked'");
    expect(out.ok).toBe(false);
    expect(out.error).toBe("ImportError");
  });

  it("blocks open() — no file access escape", async () => {
    const out = await runUser("f = open('/etc/passwd')\nresult = 'leaked'");
    expect(out.ok).toBe(false);
    expect(out.error).toBe("NameError");
  });

  it("allows legit pure compute over the provided rows", async () => {
    const out = await runUser("result = {'sum': sum(r['a'] for r in rows[0]['rows'])}");
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ sum: 6 });
  });
});

describe("codeact-sandbox · fixed paths", () => {
  it("FIXED_RUNNER_CMD points at the fixed runner + input + user-code paths", () => {
    expect(FIXED_RUNNER_CMD).toContain(CODEACT_RUNNER_PATH);
    expect(FIXED_RUNNER_CMD).toContain(CODEACT_USER_CODE_PATH);
    expect(FIXED_RUNNER_CMD).toContain(CODEACT_INPUT_PATH);
    expect(FIXED_RUNNER_CMD.startsWith("python3 -I")).toBe(true);
  });
});
