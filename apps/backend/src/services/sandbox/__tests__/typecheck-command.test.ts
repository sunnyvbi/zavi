
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTypecheckProbeCommand,
  parseTypecheckProbe,
  parseTypecheckRun,
  runTypecheckInSandbox,
  selectTypecheckCommand,
  type TypecheckProbe,
} from "../typecheck-command";

const none = { script: null, tsconfig: false, tsc: false };

describe("selectTypecheckCommand", () => {
  it("uses the changed package's typecheck script", () => {
    const probe: TypecheckProbe = {
      root: { script: "typecheck", tsconfig: true, tsc: true },
      changed_ts: 2,
      pkgs: [{ dir: "apps/web", count: 2, script: "type-check", tsconfig: true, tsc: false }],
    };
    expect(selectTypecheckCommand(probe)).toEqual({
      command: "(cd 'apps/web' && npm run type-check --silent)",
      unchecked: [],
    });
  });

  it("falls back to the installed tsc with the package's tsconfig", () => {
    const probe: TypecheckProbe = {
      root: { script: null, tsconfig: true, tsc: true },
      changed_ts: 1,
      pkgs: [{ dir: "apps/api", count: 1, script: null, tsconfig: true, tsc: false }],
    };
    expect(selectTypecheckCommand(probe)).toEqual({
      command: "'node_modules/.bin/tsc' --noEmit -p 'apps/api/tsconfig.json'",
      unchecked: [],
    });
  });

  it("uses the root when no TypeScript file changed", () => {
    expect(
      selectTypecheckCommand({ root: { script: "typecheck", tsconfig: true, tsc: true }, changed_ts: 0, pkgs: [] }),
    ).toEqual({ command: "npm run typecheck --silent", unchecked: [] });
  });

  it("runs every changed package, most-changed first", () => {
    const out = selectTypecheckCommand({
      root: none,
      changed_ts: 3,
      pkgs: [
        { dir: "a", count: 1, script: "typecheck", tsconfig: true, tsc: false },
        { dir: "b", count: 2, script: "typecheck", tsconfig: true, tsc: false },
      ],
    });
    expect(out.command).toBe("(cd 'b' && npm run typecheck --silent) && (cd 'a' && npm run typecheck --silent)");
  });

  it("couldnt_run without a script and without an installed tsc", () => {
    const out = selectTypecheckCommand({
      root: { script: null, tsconfig: true, tsc: false },
      changed_ts: 0,
      pkgs: [],
    });
    expect(out.command).toBeNull();
    expect((out as { reason: string }).reason).toMatch(/no installed tsc/);
  });

  it("never picks npx and never pipes", () => {
    const out = selectTypecheckCommand({
      root: { script: null, tsconfig: true, tsc: true },
      changed_ts: 0,
      pkgs: [],
    });
    expect(out.command).not.toMatch(/npx|\|/);
  });
});

describe("parseTypecheckRun", () => {
  const cmd = "npm run typecheck --silent";

  it("passed on exit 0 with no errors", () => {
    expect(parseTypecheckRun(cmd, { stdout: "", stderr: "", exit_code: 0 })).toMatchObject({
      status: "passed",
      error_count: 0,
      errors: [],
    });
  });

  it("failed, normalising plain and pretty tsc lines", () => {
    const stdout = [
      "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "\u001b[96msrc/b.ts\u001b[0m:10:2 - error TS2307: Cannot find module 'x'.",
      "Found 2 errors in 2 files.",
    ].join("\n");
    const r = parseTypecheckRun(cmd, { stdout, stderr: "", exit_code: 2 });
    expect(r.status).toBe("failed");
    expect(r.error_count).toBe(2);
    expect(r.errors).toEqual([
      "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/b.ts(10,2): error TS2307: Cannot find module 'x'.",
    ]);
  });

  it("keeps the first 30 errors and flags truncation", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `src/a.ts(${i + 1},1): error TS1005: ';' expected.`);
    const r = parseTypecheckRun(cmd, { stdout: lines.join("\n"), stderr: "", exit_code: 2 });
    expect(r.error_count).toBe(40);
    expect(r.errors).toHaveLength(30);
    expect(r.truncated).toBe(true);
  });

  it("a timeout after tsc already printed errors is still failed", () => {
    const r = parseTypecheckRun(cmd, {
      stdout: "src/a.ts(1,1): error TS1005: ';' expected.",
      stderr: "",
      exit_code: -1,
      timed_out: true,
    });
    expect(r.status).toBe("failed");
  });

  it("a timeout or a missing script is couldnt_run, not failed", () => {
    expect(parseTypecheckRun(cmd, { stdout: "", stderr: "", exit_code: -1, timed_out: true }).status).toBe(
      "couldnt_run",
    );
    expect(
      parseTypecheckRun(cmd, { stdout: "", stderr: "npm error Missing script: \"typecheck\"", exit_code: 1 }).status,
    ).toBe("couldnt_run");
  });

  it("red with no tsc-shaped line is failed, with the output tail as evidence", () => {
    const r = parseTypecheckRun(cmd, { stdout: "", stderr: "vue-tsc exploded\nsomething broke", exit_code: 1 });
    expect(r.status).toBe("failed");
    expect(r.errors).toEqual(["vue-tsc exploded", "something broke"]);
  });
});

describe("runTypecheckInSandbox", () => {
  it("couldnt_run when the probe fails, without running anything else", async () => {
    const exec = vi.fn(async () => ({ stdout: "node: not found", stderr: "", exit_code: 127, ms: 1 }));
    const r = await runTypecheckInSandbox({ sandbox_id: "sb", root: "/home/user/wt-1", exec: exec as never });
    expect(r.status).toBe("couldnt_run");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("runs the picked command at the root with a 180s budget; a sandbox throw is couldnt_run", async () => {
    const probeOut = `__TCPROBE__${JSON.stringify({ root: { script: "typecheck", tsconfig: true, tsc: true }, changed_ts: 1, pkgs: [] })}`;
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: probeOut, stderr: "", exit_code: 0, ms: 1 })
      .mockRejectedValueOnce(new Error("sandbox gone"));
    const r = await runTypecheckInSandbox({ sandbox_id: "sb", root: "/home/user/wt-1", exec: exec as never });
    expect(exec.mock.calls[1][1]).toBe("export npm_config_yes=false; cd '/home/user/wt-1' && npm run typecheck --silent");
    expect(exec.mock.calls[1][2]).toBe(180_000);
    expect(r).toMatchObject({ status: "couldnt_run", command: "npm run typecheck --silent" });
  });
});

describe("a pass that skipped a changed package", () => {
  it("is couldnt_run, not passed", async () => {
    const probeOut = `__TCPROBE__${JSON.stringify({
      root: { script: null, tsconfig: false, tsc: false },
      changed_ts: 2,
      pkgs: [
        { dir: "a", count: 1, script: "typecheck", tsconfig: true, tsc: false },
        { dir: "b", count: 1, script: null, tsconfig: false, tsc: false },
      ],
    })}`;
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: probeOut, stderr: "", exit_code: 0, ms: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exit_code: 0, ms: 1 });
    const r = await runTypecheckInSandbox({ sandbox_id: "sb", root: "/r", exec: exec as never });
    expect(r.status).toBe("couldnt_run");
    expect(r.reason).toContain("b");
  });
});

describe("the repo probe (real node + git)", () => {
  it("maps changed .ts files to their package and reads its script", () => {
    const root = mkdtempSync(join(tmpdir(), "tcprobe-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "r", scripts: {} }));
    writeFileSync(join(root, "tsconfig.json"), "{}");
    mkdirSync(join(root, "apps/api/src"), { recursive: true });
    writeFileSync(
      join(root, "apps/api/package.json"),
      JSON.stringify({ name: "api", scripts: { typecheck: "tsc --noEmit" } }),
    );
    writeFileSync(join(root, "apps/api/src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "README.md"), "x\n");

    const out = execFileSync("bash", ["-c", buildTypecheckProbeCommand(root)], { encoding: "utf8" });
    const probe = parseTypecheckProbe(out);
    expect(probe).toMatchObject({
      root: { script: null, tsconfig: true, tsc: false },
      changed_ts: 1,
      pkgs: [{ dir: "apps/api", count: 1, script: "typecheck" }],
    });
    expect(selectTypecheckCommand(probe!).command).toBe("(cd 'apps/api' && npm run typecheck --silent)");
  });
});
