
import type { SandboxRunner } from "./helper-detection";

const REPO_ROOT = "/home/user/repo";
const SANDBOX_TIMEOUT_MS = 10_000;

export type StaleDistFileInput = {
  path: string;
  action: "create" | "modify" | "delete";
};

export type StaleDistHit = {
  pkgRoot: string;
  srcFiles: string[];
};

export function isCandidateSrcFile(path: string): boolean {
  if (!/(^|\/)src\//.test(path)) return false;
  if (!/\.tsx?$/.test(path)) return false;
  if (/\.d\.ts$/.test(path)) return false;
  if (/\.(test|spec)\.[jt]sx?$/.test(path)) return false;
  if (/(^|\/)__tests__\//.test(path)) return false;
  return true;
}

export function isDistPath(path: string): boolean {
  return /(^|\/)dist\//.test(path);
}

export function resolveNearestPackageRoot(
  path: string,
  pkgDirs: string[],
): string | null {
  let best: string | null = null;
  for (const dir of pkgDirs) {
    const isAncestor =
      dir === "" || path === dir || path.startsWith(dir + "/");
    if (!isAncestor) continue;
    if (best === null || dir.length > best.length) best = dir;
  }
  return best;
}

export function evaluateStaleDist(
  changed: StaleDistFileInput[],
  committedDistPkgRoots: string[],
  pkgDirs: string[],
): StaleDistHit[] {
  const distRoots = new Set(committedDistPkgRoots);

  const rebuiltRoots = new Set<string>();
  for (const f of changed) {
    if (!isDistPath(f.path)) continue;
    const root = resolveNearestPackageRoot(f.path, pkgDirs);
    if (root !== null) rebuiltRoots.add(root);
  }

  const byRoot = new Map<string, string[]>();
  for (const f of changed) {
    if (f.action === "delete") continue;
    if (!isCandidateSrcFile(f.path)) continue;
    const root = resolveNearestPackageRoot(f.path, pkgDirs);
    if (root === null) continue;
    if (!distRoots.has(root)) continue;
    if (rebuiltRoots.has(root)) continue;
    const arr = byRoot.get(root) ?? [];
    arr.push(f.path);
    byRoot.set(root, arr);
  }

  return Array.from(byRoot.entries()).map(([pkgRoot, srcFiles]) => ({
    pkgRoot,
    srcFiles,
  }));
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function parseLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.replace(/^\.\//, "").trim())
    .filter((l) => l.length > 0);
}

export async function detectStaleCommittedDist(opts: {
  files: StaleDistFileInput[];
  run: SandboxRunner;
  repo_root?: string;
}): Promise<StaleDistHit[]> {
  const repoRoot = opts.repo_root ?? REPO_ROOT;
  const q = shellQuote(repoRoot);

  let pkgDirs: string[] = [];
  try {
    const r = await opts.run(
      `cd ${q} && git ls-files -- '*package.json' 'package.json'`,
      SANDBOX_TIMEOUT_MS,
    );
    if (r.exit_code === 0) {
      pkgDirs = Array.from(
        new Set(
          parseLines(r.stdout)
            .filter((p) => /(^|\/)package\.json$/.test(p))
            .map((p) => {
              const i = p.lastIndexOf("/");
              return i < 0 ? "" : p.slice(0, i);
            }),
        ),
      );
    }
  } catch {
  }
  if (pkgDirs.length === 0) return [];

  let committedDistPkgRoots: string[] = [];
  try {
    const r = await opts.run(
      `cd ${q} && git ls-files -- '*dist/*'`,
      SANDBOX_TIMEOUT_MS,
    );
    if (r.exit_code === 0) {
      const roots = new Set<string>();
      for (const p of parseLines(r.stdout)) {
        if (!isDistPath(p)) continue;
        const root = resolveNearestPackageRoot(p, pkgDirs);
        if (root !== null) roots.add(root);
      }
      committedDistPkgRoots = Array.from(roots);
    }
  } catch {
  }
  if (committedDistPkgRoots.length === 0) return [];

  return evaluateStaleDist(
    opts.files.map((f) => ({ path: f.path, action: f.action })),
    committedDistPkgRoots,
    pkgDirs,
  );
}
