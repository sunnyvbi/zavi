import { describe, it, expect } from "vitest";
import {
  extractTestReceipt,
  classifyVerify,
  verifyFromTraces,
  isRunTestsTool,
  type VerifyReceipt,
} from "../engineer-verify-receipt";

describe("isRunTestsTool", () => {
  it("matches bare + namespaced + aliased names, anchored to the end", () => {
    expect(isRunTestsTool("run_tests")).toBe(true);
    expect(isRunTestsTool("sandbox__run_tests")).toBe(true);
    expect(isRunTestsTool("mcp__sandbox__run_tests")).toBe(true);
    expect(isRunTestsTool("run_tests_foo")).toBe(false);
    expect(isRunTestsTool("run_bash")).toBe(false);
    expect(isRunTestsTool(null)).toBe(false);
  });
});

describe("extractTestReceipt — per-call classification", () => {
  it("returns null for non-run_tests tools", () => {
    expect(extractTestReceipt("run_bash", '{"exit_code":0}', false)).toBeNull();
    expect(extractTestReceipt("github__open_pr", "{}", false)).toBeNull();
  });

  it("exit 0 → passed (JSON-string result)", () => {
    const r = extractTestReceipt("run_tests", '{"stdout":"ok","stderr":"","exit_code":0,"ms":12}', false);
    expect(r).toMatchObject({ status: "passed", exit_code: 0, attempted: true });
  });

  it("exit 0 → passed (object result)", () => {
    const r = extractTestReceipt("sandbox__run_tests", { stdout: "ok", stderr: "", exit_code: 0 }, false);
    expect(r?.status).toBe("passed");
  });

  it("passed requires exit 0 ONLY — never inferred from text", () => {
    const r = extractTestReceipt(
      "run_tests",
      '{"stdout":"All tests passed! 42 passing","stderr":"","exit_code":1}',
      false,
    );
    expect(r?.status).toBe("failed");
  });

  it("non-zero exit with anchored mongo setup failure → couldnt_run + reason", () => {
    const r = extractTestReceipt(
      "run_tests",
      '{"stdout":"","stderr":"MongoMemoryServer: Instance failed to start because a library is missing","exit_code":1}',
      false,
    );
    expect(r?.status).toBe("couldnt_run");
    expect(r?.reason).toBeTruthy();
  });

  it("non-zero exit with glibc mismatch → couldnt_run", () => {
    const r = extractTestReceipt(
      "run_tests",
      '{"stdout":"","stderr":"/lib/x86_64: version `GLIBC_2.38 not found","exit_code":127}',
      false,
    );
    expect(r?.status).toBe("couldnt_run");
  });

  it("non-zero exit with rollup native-binding error → couldnt_run", () => {
    const r = extractTestReceipt(
      "run_tests",
      '{"stdout":"","stderr":"Error: Cannot find module @rollup/rollup-linux-x64-gnu","exit_code":1}',
      false,
    );
    expect(r?.status).toBe("couldnt_run");
  });

  it("ambiguous non-zero (real test failure) → failed, NOT couldnt_run", () => {
    const r = extractTestReceipt(
      "run_tests",
      '{"stdout":"1 failing\\n  expected 2 to equal 3","stderr":"","exit_code":1}',
      false,
    );
    expect(r?.status).toBe("failed");
  });

  it("bare ENOENT / unavailable substring is NOT couldnt_run (honesty-pessimistic → failed)", () => {
    const r = extractTestReceipt(
      "run_tests",
      '{"stdout":"","stderr":"sh: some-cli: command not found (ENOENT); service unavailable","exit_code":1}',
      false,
    );
    expect(r?.status).toBe("failed");
  });

  it("tool error with no exit_code → failed (never passed, never couldnt_run on bare error)", () => {
    const r = extractTestReceipt("run_tests", '{"error":"sandbox_exec_failed"}', true);
    expect(r?.status).toBe("failed");
    expect(r?.exit_code).toBeNull();
  });

  it("tool error whose message carries an anchored mongo setup failure → couldnt_run", () => {
    const r = extractTestReceipt(
      "run_tests",
      "mongodb-memory-server failed to download binary in sandbox",
      true,
    );
    expect(r?.status).toBe("couldnt_run");
  });

  it("non-JSON success content with exit implied but unparseable → failed", () => {
    const r = extractTestReceipt("run_tests", "tests ran, some output", false);
    expect(r?.status).toBe("failed");
    expect(r?.exit_code).toBeNull();
  });
});

describe("classifyVerify — aggregation precedence", () => {
  const rc = (status: VerifyReceipt["status"], reason?: string): VerifyReceipt => ({
    tool: "run_tests",
    attempted: true,
    exit_code: status === "passed" ? 0 : 1,
    status,
    reason,
  });

  it("no run_tests → not_run", () => {
    expect(classifyVerify([])).toEqual({ status: "not_run", attempts: 0 });
  });

  it("any failed dominates couldnt_run + passed", () => {
    expect(classifyVerify([rc("passed"), rc("couldnt_run"), rc("failed", "boom")])).toMatchObject({
      status: "failed",
      reason: "boom",
    });
  });

  it("couldnt_run dominates passed (no failed present)", () => {
    expect(classifyVerify([rc("passed"), rc("couldnt_run", "mongo")])).toMatchObject({
      status: "couldnt_run",
      reason: "mongo",
    });
  });

  it("all passed → passed", () => {
    expect(classifyVerify([rc("passed"), rc("passed")])).toMatchObject({ status: "passed", attempts: 2 });
  });
});

describe("verifyFromTraces", () => {
  it("collects test_receipt off traces and classifies, ignoring null/absent", () => {
    const agg = verifyFromTraces([
      null,
      { test_receipt: null },
      { test_receipt: { tool: "run_tests", attempted: true, exit_code: 0, status: "passed" } },
      { test_receipt: { tool: "run_tests", attempted: true, exit_code: 1, status: "failed" } },
    ]);
    expect(agg.status).toBe("failed");
    expect(agg.attempts).toBe(2);
  });

  it("no receipts anywhere → not_run", () => {
    expect(verifyFromTraces([null, {}, { test_receipt: null }]).status).toBe("not_run");
  });
});

describe("no test suite at all is couldn't-run (Build starter ships no test script)", () => {
  const run = (stdout: string, stderr: string, exit_code = 1) =>
    extractTestReceipt("run_tests", JSON.stringify({ exit_code, stdout, stderr }), false, { command: "npm test" });
  it("npm's missing test script", () => {
    expect(run("", 'npm error Missing script: "test"')?.status).toBe("couldnt_run");
    expect(run("", "npm ERR! Missing script: test")?.status).toBe("couldnt_run");
  });
  it("the npm-init placeholder (its own lifecycle echo)", () => {
    expect(run('\n> app@1.0.0 test\n> echo "Error: no test specified" && exit 1\n\nError: no test specified', "")?.status).toBe("couldnt_run");
  });
  it("the placeholder command text inside a real test's output is still failed", () => {
    expect(run('FAIL gen.test.ts\n  expected script: > echo "Error: no test specified" && exit 1', "")?.status).toBe("failed");
  });
  it("a real test that throws 'no test specified' is still failed", () => {
    expect(run("FAIL src/a.test.ts\n  Error: no test specified\n    at Object.<anonymous>", "")?.status).toBe("failed");
  });
  it("a real failing test is still failed", () => {
    expect(run("FAIL src/a.test.ts\n  ✕ adds (3 ms)", "")?.status).toBe("failed");
  });
});

describe("extractTestReceipt reads MCP content blocks (the live run_tests shape)", () => {
  const blocks = (exit_code: number, stdout = "", stderr = "") => [
    { type: "text", text: JSON.stringify({ stdout, stderr, exit_code, ms: 5 }) },
  ];

  it("a green suite is passed, not the old honesty-pessimistic failed", () => {
    const r = extractTestReceipt("mcp__sandbox__run_tests", blocks(0, "Tests 3 passed"), false);
    expect(r?.status).toBe("passed");
    expect(r?.exit_code).toBe(0);
  });

  it("a red suite is failed with its real exit code", () => {
    const r = extractTestReceipt("mcp__sandbox__run_tests", blocks(1, "FAIL src/a.test.ts"), false);
    expect(r?.status).toBe("failed");
    expect(r?.exit_code).toBe(1);
  });

  it("a piped suite that exits 0 is couldnt_run: the exit is tail's", () => {
    const r = extractTestReceipt("mcp__sandbox__run_tests", blocks(0, "FAIL src/a.test.ts"), false, {
      command: "npm test 2>&1 | tail -40",
    });
    expect(r?.status).toBe("couldnt_run");
    expect(
      extractTestReceipt("mcp__sandbox__run_tests", blocks(0), false, { command: "npm test || true" })?.status,
    ).toBe("couldnt_run");
    expect(
      extractTestReceipt("mcp__sandbox__run_tests", blocks(0), false, { command: "npm test" })?.status,
    ).toBe("passed");
  });

  it("npx refusing to fetch an uninstalled runner is couldnt_run", () => {
    const stderr = 'npm error npx canceled due to missing packages and no YES option: ["vitest@3"]';
    expect(extractTestReceipt("mcp__sandbox__run_tests", blocks(1, "", stderr), false)?.status).toBe(
      "couldnt_run",
    );
  });
});
