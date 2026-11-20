
import { execCommand } from "@/services/sandbox/e2b-client";
import {
  ENGINEER_PR_CAPS_STANDARD,
  ENGINEER_PR_CAPS_XL,
  ENGINEER_PR_CAPS_PRODUCT_BUILD,
} from "@/services/agents/engineer-caps";

export const DIFF_BYTE_CAP = ENGINEER_PR_CAPS_STANDARD.diffByteCap;
export const MAX_CHANGED_LINES = ENGINEER_PR_CAPS_STANDARD.maxChangedLines;
export const MAX_POST_IMAGE_BYTES = ENGINEER_PR_CAPS_STANDARD.maxPostImageBytes;

export const PRODUCT_BUILD_DIFF_BYTE_CAP =
  ENGINEER_PR_CAPS_PRODUCT_BUILD.diffByteCap;
export const PRODUCT_BUILD_MAX_CHANGED_LINES =
  ENGINEER_PR_CAPS_PRODUCT_BUILD.maxChangedLines;
export const PRODUCT_BUILD_MAX_POST_IMAGE_BYTES =
  ENGINEER_PR_CAPS_PRODUCT_BUILD.maxPostImageBytes;

export const OPERATOR_OPT_IN_DIFF_BYTE_CAP = ENGINEER_PR_CAPS_XL.diffByteCap;
export const OPERATOR_OPT_IN_MAX_CHANGED_LINES =
  ENGINEER_PR_CAPS_XL.maxChangedLines;
export const OPERATOR_OPT_IN_MAX_POST_IMAGE_BYTES =
  ENGINEER_PR_CAPS_XL.maxPostImageBytes;

export type BuilderCaps = {
  diffByteCap: number;
  maxChangedLines: number;
  maxPostImageBytes: number;
  maxFiles: number;
};

export const DEFAULT_BUILDER_CAPS: BuilderCaps = {
  diffByteCap: ENGINEER_PR_CAPS_STANDARD.diffByteCap,
  maxChangedLines: ENGINEER_PR_CAPS_STANDARD.maxChangedLines,
  maxPostImageBytes: ENGINEER_PR_CAPS_STANDARD.maxPostImageBytes,
  maxFiles: ENGINEER_PR_CAPS_STANDARD.maxFiles,
};

export const OPERATOR_OPT_IN_BUILDER_CAPS: BuilderCaps = {
  diffByteCap: ENGINEER_PR_CAPS_XL.diffByteCap,
  maxChangedLines: ENGINEER_PR_CAPS_XL.maxChangedLines,
  maxPostImageBytes: ENGINEER_PR_CAPS_XL.maxPostImageBytes,
  maxFiles: ENGINEER_PR_CAPS_XL.maxFiles,
};

export const PRODUCT_BUILD_BUILDER_CAPS: BuilderCaps = {
  diffByteCap: ENGINEER_PR_CAPS_PRODUCT_BUILD.diffByteCap,
  maxChangedLines: ENGINEER_PR_CAPS_PRODUCT_BUILD.maxChangedLines,
  maxPostImageBytes: ENGINEER_PR_CAPS_PRODUCT_BUILD.maxPostImageBytes,
  maxFiles: ENGINEER_PR_CAPS_PRODUCT_BUILD.maxFiles,
};

const REPO_ROOT = "/home/user/repo";
const GIT_TIMEOUT_MS = 30_000;

export type FileChangeAction = "create" | "modify" | "delete";

export type FileChange = {
  path: string;
  action: FileChangeAction;
  diff: string;
  content?: string;
  encoding?: "base64";
};

const BINARY_ASSET_EXT =
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|heic|woff2?|ttf|otf|eot|pdf|mp4|webm|mov|mp3|wav|ogg|zip)$/i;

export function isBinaryAssetPath(path: string): boolean {
  return BINARY_ASSET_EXT.test(path);
}

function binaryDiff(path: string, action: FileChangeAction): string {
  if (action === "create") {
    return [`diff --git a/${path} b/${path}`, "new file mode 100644", `Binary files /dev/null and b/${path} differ`, ""].join("\n");
  }
  if (action === "delete") {
    return [`diff --git a/${path} b/${path}`, "deleted file mode 100644", `Binary files a/${path} and /dev/null differ`, ""].join("\n");
  }
  return [`diff --git a/${path} b/${path}`, `Binary files a/${path} and b/${path} differ`, ""].join("\n");
}

export type BuilderResult = {
  files: FileChange[];
  total_diff_bytes: number;
  total_changed_lines: number;
  total_post_image_bytes: number;
};

export type BuilderError =
  | { kind: "forbidden_path"; path: string; paths?: string[] }
  | { kind: "diff_byte_cap_exceeded"; total_diff_bytes: number; cap: number }
  | { kind: "max_changed_lines_exceeded"; total_changed_lines: number; cap: number }
  | { kind: "max_post_image_bytes_exceeded"; total_post_image_bytes: number; cap: number }
  | { kind: "max_files_exceeded"; total_files: number; cap: number }
  | { kind: "git_status_failed"; stderr: string }
  | { kind: "git_diff_failed"; path: string; stderr: string }
  | { kind: "git_numstat_failed"; stderr: string };

export const MAX_REPORTED_FORBIDDEN_PATHS = 20;

export class BuilderRejectedError extends Error {
  readonly detail: BuilderError;
  constructor(detail: BuilderError) {
    super(detail.kind);
    this.name = "BuilderRejectedError";
    this.detail = detail;
  }
}

const FORBIDDEN_PATH_PATTERNS: Array<(p: string) => boolean> = [
  (p) => /(^|\/)\.env(\.(?!example$|sample$|template$)|$)/.test(p),
  (p) => /(^|\/)\.env$/.test(p),
  (p) => /(^|\/)\.envrc(\..+)?$/.test(p),
  (p) => /(^|\/)id_(rsa|ecdsa|ed25519|dsa)(\.pub)?$/.test(p),
  (p) => /\.(pem|key|p12|pfx)$/.test(p),
  (p) => /(^|\/)credentials(\.(json|yaml|yml))?$/.test(p),
  (p) => /(^|\/)service[-_]?account[^/]*\.json$/.test(p),
  (p) => /(^|\/)\.aws\//.test(p),
  (p) => /(^|\/)\.gcp\//.test(p),
  (p) => /(^|\/)\.kube\//.test(p),
  (p) => /(^|\/)\.npmrc$/.test(p),
  (p) => /(^|\/)\.pypirc$/.test(p),
  (p) => /(^|\/)\.netrc$/.test(p),
  (p) => p.startsWith(".github/workflows/"),
];

const MIGRATIONS_PREFIX = "supabase/migrations/";
const SITE_MIGRATION_FILE_RE = /^supabase\/migrations\/[^/]+\.sql$/;

export type ForbiddenPathContext = {
  siteRepo?: boolean;
};

export function isForbiddenPath(path: string, ctx: ForbiddenPathContext = {}): boolean {
  if (FORBIDDEN_PATH_PATTERNS.some((pat) => pat(path))) return true;
  if (path.startsWith(MIGRATIONS_PREFIX)) return !(ctx.siteRepo === true && SITE_MIGRATION_FILE_RE.test(path));
  return false;
}

type StatusEntry = { action: FileChangeAction; path: string; old_path?: string };

function parsePorcelain(stdout: string): StatusEntry[] {
  const records: StatusEntry[] = [];
  const tokens = stdout.split("\0").filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    if (head.length < 3) {
      i += 1;
      continue;
    }
    const code = head.slice(0, 2);
    const restPath = head.slice(3);
    const primary = code[0] !== " " ? code[0] : code[1];
    if (primary === "R" || primary === "C") {
      const oldPath = tokens[i + 1];
      records.push({ action: "create", path: restPath, old_path: oldPath });
      if (oldPath) {
        records.push({ action: "delete", path: oldPath });
      }
      i += 2;
      continue;
    }
    if (primary === "A" || primary === "?") {
      records.push({ action: "create", path: restPath });
    } else if (primary === "D") {
      records.push({ action: "delete", path: restPath });
    } else if (primary === "M" || primary === "T") {
      records.push({ action: "modify", path: restPath });
    }
    i += 1;
  }
  return records;
}

function parseNumstat(stdout: string): number {
  let total = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10);
    const deleted = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10);
    if (Number.isFinite(added)) total += added;
    if (Number.isFinite(deleted)) total += deleted;
  }
  return total;
}

function shq(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

export async function buildPrFilesFromSandboxFs(opts: {
  sandbox_id: string;
  repo_root?: string;
  caps?: BuilderCaps;
  site_repo?: boolean;
}): Promise<BuilderResult> {
  const { sandbox_id } = opts;
  const pathCtx: ForbiddenPathContext = { siteRepo: opts.site_repo === true };
  const repoRoot = opts.repo_root ?? REPO_ROOT;
  const caps = opts.caps ?? DEFAULT_BUILDER_CAPS;

  const statusRes = await execCommand(
    sandbox_id,
    `cd ${repoRoot} && git status --porcelain=v1 --untracked-files=all -z`,
    GIT_TIMEOUT_MS,
  );
  if (statusRes.exit_code !== 0) {
    throw new BuilderRejectedError({
      kind: "git_status_failed",
      stderr: statusRes.stderr || statusRes.stdout || "git status returned non-zero",
    });
  }
  const entries = parsePorcelain(statusRes.stdout);

  if (entries.length === 0) {
    return {
      files: [],
      total_diff_bytes: 0,
      total_changed_lines: 0,
      total_post_image_bytes: 0,
    };
  }

  const seen = new Set<string>();
  const forbidden: string[] = [];
  const refuse = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    if (forbidden.length < MAX_REPORTED_FORBIDDEN_PATHS) forbidden.push(p);
  };
  for (const e of entries) {
    if (pathCtx.siteRepo && e.path.startsWith(MIGRATIONS_PREFIX) && (e.action === "delete" || e.old_path)) {
      refuse(e.path);
    }
    if (e.old_path?.startsWith(MIGRATIONS_PREFIX)) refuse(e.old_path);
    if (isForbiddenPath(e.path, pathCtx)) refuse(e.path);
    if (e.old_path && isForbiddenPath(e.old_path, pathCtx)) refuse(e.old_path);
  }
  if (forbidden.length > 0) {
    throw new BuilderRejectedError({
      kind: "forbidden_path",
      path: forbidden[0],
      paths: forbidden,
    });
  }

  if (entries.length > caps.maxFiles) {
    throw new BuilderRejectedError({
      kind: "max_files_exceeded",
      total_files: entries.length,
      cap: caps.maxFiles,
    });
  }

  const files: FileChange[] = [];
  let totalDiffBytes = 0;
  let totalPostImageBytes = 0;

  const reads = await mapInOrderWithConcurrency(entries, FILE_READ_CONCURRENCY, (e) =>
    readEntryChange(sandbox_id, repoRoot, e),
  );
  for (const read of reads) {
    if (!read.ok) throw read.error;
    files.push(read.value.file);
    totalDiffBytes += read.value.diffBytes;
    totalPostImageBytes += read.value.postImageBytes;
  }

  if (totalDiffBytes > caps.diffByteCap) {
    throw new BuilderRejectedError({
      kind: "diff_byte_cap_exceeded",
      total_diff_bytes: totalDiffBytes,
      cap: caps.diffByteCap,
    });
  }

  if (totalPostImageBytes > caps.maxPostImageBytes) {
    throw new BuilderRejectedError({
      kind: "max_post_image_bytes_exceeded",
      total_post_image_bytes: totalPostImageBytes,
      cap: caps.maxPostImageBytes,
    });
  }

  const numstatRes = await execCommand(
    sandbox_id,
    `cd ${repoRoot} && git diff --no-ext-diff --numstat HEAD`,
    GIT_TIMEOUT_MS,
  );
  if (numstatRes.exit_code !== 0) {
    throw new BuilderRejectedError({
      kind: "git_numstat_failed",
      stderr: numstatRes.stderr || "git diff --numstat returned non-zero",
    });
  }
  let totalChangedLines = parseNumstat(numstatRes.stdout);
  for (const f of files) {
    if (f.action === "create" && f.content !== undefined && f.encoding !== "base64") {
      const lineCount = f.content.split("\n").length;
      totalChangedLines += f.content.endsWith("\n") ? lineCount - 1 : lineCount;
    }
  }
  if (totalChangedLines > caps.maxChangedLines) {
    throw new BuilderRejectedError({
      kind: "max_changed_lines_exceeded",
      total_changed_lines: totalChangedLines,
      cap: caps.maxChangedLines,
    });
  }

  return {
    files,
    total_diff_bytes: totalDiffBytes,
    total_changed_lines: totalChangedLines,
    total_post_image_bytes: totalPostImageBytes,
  };
}

export const FILE_READ_CONCURRENCY = 8;

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function mapInOrderWithConcurrency<I, O>(
  items: I[],
  limit: number,
  fn: (item: I) => Promise<O>,
): Promise<Settled<O>[]> {
  const results: Settled<O>[] = new Array(items.length);
  let next = 0;
  let failedAt = items.length;
  const worker = async (): Promise<void> => {
    while (next < items.length && next < failedAt) {
      const index = next++;
      try {
        results[index] = { ok: true, value: await fn(items[index]!) };
      } catch (error) {
        results[index] = { ok: false, error };
        failedAt = Math.min(failedAt, index);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}

async function readEntryChange(
  sandbox_id: string,
  repoRoot: string,
  e: StatusEntry,
): Promise<{ file: FileChange; diffBytes: number; postImageBytes: number }> {
  if (isBinaryAssetPath(e.path)) {
    let content: string | undefined;
    if (e.action !== "delete") {
      const b64Res = await execCommand(
        sandbox_id,
        `cd ${repoRoot} && base64 < ${shq(e.path)} | tr -d '\\n'`,
        GIT_TIMEOUT_MS,
      );
      if (b64Res.exit_code !== 0) {
        throw new BuilderRejectedError({
          kind: "git_diff_failed",
          path: e.path,
          stderr: b64Res.stderr || "base64 returned non-zero",
        });
      }
      content = b64Res.stdout.trim();
    }
    const diffText = binaryDiff(e.path, e.action);
    return {
      file:
        content === undefined
          ? { path: e.path, action: e.action, diff: diffText }
          : { path: e.path, action: e.action, diff: diffText, content, encoding: "base64" },
      diffBytes: Buffer.byteLength(diffText, "utf-8"),
      postImageBytes: content ? Buffer.from(content, "base64").length : 0,
    };
  }
  let diffText: string;
  let content: string | undefined;
  if (e.action === "delete") {
    const showRes = await execCommand(
      sandbox_id,
      `cd ${repoRoot} && git cat-file -p HEAD:${shq(e.path)}`,
      GIT_TIMEOUT_MS,
    );
    const oldContent = showRes.exit_code === 0 ? showRes.stdout : "";
    diffText = synthDeleteDiff(e.path, oldContent);
    content = undefined;
  } else if (e.action === "create") {
    const catRes = await execCommand(
      sandbox_id,
      `cd ${repoRoot} && cat ${shq(e.path)}`,
      GIT_TIMEOUT_MS,
    );
    if (catRes.exit_code !== 0) {
      throw new BuilderRejectedError({
        kind: "git_diff_failed",
        path: e.path,
        stderr: catRes.stderr || "cat returned non-zero",
      });
    }
    content = catRes.stdout;
    diffText = synthCreateDiff(e.path, content);
  } else {
    const diffRes = await execCommand(
      sandbox_id,
      `cd ${repoRoot} && git diff --no-ext-diff HEAD -- ${shq(e.path)}`,
      GIT_TIMEOUT_MS,
    );
    if (diffRes.exit_code !== 0) {
      throw new BuilderRejectedError({
        kind: "git_diff_failed",
        path: e.path,
        stderr: diffRes.stderr || "git diff returned non-zero",
      });
    }
    diffText = diffRes.stdout;
    const catRes = await execCommand(
      sandbox_id,
      `cd ${repoRoot} && cat ${shq(e.path)}`,
      GIT_TIMEOUT_MS,
    );
    content = catRes.exit_code === 0 ? catRes.stdout : undefined;
  }
  return {
    file: { path: e.path, action: e.action, diff: diffText, content },
    diffBytes: Buffer.byteLength(diffText, "utf-8"),
    postImageBytes: content ? Buffer.byteLength(content, "utf-8") : 0,
  };
}

function synthCreateDiff(path: string, content: string): string {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return [
    `diff --git a/${path} b/${path}`,
    `new file mode 100644`,
    `--- /dev/null`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

function synthDeleteDiff(path: string, oldContent: string): string {
  const lines = oldContent.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return [
    `diff --git a/${path} b/${path}`,
    `deleted file mode 100644`,
    `--- a/${path}`,
    `+++ /dev/null`,
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((l) => `-${l}`),
    "",
  ].join("\n");
}
