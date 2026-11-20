
import {
  execCommand,
  readFile as e2bReadFile,
  readFileBytes as e2bReadFileBytes,
  writeFile as e2bWriteFile,
} from "@/services/sandbox/e2b-client";
import { serviceClient } from "@/services/supabase";
import { uploadFileToThread } from "@/services/tools/slack/upload_file";
import { assertRunTenantOwnership } from "@/services/reports/guard";
import { artifactRunBinding } from "@/services/reports/run-binding";
import { trackDocumentDelivered, trackMediaGenerated } from "@/services/analytics/action-events";
import { ExpectedToolError } from "@/services/tools/types";
import {
  buildAppVerifyScript,
  parseAppVerifyOutput,
  validateAppVerifyInput,
  APP_VERIFY_BOOT_TIMEOUT_DEFAULT_S,
  APP_VERIFY_EXEC_HEADROOM_S,
  type AppVerifyInput,
} from "@/services/tools/sandbox/app-verify";
import { stageHtmlPreviewArtifact } from "@/services/agents/html-preview-artifacts";
import { runTypecheckInSandbox } from "@/services/sandbox/typecheck-command";

export const SANDBOX_TOOL_NAMES = [
  "write_file",
  "read_file",
  "run_bash",
  "run_tests",
  "git_diff",
  "git_status",
  "view",
  "str_replace",
  "create",
  "insert",
  "stage_preview",
  "emit_artifact",
  "app_verify",
  "run_typecheck",
] as const;

export type SandboxToolName = (typeof SANDBOX_TOOL_NAMES)[number];

const REPO_ROOT = "/home/user/repo";
const READ_BYTE_CAP = 8 * 1024;
const READ_COUNT_CAP = 24;
const VIEW_BYTE_CAP = 8 * 1024;
const VIEW_COUNT_CAP = 24;

export const RUN_BASH_OUTPUT_CAP = 16 * 1024;
export const RUN_TESTS_OUTPUT_CAP = 24 * 1024;
export const GIT_DIFF_OVERALL_CAP = 20 * 1024;
export const GIT_DIFF_SINGLE_FILE_CAP = 4 * GIT_DIFF_OVERALL_CAP;

export function execOutputCapsEnabled(): boolean {
  return process.env.SANDBOX_EXEC_OUTPUT_CAPS !== "0";
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(s: string): string {
  return (s ?? "").replace(ANSI_RE, "");
}

export type CappedField = {
  text: string;
  truncated: boolean;
  original_bytes?: number;
  kept_bytes?: number;
  errors?: string[];
};

export function capExecOutput(raw: string, capBytes: number, hint?: string): CappedField {
  const cleaned = stripAnsi(raw);
  const bytes = Buffer.byteLength(cleaned, "utf8");
  if (bytes <= capBytes) return { text: cleaned, truncated: false };
  const MARKER_RESERVE = 256;
  const budget = Math.max(256, capBytes - MARKER_RESERVE);
  const headBudget = Math.floor(budget * 0.6);
  const tailBudget = budget - headBudget;
  const buf = Buffer.from(cleaned, "utf8");
  const head = buf.subarray(0, headBudget).toString("utf8");
  const tail = buf.subarray(buf.length - tailBudget).toString("utf8");
  const dropped = bytes - headBudget - tailBudget;
  const marker = `\n…[truncated ${dropped} bytes of ${bytes} — ${hint ?? "rerun a narrower command (pipe through grep/head/tail) to see the rest"}]…\n`;
  return { text: head + marker + tail, truncated: true, original_bytes: bytes, kept_bytes: headBudget + tailBudget };
}

const DIAG_MARKERS: RegExp[] = [
  /\berror TS\d+\b/i,
  /^\s*(FAIL|FAILED)\b/,
  /\b\d+ (failing|failed)\b/i,
  /^\s*(✕|✗|×|✖)\s/,
  /\bAssertionError\b|\bassert(ion)? (failed|error)\b/i,
  /^\s*[-+]?\s*(Expected|Received)\b/,
  /^\s*\d+:\d+\s+(error|warning)\b/,
  /^\s*(error|ERROR)\b/,
  /^\s+at\s+.+:\d+:\d+\)?$/,
  /^\s*❯\s+.+:\d+:\d+/,
  /^\s*(panic:|Traceback \(most recent call last\))/,
  /^\s*\S+Error:/,
];

function isDiagLine(line: string): boolean {
  for (const re of DIAG_MARKERS) if (re.test(line)) return true;
  return false;
}

export function extractDiagnostics(
  raw: string,
  capBytes: number,
  nonZeroExit: boolean,
): CappedField {
  const cleaned = stripAnsi(raw);
  const bytes = Buffer.byteLength(cleaned, "utf8");
  if (bytes <= capBytes) {
    const errs = cleaned
      .split("\n")
      .filter(isDiagLine)
      .map((l) => l.trim().slice(0, 400))
      .slice(0, 30);
    return { text: cleaned, truncated: false, ...(errs.length ? { errors: errs } : {}) };
  }

  const lines = cleaned.split("\n");
  const HEAD_LINES = 15;
  const TAIL_LINES = nonZeroExit ? 40 : 20;
  const CONTEXT = 3;

  const keep = new Array<boolean>(lines.length).fill(false);
  const errors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i < HEAD_LINES || i >= lines.length - TAIL_LINES) keep[i] = true;
    if (isDiagLine(lines[i])) {
      if (errors.length < 30) errors.push(lines[i].trim().slice(0, 400));
      for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) {
        keep[j] = true;
      }
    }
  }

  if (errors.length === 0) return capExecOutput(cleaned, capBytes);

  const PER_LINE_CAP = 2048;
  const capLine = (line: string): string => {
    if (Buffer.byteLength(line, "utf8") <= PER_LINE_CAP) return line;
    const b = Buffer.from(line, "utf8");
    const h = Math.floor(PER_LINE_CAP * 0.7);
    return b.subarray(0, h).toString("utf8") + "…[line truncated]…" + b.subarray(b.length - (PER_LINE_CAP - h)).toString("utf8");
  };

  const parts: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!keep[i]) {
      let j = i;
      while (j < lines.length && !keep[j]) j++;
      parts.push(`…[${j - i} lines omitted]…`);
      i = j;
      continue;
    }
    parts.push(capLine(lines[i]));
    i++;
  }
  const assembled = parts.join("\n");

  if (Buffer.byteLength(assembled, "utf8") > capBytes) {
    const errKeep = new Array<boolean>(lines.length).fill(false);
    for (let k = 0; k < lines.length; k++) {
      if (!isDiagLine(lines[k])) continue;
      for (let j = Math.max(0, k - CONTEXT); j <= Math.min(lines.length - 1, k + CONTEXT); j++) errKeep[j] = true;
    }
    const errOnly: string[] = [];
    for (let k = 0; k < lines.length; k++) if (errKeep[k]) errOnly.push(capLine(lines[k]));
    const capped = capExecOutput(errOnly.join("\n"), capBytes);
    return { ...capped, errors };
  }
  return {
    text: assembled,
    truncated: true,
    original_bytes: bytes,
    kept_bytes: Buffer.byteLength(assembled, "utf8"),
    errors,
  };
}

const EXEC_CAP_HINT =
  "Output was capped. Rerun a narrower command (pipe through grep/head/tail, or target a specific path) to see the omitted middle.";

export type GitDiffFileStatus = "added" | "deleted" | "renamed" | "modified";

export type StructuredGitDiffFile = {
  path: string;
  status: GitDiffFileStatus;
  truncated: boolean;
  diff: string;
};

export type StructuredGitDiff = {
  summary: string;
  files: StructuredGitDiffFile[];
  omitted: Array<{ path: string; approx_bytes: number }>;
  _truncated?: true;
  truncated?: { hint: string };
};

const GIT_DIFF_FILE_TRUNC_HINT =
  "this single file's diff exceeds the budget — re-call git_diff({path}) to see it in full";

export function gitUnquotePath(p: string): string {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = inner[++i];
    if (n === undefined) break;
    if (n >= "0" && n <= "7") {
      bytes.push(parseInt(inner.slice(i, i + 3), 8) & 0xff);
      i += 2;
    } else {
      const simple: Record<string, string> = { t: "\t", n: "\n", r: "\r", '"': '"', "\\": "\\" };
      bytes.push(...Buffer.from(simple[n] ?? n, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripDiffPathPrefix(p: string): string {
  const unquoted = gitUnquotePath(p);
  if (unquoted === "/dev/null") return "";
  return unquoted.replace(/^[ab]\//, "");
}

type RawDiffSection = { path: string; status: GitDiffFileStatus; body: string };

function finalizeDiffSection(lines: string[]): RawDiffSection {
  let status: GitDiffFileStatus = "modified";
  let plusPath = "";
  let minusPath = "";
  let renameTo = "";
  for (const l of lines) {
    if (l.startsWith("new file mode")) status = "added";
    else if (l.startsWith("deleted file mode")) status = "deleted";
    else if (l.startsWith("rename from ")) status = "renamed";
    else if (l.startsWith("rename to ")) renameTo = l.slice("rename to ".length).trim();
    else if (l.startsWith("+++ ")) plusPath = stripDiffPathPrefix(l.slice(4).trim());
    else if (l.startsWith("--- ")) minusPath = stripDiffPathPrefix(l.slice(4).trim());
  }
  const hm = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] ?? "");
  const headerOld = hm?.[1] ?? "";
  const headerNew = hm?.[2] ?? "";
  const path =
    status === "renamed"
      ? renameTo || headerNew
      : status === "deleted"
        ? minusPath || headerOld
        : plusPath || headerNew || minusPath || headerOld;
  return { path: path || "(unknown)", status, body: lines.join("\n") };
}

export function parseGitDiffSections(raw: string): RawDiffSection[] {
  const cleaned = stripAnsi(raw);
  if (!cleaned.trim()) return [];
  const out: RawDiffSection[] = [];
  let cur: string[] | null = null;
  for (const line of cleaned.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (cur) out.push(finalizeDiffSection(cur));
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) out.push(finalizeDiffSection(cur));
  return out;
}

function buildDiffSummary(sections: RawDiffSection[], totalBytes: number): string {
  let adds = 0;
  let dels = 0;
  for (const s of sections) {
    for (const l of s.body.split("\n")) {
      if (l.startsWith("+") && !l.startsWith("+++")) adds++;
      else if (l.startsWith("-") && !l.startsWith("---")) dels++;
    }
  }
  const n = sections.length;
  return `${n} file${n === 1 ? "" : "s"} changed, +${adds}/-${dels} (${totalBytes} bytes)`;
}

export function buildStructuredGitDiff(rawDiff: string, capBytes: number): StructuredGitDiff {
  const sections = parseGitDiffSections(rawDiff);
  const files: StructuredGitDiffFile[] = [];
  const omitted: Array<{ path: string; approx_bytes: number }> = [];
  let used = 0;
  let anyTruncated = false;
  let stopped = false;

  for (const sec of sections) {
    const bodyBytes = Buffer.byteLength(sec.body, "utf8");
    if (!stopped && used + bodyBytes <= capBytes) {
      files.push({ path: sec.path, status: sec.status, truncated: false, diff: sec.body });
      used += bodyBytes;
      continue;
    }
    if (!stopped && files.length === 0 && omitted.length === 0) {
      const capped = capExecOutput(sec.body, capBytes, GIT_DIFF_FILE_TRUNC_HINT);
      files.push({ path: sec.path, status: sec.status, truncated: true, diff: capped.text });
      used += Buffer.byteLength(capped.text, "utf8");
      anyTruncated = true;
      stopped = true;
      continue;
    }
    omitted.push({ path: sec.path, approx_bytes: bodyBytes });
    stopped = true;
  }

  const totalBytes = sections.reduce((n, s) => n + Buffer.byteLength(s.body, "utf8"), 0);
  const result: StructuredGitDiff = {
    summary: buildDiffSummary(sections, totalBytes),
    files,
    omitted,
  };
  if (anyTruncated || omitted.length > 0) {
    result._truncated = true;
    result.truncated = { hint: EXEC_CAP_HINT };
  }
  return result;
}

export const ARTIFACT_BUCKET = "agent-artifacts";
export const ARTIFACT_MAX_BYTES = 209715200;

const ARTIFACT_MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4",
  png: "image/png",
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function errorResult(error: string, message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error, message }) }],
    isError: true,
  };
}

function resolveSafe(root: string, rel: string): string {
  const norm = rel.replace(/^\/+/, "");
  if (norm.includes("..")) {
    throw new Error(`path traversal rejected: ${rel}`);
  }
  return `${root}/${norm}`;
}

export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function resolveStrict(root: string, rel: string): string {
  if (rel.startsWith("/")) {
    throw new Error(
      `path_must_be_repo_relative: got absolute path "${rel}". Use repo-relative paths like "apps/web/src/page.tsx".`,
    );
  }
  if (rel.includes("..")) {
    throw new Error(`path_traversal_rejected: ${rel}`);
  }
  return `${root}/${rel}`;
}

export function sanitizeArtifactFilename(raw: string): string {
  const base = (raw ?? "").split("/").pop() ?? "";
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned;
}

export function artifactMimeForFilename(filename: string): string | null {
  const ext = filename.includes(".") ? filename.split(".").pop()! : "";
  return ARTIFACT_MIME_BY_EXT[ext] ?? null;
}

export function artifactBytesMatchMime(bytes: Uint8Array, mime: string): boolean {
  if (mime === "application/pdf") {
    return (
      bytes.length >= 5 &&
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46 &&
      bytes[4] === 0x2d
    );
  }
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 0x03 &&
      bytes[3] === 0x04
    );
  }
  if (mime === "text/csv") {
    const probe = bytes.subarray(0, 8192);
    for (const b of probe) {
      if (b === 0x00) return false;
    }
    return true;
  }
  if (mime === "video/mp4") {
    return (
      bytes.length >= 8 &&
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    );
  }
  if (mime === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  return false;
}

export type SandboxToolDeps = {
  getSandboxId: () => Promise<string>;
  root: string;
  refusalFor: (command: string) => string | null;
  run_id: string;
  bumpRead: (run_id: string) => number;
  bumpView: (run_id: string) => number;
  tenant_id: string;
  slack_team_id?: string;
  slack_post_blocked?: boolean;
  capProfile?: "engineer" | "default";
  createReplacePristinePaths?: readonly string[];
};

type WriteFileArgs = { path: string; content: string };
type ReadFileArgs = { path: string };
type RunBashArgs = { command: string; timeout_seconds?: number };
type RunTestsArgs = { command?: string; timeout_seconds?: number };
type ViewArgs = { path: string; view_range?: [number, number] };
type StrReplaceArgs = { path: string; old_str: string; new_str: string };
type CreateArgs = { path: string; file_text: string };
type InsertArgs = { path: string; insert_line: number; new_str: string };
type StagePreviewArgs = {
  title: string;
  summary: string;
  html: string;
  design_spec?: unknown;
};
type EmitArtifactArgs = {
  path: string;
  filename: string;
  title?: string;
  channel_id?: string;
  thread_ts?: string;
};

async function write_file(deps: SandboxToolDeps, args: WriteFileArgs): Promise<ToolResult> {
  try {
    const sbId = await deps.getSandboxId();
    const fullPath = resolveSafe(deps.root, args.path);
    const dir = fullPath.split("/").slice(0, -1).join("/");
    if (dir) await execCommand(sbId, `mkdir -p ${shellSingleQuote(dir)}`, 10_000);
    await e2bWriteFile(sbId, fullPath, args.content);
    return textResult({ ok: true, path: args.path });
  } catch (e) {
    return errorResult("write_failed", (e as Error).message);
  }
}

async function read_file(deps: SandboxToolDeps, args: ReadFileArgs): Promise<ToolResult> {
  try {
    const reads = deps.bumpRead(deps.run_id);
    if (reads > READ_COUNT_CAP) {
      return errorResult(
        "read_cap_exceeded",
        `Read cap of ${READ_COUNT_CAP} per run reached. Summarize what you have and emit your envelope.`,
      );
    }
    const sbId = await deps.getSandboxId();
    const fullPath = resolveSafe(deps.root, args.path);
    const raw = await e2bReadFile(sbId, fullPath);
    if (raw.length <= READ_BYTE_CAP) {
      return textResult({ content: raw, truncated: false, reads_used: reads });
    }
    const truncatedBytes = raw.length - READ_BYTE_CAP;
    return textResult({
      content: `${raw.slice(0, READ_BYTE_CAP)}\n[truncated ${truncatedBytes} bytes]`,
      truncated: true,
      truncated_bytes: truncatedBytes,
      reads_used: reads,
    });
  } catch (e) {
    return errorResult("read_failed", (e as Error).message);
  }
}

export const NO_NPX_INSTALL = "export npm_config_yes=false; ";

async function run_bash(deps: SandboxToolDeps, args: RunBashArgs): Promise<ToolResult> {
  const refusal = deps.refusalFor(args.command);
  if (refusal) {
    return errorResult("escape_guard", refusal);
  }
  try {
    const sbId = await deps.getSandboxId();
    const r = await execCommand(
      sbId,
      `${NO_NPX_INSTALL}cd ${deps.root} && ${args.command}`,
      (args.timeout_seconds ?? 60) * 1000,
    );
    return textResult(capExecResult(r, RUN_BASH_OUTPUT_CAP, deps.capProfile));
  } catch (e) {
    return errorResult("exec_failed", (e as Error).message);
  }
}

export function capExecResult(
  r: { stdout: string; stderr: string; exit_code: number; ms: number },
  capBytes: number,
  capProfile?: "engineer" | "default",
): Record<string, unknown> {
  if (!execOutputCapsEnabled()) {
    return { stdout: r.stdout, stderr: r.stderr, exit_code: r.exit_code, ms: r.ms };
  }
  const semantic = capProfile === "engineer";
  const nonZero = r.exit_code !== 0;
  const out = semantic ? extractDiagnostics(r.stdout, capBytes, nonZero) : capExecOutput(r.stdout, capBytes);
  const err = semantic ? extractDiagnostics(r.stderr, capBytes, nonZero) : capExecOutput(r.stderr, capBytes);
  const payload: Record<string, unknown> = {
    stdout: out.text,
    stderr: err.text,
    exit_code: r.exit_code,
    ms: r.ms,
  };
  if (out.truncated || err.truncated) {
    payload._truncated = true;
    payload.truncated = {
      stdout: out.truncated ? { original_bytes: out.original_bytes, kept_bytes: out.kept_bytes } : false,
      stderr: err.truncated ? { original_bytes: err.original_bytes, kept_bytes: err.kept_bytes } : false,
      hint: EXEC_CAP_HINT,
    };
  }
  if (semantic) {
    const errs = [...(out.errors ?? []), ...(err.errors ?? [])].slice(0, 30);
    if (errs.length) payload._errors = errs;
  }
  return payload;
}

async function run_tests(deps: SandboxToolDeps, args: RunTestsArgs): Promise<ToolResult> {
  const refusal = deps.refusalFor(args.command ?? "npm test");
  if (refusal) {
    return errorResult("escape_guard", refusal);
  }
  try {
    const sbId = await deps.getSandboxId();
    const r = await execCommand(
      sbId,
      `${NO_NPX_INSTALL}cd ${deps.root} && ${args.command ?? "npm test"}`,
      (args.timeout_seconds ?? 120) * 1000,
    );
    return textResult(capExecResult(r, RUN_TESTS_OUTPUT_CAP, deps.capProfile));
  } catch (e) {
    return errorResult("tests_failed", (e as Error).message);
  }
}

async function run_typecheck(deps: SandboxToolDeps, _args: Record<string, never>): Promise<ToolResult> {
  try {
    const sbId = await deps.getSandboxId();
    const r = await runTypecheckInSandbox({ sandbox_id: sbId, root: deps.root });
    return textResult(r);
  } catch (e) {
    return errorResult("typecheck_failed_to_run", (e as Error).message);
  }
}

async function git_diff(deps: SandboxToolDeps, args: { path?: string }): Promise<ToolResult> {
  const path = args?.path;
  if (path !== undefined && (path.includes("..") || path.startsWith("/"))) {
    return errorResult(
      "path_rejected",
      `git_diff path must be repo-relative with no '..' or leading '/': ${path}`,
    );
  }
  try {
    const sbId = await deps.getSandboxId();
    const pathArg =
      path !== undefined ? ` -- ':(literal)${path.replace(/'/g, `'\\''`)}'` : "";
    const r = await execCommand(
      sbId,
      `cd ${deps.root} && git diff --no-ext-diff HEAD${pathArg}`,
      30_000,
    );
    if (!execOutputCapsEnabled()) {
      return textResult({ diff: r.stdout, ms: r.ms });
    }
    const cap = path !== undefined ? GIT_DIFF_SINGLE_FILE_CAP : GIT_DIFF_OVERALL_CAP;
    const structured = buildStructuredGitDiff(r.stdout, cap);
    return textResult({ ...structured, ms: r.ms });
  } catch (e) {
    return errorResult("git_diff_failed", (e as Error).message);
  }
}

async function git_status(deps: SandboxToolDeps, _args: Record<string, never>): Promise<ToolResult> {
  void _args;
  try {
    const sbId = await deps.getSandboxId();
    const r = await execCommand(
      sbId,
      `cd ${deps.root} && git status --porcelain=v1`,
      15_000,
    );
    return textResult({ status: r.stdout, ms: r.ms });
  } catch (e) {
    return errorResult("git_status_failed", (e as Error).message);
  }
}

async function view(deps: SandboxToolDeps, args: ViewArgs): Promise<ToolResult> {
  try {
    const views = deps.bumpView(deps.run_id);
    if (views > VIEW_COUNT_CAP) {
      return errorResult(
        "view_cap_exceeded",
        `View cap of ${VIEW_COUNT_CAP} per run reached. Summarize what you have and proceed.`,
      );
    }
    const sbId = await deps.getSandboxId();
    const fullPath = resolveStrict(deps.root, args.path);
    const raw = await e2bReadFile(sbId, fullPath);
    const allLines = raw.split("\n");
    let start = 1;
    let end = allLines.length;
    if (args.view_range) {
      [start, end] = args.view_range;
      if (start < 1) start = 1;
      if (end > allLines.length) end = allLines.length;
      if (start > end) {
        return errorResult(
          "view_range_invalid",
          `view_range start ${start} > end ${end}`,
        );
      }
    }
    const numbered = allLines
      .slice(start - 1, end)
      .map((line, i) => `${start + i}\t${line}`)
      .join("\n");
    if (numbered.length <= VIEW_BYTE_CAP) {
      return textResult({
        content: numbered,
        truncated: false,
        views_used: views,
        total_lines: allLines.length,
      });
    }
    const truncatedBytes = numbered.length - VIEW_BYTE_CAP;
    return textResult({
      content: `${numbered.slice(0, VIEW_BYTE_CAP)}\n[truncated ${truncatedBytes} bytes]`,
      truncated: true,
      truncated_bytes: truncatedBytes,
      views_used: views,
      total_lines: allLines.length,
    });
  } catch (e) {
    return errorResult("view_failed", (e as Error).message);
  }
}

async function str_replace(deps: SandboxToolDeps, args: StrReplaceArgs): Promise<ToolResult> {
  try {
    const sbId = await deps.getSandboxId();
    const fullPath = resolveStrict(deps.root, args.path);
    const raw = await e2bReadFile(sbId, fullPath);
    let count = 0;
    let pos = 0;
    while (true) {
      const idx = raw.indexOf(args.old_str, pos);
      if (idx === -1) break;
      count += 1;
      pos = idx + args.old_str.length;
      if (count > 1) break;
    }
    if (count === 0) {
      return errorResult(
        "no_match",
        `old_str not found in ${args.path}. Re-read the file with \`view\` and include 2-3 surrounding lines of context for uniqueness.`,
      );
    }
    if (count > 1) {
      return errorResult(
        "not_unique",
        `old_str matches multiple times in ${args.path}. Add surrounding context lines to make the match unique.`,
      );
    }
    const updated = raw.replace(args.old_str, args.new_str);
    await e2bWriteFile(sbId, fullPath, updated);
    return textResult({ ok: true, path: args.path });
  } catch (e) {
    return errorResult("str_replace_failed", (e as Error).message);
  }
}

function normalizeRepoPath(rel: string): string {
  return rel.replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/");
}

export function pristineProbeCommand(root: string, fullPath: string): string {
  const r = shellSingleQuote(root);
  const p = shellSingleQuote(fullPath);
  return (
    `if [ ! -e ${p} ] && [ ! -L ${p} ]; then echo missing; ` +
    `elif [ -f ${p} ] && [ ! -L ${p} ] && git -C ${r} ls-files --error-unmatch -- ${p} >/dev/null 2>&1 ` +
    `&& git -C ${r} diff --quiet HEAD -- ${p} >/dev/null 2>&1; then echo pristine; ` +
    `else echo exists; fi`
  );
}

async function create(deps: SandboxToolDeps, args: CreateArgs): Promise<ToolResult> {
  try {
    const sbId = await deps.getSandboxId();
    const fullPath = resolveStrict(deps.root, args.path);
    const mayReplace = deps.createReplacePristinePaths?.includes(normalizeRepoPath(args.path)) === true;
    const probe = await execCommand(
      sbId,
      mayReplace
        ? pristineProbeCommand(deps.root, fullPath)
        : `test -e '${fullPath.replace(/'/g, "'\\''")}' && echo exists || echo missing`,
      5_000,
    );
    if (mayReplace && probe.stdout.trim() === "pristine") {
      await e2bWriteFile(sbId, fullPath, args.file_text);
      return textResult({ ok: true, path: args.path, replaced_unmodified_file: true });
    }
    const exists = probe.stdout.trim() === "exists";
    if (probe.stdout.trim() !== "exists" && probe.stdout.trim() !== "missing") {
      return errorResult(
        "existence_probe_failed",
        `couldn't determine if ${args.path} exists (probe: ${probe.stdout.slice(0, 200)}). Retry or use str_replace if the file is known to exist.`,
      );
    }
    if (exists) {
      return errorResult(
        "already_exists",
        `${args.path} already exists. Use str_replace to modify, or delete it first.`,
      );
    }
    const dir = fullPath.split("/").slice(0, -1).join("/");
    if (dir) await execCommand(sbId, `mkdir -p ${shellSingleQuote(dir)}`, 10_000);
    await e2bWriteFile(sbId, fullPath, args.file_text);
    return textResult({ ok: true, path: args.path });
  } catch (e) {
    return errorResult("create_failed", (e as Error).message);
  }
}

async function insert(deps: SandboxToolDeps, args: InsertArgs): Promise<ToolResult> {
  try {
    const sbId = await deps.getSandboxId();
    const fullPath = resolveStrict(deps.root, args.path);
    const raw = await e2bReadFile(sbId, fullPath);
    const lines = raw.split("\n");
    if (args.insert_line > lines.length) {
      return errorResult(
        "insert_line_out_of_range",
        `insert_line ${args.insert_line} > file length ${lines.length}`,
      );
    }
    const insertLines = args.new_str.split("\n");
    lines.splice(args.insert_line, 0, ...insertLines);
    await e2bWriteFile(sbId, fullPath, lines.join("\n"));
    return textResult({ ok: true, path: args.path });
  } catch (e) {
    return errorResult("insert_failed", (e as Error).message);
  }
}

async function stage_preview(
  deps: SandboxToolDeps,
  args: StagePreviewArgs,
): Promise<ToolResult> {
  try {
    const result = await stageHtmlPreviewArtifact({
      tenant_id: deps.tenant_id,
      run_id: deps.run_id,
      title: args.title,
      summary: args.summary,
      html: args.html,
      design_spec: args.design_spec,
    });
    return {
      ...textResult(result),
      ...(!result.ok ? { isError: true } : {}),
    };
  } catch (e) {
    return errorResult("stage_preview_failed", (e as Error).message);
  }
}

async function emit_artifact(deps: SandboxToolDeps, args: EmitArtifactArgs): Promise<ToolResult> {
  try {
    const filename = sanitizeArtifactFilename(args.filename);
    if (!filename) {
      return errorResult(
        "filename_invalid",
        "filename produced no usable characters after sanitization. Use a name like 'report.pdf'.",
      );
    }
    const mime = artifactMimeForFilename(filename);
    if (!mime) {
      return errorResult(
        "mime_not_allowed",
        "only .pdf, .csv, .xlsx, .pptx, .mp4, .png artifacts are supported.",
      );
    }

    const sbId = await deps.getSandboxId();
    const fullPath = resolveSafe(deps.root, args.path);
    const bytes = await e2bReadFileBytes(sbId, fullPath);

    if (bytes.byteLength > ARTIFACT_MAX_BYTES) {
      return errorResult(
        "artifact_too_large",
        `artifact is ${bytes.byteLength} bytes; cap is ${ARTIFACT_MAX_BYTES}.`,
      );
    }
    if (bytes.byteLength === 0) {
      return errorResult("artifact_empty", `file ${args.path} is empty.`);
    }
    if (!artifactBytesMatchMime(bytes, mime)) {
      return errorResult(
        "content_mime_mismatch",
        `file content does not look like ${mime}. Check you wrote a real ${filename.split(".").pop()} file.`,
      );
    }

    try {
      await assertRunTenantOwnership({
        tenant_id: deps.tenant_id,
        run_id: deps.run_id,
      });
    } catch (e) {
      if (e instanceof ExpectedToolError) {
        return errorResult(e.code, e.message);
      }
      throw e;
    }
    const svc = serviceClient();

    const storagePath = `${deps.tenant_id}/${deps.run_id}/${filename}`;
    const { error: upErr } = await svc.storage
      .from(ARTIFACT_BUCKET)
      .upload(storagePath, Buffer.from(bytes), {
        contentType: mime,
        upsert: true,
      });
    if (upErr) {
      return errorResult("storage_upload_failed", upErr.message);
    }

    const binding = await artifactRunBinding(deps.run_id);
    const { data: rowData, error: rowErr } = await svc
      .from("run_artifacts")
      .upsert(
        {
          tenant_id: deps.tenant_id,
          run_id: deps.run_id,
          storage_path: storagePath,
          filename,
          title: args.title,
          mime,
          bytes: bytes.byteLength,
          agent_slug: binding.agent_slug,
          thread_id: binding.thread_id,
        },
        { onConflict: "tenant_id,run_id,filename" },
      )
      .select("id")
      .single();
    if (rowErr || !rowData) {
      return errorResult("artifact_row_failed", rowErr?.message ?? "row upsert failed");
    }
    const artifact_id = (rowData as { id: string }).id;
    trackDocumentDelivered({ tenant_id: deps.tenant_id, mime });
    if (mime.startsWith("video/")) trackMediaGenerated({ tenant_id: deps.tenant_id, media: "video", kind: "other" });

    let slack_ok = false;
    if (args.channel_id && !deps.slack_post_blocked) {
      try {
        await uploadFileToThread({
          tenant_id: deps.tenant_id,
          channel_id: args.channel_id,
          thread_ts: args.thread_ts,
          bytes,
          filename,
          title: args.title,
          team_id: deps.slack_team_id,
        });
        slack_ok = true;
        await svc
          .from("run_artifacts")
          .update({ slack_delivered: true })
          .eq("tenant_id", deps.tenant_id)
          .eq("run_id", deps.run_id)
          .eq("filename", filename);
      } catch (e) {
        console.warn(
          `[emit_artifact] slack delivery soft-failed: ${(e as Error).message}`,
        );
      }
    }

    return textResult({ artifact_id, filename, bytes: bytes.byteLength, slack_ok });
  } catch (e) {
    return errorResult("emit_artifact_failed", (e as Error).message);
  }
}

export async function persistImageArtifact(input: {
  tenant_id: string;
  run_id: string;
  bytes: Buffer;
  filename: string;
  mime: string;
  slack_delivered?: boolean;
}): Promise<{ artifact_id: string } | null> {
  try {
    if (input.bytes.byteLength > ARTIFACT_MAX_BYTES) return null;
    await assertRunTenantOwnership({ tenant_id: input.tenant_id, run_id: input.run_id });
    const svc = serviceClient();
    const storagePath = `${input.tenant_id}/${input.run_id}/${input.filename}`;
    const { error: upErr } = await svc.storage
      .from(ARTIFACT_BUCKET)
      .upload(storagePath, input.bytes, { contentType: input.mime, upsert: true });
    if (upErr) {
      console.warn(`[persistImageArtifact] upload failed: ${upErr.message}`);
      return null;
    }
    const binding = await artifactRunBinding(input.run_id);
    const { data, error: rowErr } = await svc
      .from("run_artifacts")
      .upsert(
        {
          tenant_id: input.tenant_id,
          run_id: input.run_id,
          storage_path: storagePath,
          filename: input.filename,
          title: input.filename.replace(/\.[^.]+$/, ""),
          mime: input.mime,
          bytes: input.bytes.byteLength,
          agent_slug: binding.agent_slug,
          thread_id: binding.thread_id,
          ...(input.slack_delivered ? { slack_delivered: true } : {}),
        },
        { onConflict: "tenant_id,run_id,filename" },
      )
      .select("id")
      .single();
    if (rowErr || !data) {
      console.warn(
        `[persistImageArtifact] row upsert failed: ${rowErr?.message ?? "no row"}`,
      );
      return null;
    }
    return { artifact_id: (data as { id: string }).id };
  } catch (e) {
    console.warn(`[persistImageArtifact] soft-failed: ${(e as Error).message}`);
    return null;
  }
}

async function app_verify(deps: SandboxToolDeps, rawArgs: AppVerifyInput): Promise<ToolResult> {
  const args = rawArgs as AppVerifyInput;
  const refusal = deps.refusalFor(args.start_cmd ?? "npm run dev");
  if (refusal) {
    return errorResult("escape_guard", refusal);
  }
  const invalid = validateAppVerifyInput(args);
  if (invalid) {
    return errorResult("app_verify_invalid_input", invalid);
  }
  try {
    const sbId = await deps.getSandboxId();
    const script = buildAppVerifyScript(args);
    const bootTimeout = args.boot_timeout_seconds ?? APP_VERIFY_BOOT_TIMEOUT_DEFAULT_S;
    const r = await execCommand(
      sbId,
      `cd ${deps.root} && ${script}`,
      (bootTimeout + APP_VERIFY_EXEC_HEADROOM_S) * 1000,
    );
    const parsed = parseAppVerifyOutput(r.stdout, args);
    return textResult({ ...parsed, ms: r.ms });
  } catch (e) {
    return errorResult("app_verify_failed", (e as Error).message);
  }
}

export const sandboxToolRegistry = {
  write_file,
  read_file,
  run_bash,
  run_tests,
  git_diff,
  git_status,
  view,
  str_replace,
  create,
  insert,
  stage_preview,
  emit_artifact,
  app_verify,
  run_typecheck,
} as const;

export const SANDBOX_REPO_ROOT = REPO_ROOT;
