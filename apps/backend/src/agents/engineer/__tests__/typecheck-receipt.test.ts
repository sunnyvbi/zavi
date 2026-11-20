
import { describe, it, expect } from "vitest";
import {
  extractTypecheckReceipt,
  isTypecheckCommand,
  classifyTypecheck,
  typecheckFromTraces,
  type TypecheckReceipt,
} from "../typecheck-receipt";

const res = (exit: number) => JSON.stringify({ stdout: "", stderr: "", exit_code: exit });

describe("isTypecheckCommand", () => {
  it("matches tsc --noEmit and package-manager typecheck scripts", () => {
    for (const c of [
      "npx tsc --noEmit -p tsconfig.json",
      "tsc --noEmit",
      "npm run typecheck",
      "pnpm typecheck",
      "yarn typecheck",
      "turbo run typecheck",
      "nx typecheck backend",
      "npm run type-check",
    ]) {
      expect(isTypecheckCommand(c), c).toBe(true);
    }
  });

  it("does NOT match builds / tests / bare tsc-that-emits", () => {
    for (const c of ["tsc -p tsconfig.json", "npm run build", "npm test", "npm run lint", "node dist/x.js"]) {
      expect(isTypecheckCommand(c), c).toBe(false);
    }
  });
});

describe("extractTypecheckReceipt", () => {
  it("null for a non-run_bash tool", () => {
    expect(extractTypecheckReceipt("run_tests", res(0), false, '{"command":"tsc --noEmit"}')).toBeNull();
    expect(extractTypecheckReceipt("github__open_pr", res(0), false, "{}")).toBeNull();
  });

  it("null for a run_bash command that isn't a typecheck", () => {
    expect(extractTypecheckReceipt("run_bash", res(0), false, '{"command":"npm run build"}')).toBeNull();
  });

  it("passed on exit 0 for a typecheck command", () => {
    const r = extractTypecheckReceipt("run_bash", res(0), false, '{"command":"npm run typecheck"}');
    expect(r?.status).toBe("passed");
    expect(r?.exit_code).toBe(0);
  });

  it("failed on a non-zero exit for a typecheck command (a red tsc)", () => {
    const r = extractTypecheckReceipt("sandbox__run_bash", res(2), false, '{"command":"tsc --noEmit"}');
    expect(r?.status).toBe("failed");
    expect(r?.exit_code).toBe(2);
  });

  it("a CHAINED command's non-zero exit is couldnt_run, NOT failed (unattributable)", () => {
    for (const cmd of [
      "npm run lint && npm run typecheck",
      "npm run typecheck && npm test",
      "npm run typecheck; npm run lint",
      "npm run typecheck || echo failed",
      "npx tsc --noEmit | tee tsc.log",
    ]) {
      const r = extractTypecheckReceipt("run_bash", res(1), false, JSON.stringify({ command: cmd }));
      expect(r?.status, cmd).toBe("couldnt_run");
    }
  });

  it("a CHAINED command that exits 0 still PASSES (every stage was green)", () => {
    const r = extractTypecheckReceipt(
      "run_bash",
      res(0),
      false,
      '{"command":"npm run lint && npm run typecheck"}',
    );
    expect(r?.status).toBe("passed");
  });

  it("an UNCHAINED red typecheck still fails (the true positive survives)", () => {
    const r = extractTypecheckReceipt("run_bash", res(2), false, '{"command":"npx tsc --noEmit"}');
    expect(r?.status).toBe("failed");
  });

  it("couldnt_run when the exit code is unparseable (never a fabricated failure)", () => {
    const r = extractTypecheckReceipt("run_bash", '{"error":"sandbox_exec_failed"}', true, '{"command":"npm run typecheck"}');
    expect(r?.status).toBe("couldnt_run");
  });

  it("reads the command out of a truncated input preview string", () => {
    const r = extractTypecheckReceipt("run_bash", res(1), false, '{"command":"tsc --noEmit -p tsconfig.json", "cwd":"/repo"');
    expect(r?.status).toBe("failed");
    expect(r?.command).toContain("tsc --noEmit");
  });
});

describe("classifyTypecheck / typecheckFromTraces", () => {
  const rc = (status: TypecheckReceipt["status"]): TypecheckReceipt => ({
    tool: "run_bash",
    attempted: true,
    exit_code: status === "passed" ? 0 : status === "failed" ? 1 : null,
    status,
  });

  it("not_run when no typecheck was seen", () => {
    expect(classifyTypecheck([]).status).toBe("not_run");
    expect(typecheckFromTraces([null, {}, { typecheck_receipt: null }]).status).toBe("not_run");
  });

  it("any failed → failed (a red typecheck anywhere blocks)", () => {
    expect(classifyTypecheck([rc("passed"), rc("failed")]).status).toBe("failed");
  });

  it("passed when a clean run and no failure", () => {
    expect(classifyTypecheck([rc("passed")]).status).toBe("passed");
  });

  it("couldnt_run when only ambiguous results", () => {
    expect(classifyTypecheck([rc("couldnt_run")]).status).toBe("couldnt_run");
  });

  it("collects typecheck_receipt off traces", () => {
    const agg = typecheckFromTraces([
      { typecheck_receipt: rc("passed") },
      { typecheck_receipt: rc("failed") },
    ]);
    expect(agg.status).toBe("failed");
    expect(agg.attempts).toBe(2);
  });
});

describe("couldn't-run, not failed or passed (Build starter has no typecheck script)", () => {
  const bash = (command: string, exit_code: number, stdout = "", stderr = "") =>
    extractTypecheckReceipt("run_bash", JSON.stringify({ exit_code, stdout, stderr }), false, { command });

  it("a missing typecheck script never ran the compiler", () => {
    const r = bash("npm run typecheck", 1, "", 'npm error Missing script: "typecheck"');
    expect(r?.status).toBe("couldnt_run");
    expect(classifyTypecheck([r!, bash("npx tsc --noEmit", 0)!]).status).toBe("passed");
    expect(classifyTypecheck([bash("npx tsc --noEmit", 1, "error TS2322")!, bash("npx tsc --noEmit -p src/one", 0)!]).status).toBe("failed");
    expect(classifyTypecheck([bash("npx tsc --noEmit", 1, "error TS2322")!, bash("npx tsc  --noEmit", 0)!]).status).toBe("passed");
  });

  it("--if-present chained with another script's banner is never a typecheck pass", () => {
    expect(
      bash("npm run typecheck --if-present && npm test", 0, "\n> company-app@0.1.0 test\n> vitest run\n")?.status,
    ).toBe("couldnt_run");
    expect(bash("npm run typecheck --if-present", 0, "\n> company-app@0.1.0 test\n")?.status).toBe("couldnt_run");
  });

  it("--if-present that ran nothing is not a pass; one that ran the script is", () => {
    expect(bash("npm run typecheck --if-present", 0, "")?.status).toBe("couldnt_run");
    expect(
      bash("npm run typecheck --if-present", 0, "\n> company-app@0.1.0 typecheck\n> tsc --noEmit\n")?.status,
    ).toBe("passed");
  });

  it("a multi-line or backgrounded command is chained: its exit is not the typecheck's", () => {
    expect(bash("npm run typecheck --if-present\ntrue", 0, "\n> app@1.0.0 typecheck\n> tsc --noEmit\n")?.status).toBe(
      "couldnt_run",
    );
    expect(bash("npx tsc --noEmit\nfalse", 1)?.status).toBe("couldnt_run");
    expect(bash("npx tsc --noEmit & wait", 1)?.status).toBe("couldnt_run");
  });

  it("a redirection is not a chain: a red typecheck with 2>&1 is still failed", () => {
    expect(bash("npx tsc --noEmit 2>&1", 1, "error TS1005")?.status).toBe("failed");
    expect(bash("npx tsc --noEmit &> tc.log", 1)?.status).toBe("failed");
  });

  it("a real non-zero typecheck is still failed", () => {
    expect(bash("npx tsc --noEmit", 2, "src/a.ts(1,1): error TS1005")?.status).toBe("failed");
  });
});

describe("MCP content blocks (the real stored tool-result shape)", () => {
  const blocks = (exit_code: number, stdout = "", stderr = "") => [
    { type: "text", text: JSON.stringify({ stdout, stderr, exit_code }) },
  ];
  const tc = (command: string, exit: number, stdout = "", stderr = "") =>
    extractTypecheckReceipt("mcp__sandbox__run_bash", blocks(exit, stdout, stderr), false, { command });

  it("reads the exit code inside the text block", () => {
    expect(tc("npm run typecheck", 2, "src/x.tsx(1,1): error TS2375")?.status).toBe("failed");
    expect(tc("cd apps/admin && npx tsc --noEmit", 0)?.status).toBe("passed");
  });

  it("a piped typecheck that exits 0 is couldnt_run, even with errors printed", () => {
    const r = tc(
      "cd apps/admin && npx --offline tsc --noEmit 2>&1 | tail -60",
      0,
      "src/x.tsx(1,1): error TS2375: Type is not assignable",
    );
    expect(r?.status).toBe("couldnt_run");
    expect(tc("npx tsc --noEmit | tail -5 # pipefail", 0)?.status).toBe("couldnt_run");
    expect(tc("set -o pipefail; bash -c 'npx tsc --noEmit | tail'", 0)?.status).toBe("couldnt_run");
    expect(tc("npx tsc --noEmit |& tail -5", 0)?.status).toBe("couldnt_run");
    expect(tc("npx tsc --noEmit || true", 0)?.status).toBe("couldnt_run");
    expect(tc("npm run lint && npx tsc --noEmit", 0)?.status).toBe("passed");
  });

  it("the npm squat `tsc` package exiting 0 is couldnt_run, never passed", () => {
    expect(tc("npx tsc --noEmit", 0, "This is not the tsc command you are looking for")?.status).toBe(
      "couldnt_run",
    );
  });

  it("npx refusing to fetch an uninstalled tsc is couldnt_run, not failed", () => {
    const stderr = 'npm error npx canceled due to missing packages and no YES option: ["tsc@2.0.4"]';
    expect(tc("npx tsc --noEmit", 1, "", stderr)?.status).toBe("couldnt_run");
  });
});
