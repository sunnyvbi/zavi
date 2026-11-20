
import { execCommand, refreshOriginUrlStep } from "@/services/sandbox/e2b-client";

const REPO_ROOT = "/home/user/repo";

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
function isSafeBranch(s: string): boolean {
  if (typeof s !== "string" || s.length === 0) return false;
  if (s.startsWith("-")) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(s)) return false;
  if (s.includes("..")) return false;
  for (const part of s.split("/")) {
    if (part.length === 0) return false;
    if (part.startsWith(".")) return false;
    if (part.endsWith(".")) return false;
    if (part.endsWith(".lock")) return false;
  }
  return true;
}

export type PerBaseFileChange = {
  path: string;
  action: "create" | "modify" | "delete";
  content?: string;
  diff?: string;
  encoding?: "base64";
};

function withEncoding(
  f: PerBaseFileChange,
  next: PerBaseFileChange,
): PerBaseFileChange {
  return f.encoding ? { ...next, encoding: f.encoding } : next;
}

export type PerBaseFilesResult = {
  perBase: Record<string, PerBaseFileChange[]>;
  conflicts: string[];
  errors: string[];
};

export async function buildPerBaseFiles(opts: {
  sandbox_id: string;
  defaultBranch: string;
  bases: string[];
  defaultFiles: PerBaseFileChange[];
  repo_root?: string;
}): Promise<PerBaseFilesResult> {
  const { sandbox_id, defaultBranch, bases, defaultFiles } = opts;
  const repoRoot = opts.repo_root ?? REPO_ROOT;
  const perBase: Record<string, PerBaseFileChange[]> = {};
  const conflicts: string[] = [];
  const errors: string[] = [];

  const seen = new Set<string>();
  const targets: string[] = [];
  for (const b of bases) {
    if (seen.has(b)) continue;
    seen.add(b);
    if (b === defaultBranch) perBase[b] = defaultFiles;
    else if (!isSafeBranch(b)) errors.push(b);
    else targets.push(b);
  }
  if (targets.length === 0) return { perBase, conflicts, errors };

  const modifyPaths = defaultFiles.filter((f) => f.action === "modify");

  for (const base of targets) {
    if (modifyPaths.length > 0) {
      const fetch = await execCommand(
        sandbox_id,
        `cd ${repoRoot} && ${refreshOriginUrlStep()}git fetch origin ${shq(base)} --quiet`,
        60_000,
      );
      if (fetch.exit_code !== 0) {
        errors.push(base);
        continue;
      }
    }

    const files: PerBaseFileChange[] = [];
    let refuse = false;
    for (const f of defaultFiles) {
      if (f.action !== "modify") {
        files.push(
          f.action === "delete"
            ? { path: f.path, action: "delete" }
            : withEncoding(f, { path: f.path, action: f.action, content: f.content, diff: f.diff }),
        );
        continue;
      }
      const onBase = await execCommand(
        sandbox_id,
        `cd ${repoRoot} && git show origin/${shq(base)}:${shq(f.path)}`,
        60_000,
      );
      if (onBase.exit_code !== 0) {
        files.push(withEncoding(f, { path: f.path, action: "create", content: f.content, diff: f.diff }));
        continue;
      }
      const onHead = await execCommand(
        sandbox_id,
        `cd ${repoRoot} && git show HEAD:${shq(f.path)}`,
        60_000,
      );
      if (onHead.exit_code !== 0) {
        refuse = true;
        break;
      }
      if (onBase.stdout === onHead.stdout) {
        files.push(withEncoding(f, { path: f.path, action: "modify", content: f.content, diff: f.diff }));
        continue;
      }
      if (f.encoding === "base64") {
        refuse = true;
        break;
      }
      if (typeof f.content !== "string") {
        refuse = true;
        break;
      }
      const theirsB64 = Buffer.from(f.content, "utf-8").toString("base64");
      const merged = await execCommand(
        sandbox_id,
        `set +e; cd ${repoRoot} || exit 1; _td=$(mktemp -d) || exit 1; ` +
          `git show HEAD:${shq(f.path)} > "$_td/ancestor" && ` +
          `git show origin/${shq(base)}:${shq(f.path)} > "$_td/ours" && ` +
          `printf %s ${shq(theirsB64)} | base64 -d > "$_td/theirs"; ` +
          `if [ $? -ne 0 ]; then rm -rf "$_td"; exit 2; fi; ` +
          `git merge-file -p "$_td/ours" "$_td/ancestor" "$_td/theirs"; _rc=$?; ` +
          `rm -rf "$_td"; exit $_rc`,
        60_000,
      );
      if (merged.exit_code === 0) {
        files.push({ path: f.path, action: "modify", content: merged.stdout, diff: f.diff });
      } else {
        refuse = true;
        break;
      }
    }
    if (refuse) conflicts.push(base);
    else perBase[base] = files;
  }

  return { perBase, conflicts, errors };
}
