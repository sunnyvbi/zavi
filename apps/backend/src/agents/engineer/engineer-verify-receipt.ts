
import {
  parseFailingTestNames,
  type FailingTest,
  type TestNameParse,
} from "./engineer-test-names";
import { unwrapMcpContent } from "./mcp-content";
import { mayMaskExitCode } from "./typecheck-receipt";

export type VerifyStatus = "passed" | "failed" | "couldnt_run" | "not_run";

export type VerifyReceipt = {
  tool: string;
  attempted: true;
  exit_code: number | null;
  status: Exclude<VerifyStatus, "not_run">;
  reason?: string;
  failing_tests?: FailingTest[];
  names_confidence?: TestNameParse["confidence"];
  command?: string;
};

export type VerifyAggregate = {
  status: VerifyStatus;
  reason?: string;
  attempts: number;
  failing_tests?: FailingTest[];
  names_confidence?: TestNameParse["confidence"];
  command?: string;
};

const RUN_TESTS_NAME = /(?:^|__)run_tests$/;

export function isRunTestsTool(name: unknown): boolean {
  return typeof name === "string" && RUN_TESTS_NAME.test(name);
}

const RUNTIME_UNAVAILABLE: readonly RegExp[] = [
  /mongodb-memory-server|MongoMemoryServer|mongodb-binaries/i,
  /(?:failed to (?:download|start)|could not (?:download|start)|instance failed to start)[^\n]*mongo/i,
  /mongo[^\n]*(?:instance failed to start|failed to start|download failed)/i,
  /\bGLIBC_[0-9.]+['"` ]*not found|version `GLIBC|libssl|libcrypto[^\n]*(?:not found|version)/i,
  /Host version [^\n]*!=[^\n]*binary version/i,
  /Cannot find module[^\n]*rollup[^\n]*native/i,
  /Cannot find (?:native )?binding|@rollup\/rollup-[a-z0-9-]+/i,
  /npm (?:ERR!|error) Missing script:\s*"?test"?/i,
  /npm (?:ERR!|error) npx canceled due to missing packages/i,
  /(?:^|\n)> \S+ test\r?\n> echo "Error: no test specified" && exit 1(?:\r?\n|$)/i,
];

function matchesRuntimeUnavailable(text: string): { hit: boolean; reason?: string } {
  for (const re of RUNTIME_UNAVAILABLE) {
    const m = text.match(re);
    if (m) return { hit: true, reason: m[0].slice(0, 160) };
  }
  return { hit: false };
}

type RunTestsResult = {
  stdout?: unknown;
  stderr?: unknown;
  exit_code?: unknown;
};

function extractCommand(rawInput: unknown): string | undefined {
  if (rawInput == null) return undefined;
  let obj: Record<string, unknown> | null = null;
  if (typeof rawInput === "string") {
    try {
      const j = JSON.parse(rawInput);
      if (j && typeof j === "object") obj = j as Record<string, unknown>;
    } catch {
      const m = rawInput.match(/"(?:command|cmd|script)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) return m[1].replace(/\\"/g, '"').slice(0, 500);
      return undefined;
    }
  } else if (typeof rawInput === "object") {
    obj = rawInput as Record<string, unknown>;
  }
  if (!obj) return undefined;
  for (const key of ["command", "cmd", "script"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim().slice(0, 500);
  }
  return undefined;
}

export function extractTestReceipt(
  toolName: string,
  rawContent: unknown,
  isError: boolean,
  rawInput?: unknown,
): VerifyReceipt | null {
  if (!isRunTestsTool(toolName)) return null;
  const command = extractCommand(rawInput);

  rawContent = unwrapMcpContent(rawContent);
  let parsed: RunTestsResult | null = null;
  let text = "";
  if (typeof rawContent === "string") {
    text = rawContent;
    try {
      const j = JSON.parse(rawContent);
      if (j && typeof j === "object") parsed = j as RunTestsResult;
    } catch {
    }
  } else if (rawContent && typeof rawContent === "object") {
    parsed = rawContent as RunTestsResult;
    try {
      text = JSON.stringify(rawContent);
    } catch {
      text = String(rawContent);
    }
  } else {
    text = String(rawContent ?? "");
  }

  const exit_code =
    parsed && typeof parsed.exit_code === "number" ? parsed.exit_code : null;

  const haystack =
    parsed && (typeof parsed.stdout === "string" || typeof parsed.stderr === "string")
      ? `${typeof parsed.stdout === "string" ? parsed.stdout : ""}\n${
          typeof parsed.stderr === "string" ? parsed.stderr : ""
        }`
      : text;

  if (exit_code === 0 && command && mayMaskExitCode(command)) {
    return {
      tool: toolName,
      attempted: true,
      exit_code: 0,
      status: "couldnt_run",
      reason: "exit code masked by a pipe or ||",
      command,
    };
  }
  if (exit_code === 0) {
    return { tool: toolName, attempted: true, exit_code: 0, status: "passed", ...(command ? { command } : {}) };
  }

  const rt = matchesRuntimeUnavailable(haystack);
  if (rt.hit) {
    return {
      tool: toolName,
      attempted: true,
      exit_code,
      status: "couldnt_run",
      reason: rt.reason,
      ...(command ? { command } : {}),
    };
  }

  const reason = isError && exit_code === null ? "sandbox run_tests errored" : undefined;

  const parse = parseFailingTestNames(haystack);
  return {
    tool: toolName,
    attempted: true,
    exit_code,
    status: "failed",
    reason,
    ...(command ? { command } : {}),
    failing_tests: parse.names,
    names_confidence: parse.confidence,
  };
}

export function classifyVerify(receipts: readonly VerifyReceipt[]): VerifyAggregate {
  const attempts = receipts.length;
  if (attempts === 0) return { status: "not_run", attempts: 0 };

  const failed = receipts.find((r) => r.status === "failed");
  if (failed) {
    const failures = receipts.filter((r) => r.status === "failed");
    const command = [...failures].reverse().find((r) => r.command)?.command;
    const anyUnparsed = failures.some((r) => r.names_confidence !== "high");
    const union = Array.from(
      new Set(failures.flatMap((r) => r.failing_tests ?? [])),
    ).sort();
    return {
      status: "failed",
      reason: failed.reason,
      attempts,
      ...(command ? { command } : {}),
      failing_tests: anyUnparsed ? [] : union,
      names_confidence: anyUnparsed || union.length === 0 ? "none" : "high",
    };
  }

  const couldnt = receipts.find((r) => r.status === "couldnt_run");
  if (couldnt) return { status: "couldnt_run", reason: couldnt.reason, attempts };

  const passed = receipts.some((r) => r.status === "passed");
  if (passed) return { status: "passed", attempts };

  return { status: "not_run", attempts };
}

export function verifyFromTraces(
  traces: ReadonlyArray<{ test_receipt?: VerifyReceipt | null } | null | undefined>,
): VerifyAggregate {
  const receipts: VerifyReceipt[] = [];
  for (const t of traces) {
    if (t && t.test_receipt) receipts.push(t.test_receipt);
  }
  return classifyVerify(receipts);
}
