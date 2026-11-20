
import { unwrapMcpContent } from "./mcp-content";

export type TypecheckStatus = "passed" | "failed" | "couldnt_run" | "not_run";

export type TypecheckReceipt = {
  tool: string;
  attempted: true;
  exit_code: number | null;
  status: Exclude<TypecheckStatus, "not_run">;
  command?: string;
  platform?: boolean;
  error_count?: number;
  errors?: string[];
};

export type TypecheckAggregate = {
  status: TypecheckStatus;
  attempts: number;
  command?: string;
  error_count?: number;
  errors?: string[];
};

const RECEIPT_ERRORS = 10;

const RUN_BASH_NAME = /(?:^|__)run_bash$/;

export function isRunBashTool(name: unknown): boolean {
  return typeof name === "string" && RUN_BASH_NAME.test(name);
}

const RUN_TYPECHECK_NAME = /(?:^|__)run_typecheck$/;

export function isRunTypecheckTool(name: unknown): boolean {
  return typeof name === "string" && RUN_TYPECHECK_NAME.test(name);
}

function platformTypecheckReceipt(toolName: string, rawContent: unknown): TypecheckReceipt {
  let parsed: Record<string, unknown> | null = null;
  const content = unwrapMcpContent(rawContent);
  if (typeof content === "string") {
    try {
      const j = JSON.parse(content);
      if (j && typeof j === "object") parsed = j as Record<string, unknown>;
    } catch {
    }
  } else if (content && typeof content === "object") {
    parsed = content as Record<string, unknown>;
  }
  const status =
    parsed && (parsed.status === "passed" || parsed.status === "failed")
      ? parsed.status
      : "couldnt_run";
  const exit_code = parsed && typeof parsed.exit_code === "number" ? parsed.exit_code : null;
  const command = parsed && typeof parsed.command === "string" ? parsed.command : undefined;
  const receipt: TypecheckReceipt = {
    tool: toolName,
    attempted: true,
    exit_code,
    status,
    platform: true,
    ...(command ? { command } : {}),
  };
  if (status === "failed" && parsed) {
    receipt.error_count = typeof parsed.error_count === "number" ? parsed.error_count : 0;
    receipt.errors = Array.isArray(parsed.errors)
      ? parsed.errors.filter((e): e is string => typeof e === "string").slice(0, RECEIPT_ERRORS)
      : [];
  }
  return receipt;
}

export function isTypecheckCommand(cmd: string): boolean {
  const c = cmd.toLowerCase();
  if (/\btsc\b/.test(c) && /--noemit\b/.test(c)) return true;
  if (
    /(?:^|[\s&|;(])(?:npm(?:\s+run|\s+exec)?|pnpm(?:\s+run)?|yarn(?:\s+run)?|npx|turbo(?:\s+run)?|nx(?:\s+run)?)\s+[^\n&|;]*\btype-?check\b/.test(
      c,
    )
  ) {
    return true;
  }
  return false;
}

function isChainedCommand(cmd: string): boolean {
  return /(?:&&|\|\||;|(?<!\|)\|(?!\|)|[\r\n]|(?<![&>])&(?![&>\d]))/.test(cmd.trim());
}

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

function resultText(rawContent: unknown): string {
  let parsed: { stdout?: unknown; stderr?: unknown } | null = null;
  if (typeof rawContent === "string") {
    try {
      const j = JSON.parse(rawContent);
      if (j && typeof j === "object") parsed = j as { stdout?: unknown; stderr?: unknown };
      else return rawContent;
    } catch {
      return rawContent;
    }
  } else if (rawContent && typeof rawContent === "object") {
    parsed = rawContent as { stdout?: unknown; stderr?: unknown };
  }
  if (!parsed) return "";
  return `${typeof parsed.stdout === "string" ? parsed.stdout : ""}\n${
    typeof parsed.stderr === "string" ? parsed.stderr : ""
  }`;
}

export function mayMaskExitCode(cmd: string): boolean {
  return /\|/.test(cmd);
}

const FAKE_TSC = /not the tsc command you are looking for/i;

const MISSING_SCRIPT =
  /npm (?:ERR!|error) Missing script:|npm (?:ERR!|error) npx canceled due to missing packages/i;
const RAN_TYPECHECK_SCRIPT = /(?:^|\n)> \S+ type-?check\b/i;

function parseExitCode(rawContent: unknown): number | null {
  let parsed: { exit_code?: unknown } | null = null;
  if (typeof rawContent === "string") {
    try {
      const j = JSON.parse(rawContent);
      if (j && typeof j === "object") parsed = j as { exit_code?: unknown };
    } catch {
    }
  } else if (rawContent && typeof rawContent === "object") {
    parsed = rawContent as { exit_code?: unknown };
  }
  return parsed && typeof parsed.exit_code === "number" ? parsed.exit_code : null;
}

export function extractTypecheckReceipt(
  toolName: string,
  rawContent: unknown,
  _isError: boolean,
  rawInput?: unknown,
): TypecheckReceipt | null {
  if (isRunTypecheckTool(toolName)) {
    return _isError
      ? { tool: toolName, attempted: true, exit_code: null, status: "couldnt_run", platform: true }
      : platformTypecheckReceipt(toolName, rawContent);
  }
  if (!isRunBashTool(toolName)) return null;
  const command = extractCommand(rawInput);
  if (!command || !isTypecheckCommand(command)) return null;

  const content = unwrapMcpContent(rawContent);
  const exit_code = parseExitCode(content);
  const text = resultText(content);
  if (exit_code === 0) {
    if (mayMaskExitCode(command) || FAKE_TSC.test(text)) {
      return { tool: toolName, attempted: true, exit_code: 0, status: "couldnt_run", command };
    }
    if (
      /--if-present\b/.test(command) &&
      (isChainedCommand(command) || !RAN_TYPECHECK_SCRIPT.test(text))
    ) {
      return { tool: toolName, attempted: true, exit_code: 0, status: "couldnt_run", command };
    }
    return { tool: toolName, attempted: true, exit_code: 0, status: "passed", command };
  }
  if (typeof exit_code === "number" && exit_code > 0 && MISSING_SCRIPT.test(text)) {
    return { tool: toolName, attempted: true, exit_code, status: "couldnt_run", command };
  }
  if (typeof exit_code === "number" && exit_code > 0) {
    if (isChainedCommand(command)) {
      return { tool: toolName, attempted: true, exit_code, status: "couldnt_run", command };
    }
    return { tool: toolName, attempted: true, exit_code, status: "failed", command };
  }
  return { tool: toolName, attempted: true, exit_code: null, status: "couldnt_run", command };
}

export function classifyTypecheck(
  receipts: readonly TypecheckReceipt[],
): TypecheckAggregate {
  const attempts = receipts.length;
  if (attempts === 0) return { status: "not_run", attempts: 0 };
  const lastPlatform = [...receipts]
    .reverse()
    .find((r) => r.platform === true && (r.status === "passed" || r.status === "failed"));
  if (lastPlatform) {
    return {
      status: lastPlatform.status,
      attempts,
      ...(lastPlatform.command ? { command: lastPlatform.command } : {}),
      ...(lastPlatform.status === "failed"
        ? { error_count: lastPlatform.error_count ?? 0, errors: lastPlatform.errors ?? [] }
        : {}),
    };
  }
  const norm = (c: string | undefined) => (c ?? "").replace(/\s+/g, " ").trim();
  const failed = receipts.find(
    (r, i) =>
      r.status === "failed" &&
      !(
        r.command &&
        receipts
          .slice(i + 1)
          .some((later) => later.status === "passed" && norm(later.command) === norm(r.command))
      ),
  );
  if (failed) {
    return { status: "failed", attempts, ...(failed.command ? { command: failed.command } : {}) };
  }
  const passed = receipts.find((r) => r.status === "passed");
  if (passed) {
    return { status: "passed", attempts, ...(passed.command ? { command: passed.command } : {}) };
  }
  return { status: "couldnt_run", attempts };
}

export function typecheckReceiptsFromTraces(
  traces: ReadonlyArray<{ typecheck_receipt?: TypecheckReceipt | null } | null | undefined>,
): TypecheckReceipt[] {
  const receipts: TypecheckReceipt[] = [];
  for (const t of traces) {
    if (t && t.typecheck_receipt) receipts.push(t.typecheck_receipt);
  }
  return receipts;
}

export function typecheckFromTraces(
  traces: ReadonlyArray<{ typecheck_receipt?: TypecheckReceipt | null } | null | undefined>,
): TypecheckAggregate {
  return classifyTypecheck(typecheckReceiptsFromTraces(traces));
}

const TS_SOURCE = /\.(?:ts|tsx|mts|cts)$/;

const EDIT_TOOL = /(?:^|__)(?:write_file|str_replace|create|insert|run_bash)$/;

type ReceiptTrace = { name?: string; typecheck_receipt?: TypecheckReceipt | null } | null | undefined;

export async function typecheckVerdictWithFinalCheck(opts: {
  traces: ReadonlyArray<ReceiptTrace>;
  files: ReadonlyArray<{ path: string; action: string }>;
  runFinal: () => Promise<unknown>;
  pipelineRun?: boolean;
}): Promise<{ verdict: TypecheckAggregate; ranFinal: boolean }> {
  const traces = opts.traces.filter((t): t is NonNullable<ReceiptTrace> => !!t);
  const receipts = typecheckReceiptsFromTraces(traces);
  const modelOnly = receipts.filter((r) => r.platform !== true);
  if (opts.pipelineRun) return { verdict: classifyTypecheck(receipts), ranFinal: false };
  let lastPlatform = -1;
  traces.forEach((t, i) => {
    if (t.typecheck_receipt?.platform === true) lastPlatform = i;
  });
  const editedAfter =
    lastPlatform >= 0 &&
    traces.slice(lastPlatform + 1).some((t) => typeof t.name === "string" && EDIT_TOOL.test(t.name));
  const needsFinal =
    (lastPlatform < 0 || editedAfter) &&
    opts.files.some((f) => f.action !== "delete" && TS_SOURCE.test(f.path));
  if (!needsFinal) return { verdict: classifyTypecheck(receipts), ranFinal: false };
  let result: unknown = null;
  let threw = false;
  try {
    result = await opts.runFinal();
  } catch {
    threw = true;
  }
  const final = extractTypecheckReceipt("run_typecheck", result, threw);
  const attempts = receipts.length + 1;
  if (final && (final.status === "passed" || final.status === "failed")) {
    return { verdict: { ...classifyTypecheck([...modelOnly, final]), attempts }, ranFinal: true };
  }
  const model = classifyTypecheck(modelOnly);
  return {
    verdict: model.status === "failed" ? { ...model, attempts } : { status: "couldnt_run", attempts },
    ranFinal: true,
  };
}
