
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RealRepoTask } from "./types";

const CACHE_ROOT = path.join(os.tmpdir(), "eq-realrepo-nodemodules-cache");

export type Materialization = {
  repoDir: string;
  backendDir: string;
  nodeModulesFromCache: boolean;
  worktreePath: string;
};

function git(
  repoRoot: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

export function resolveRepoRoot(fromDir: string = process.cwd()): string {
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: fromDir,
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(
      `not a git repo (cwd=${fromDir}): ${(res.stderr ?? "").trim()}`,
    );
  }
  return res.stdout.trim();
}

export function readFileAtSha(
  repoRoot: string,
  sha: string,
  relPath: string,
): string | null {
  const res = git(repoRoot, ["show", `${sha}:${relPath}`]);
  if (res.status !== 0) return null;
  return res.stdout;
}

function lockfileHashAtSha(
  repoRoot: string,
  sha: string,
  lockRel: string,
): string | null {
  const content = readFileAtSha(repoRoot, sha, lockRel);
  if (content === null) return null;
  return crypto.createHash("sha256").update(content).digest("hex");
}

const ROOT_LOCKFILE = "package-lock.json";

export function ensureNodeModulesBaseline(
  repoRoot: string,
  sha: string,
  opts: { seedRoot?: string } = {},
): { dir: string; hash: string; installed: boolean } {
  const seedRoot = opts.seedRoot ?? repoRoot;
  const hash =
    lockfileHashAtSha(repoRoot, sha, ROOT_LOCKFILE) ?? `no-lock-${sha}`;
  const cacheDir = path.join(CACHE_ROOT, hash);
  const stamp = path.join(cacheDir, ".eq-install-complete");

  if (fs.existsSync(stamp)) {
    return { dir: path.join(cacheDir, "node_modules"), hash, installed: false };
  }

  const seedNm = path.join(seedRoot, "node_modules");
  if (fs.existsSync(seedNm)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const dest = path.join(cacheDir, "node_modules");
    if (!fs.existsSync(dest)) fs.symlinkSync(seedNm, dest, "dir");
    fs.writeFileSync(stamp, `${new Date().toISOString()} seeded-from ${seedNm}`);
    return { dir: dest, hash, installed: false };
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const installWt = fs.mkdtempSync(path.join(os.tmpdir(), "eq-nm-install-"));
  fs.rmSync(installWt, { recursive: true, force: true });
  const add = git(repoRoot, ["worktree", "add", "--detach", installWt, sha], {
    timeoutMs: 120_000,
  });
  if (add.status !== 0) {
    throw new Error(
      `git worktree add (install) failed for ${sha}: ${add.stderr.trim()}`,
    );
  }
  try {
    runInstall(installWt);
    const installedNm = path.join(installWt, "node_modules");
    if (!fs.existsSync(installedNm)) {
      throw new Error("npm install produced no node_modules");
    }
    const dest = path.join(cacheDir, "node_modules");
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(installedNm, dest);
    fs.writeFileSync(stamp, new Date().toISOString());
    return { dir: dest, hash, installed: true };
  } finally {
    git(repoRoot, ["worktree", "remove", "--force", installWt]);
    try {
      fs.rmSync(installWt, { recursive: true, force: true });
    } catch {
    }
  }
}

function runInstall(dir: string): void {
  const ci = spawnSync(
    "npm",
    ["ci", "--no-audit", "--no-fund", "--ignore-scripts"],
    { cwd: dir, encoding: "utf-8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (ci.status === 0) {
    fixNativeBinaries(dir);
    return;
  }
  const install = spawnSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--ignore-scripts"],
    { cwd: dir, encoding: "utf-8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (install.status !== 0) {
    throw new Error(
      `npm install failed in ${dir}:\n${(install.stderr || install.stdout || "").slice(-2000)}`,
    );
  }
  fixNativeBinaries(dir);
}

function fixNativeBinaries(dir: string): void {
  const plat = `${process.platform}-${process.arch}`;
  const pkgs = [`@rollup/rollup-${plat}`, `@esbuild/${plat}`];
  spawnSync("npm", ["install", "--no-save", "--no-audit", "--no-fund", ...pkgs], {
    cwd: dir,
    encoding: "utf-8",
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function materializeTask(
  repoRoot: string,
  task: RealRepoTask,
): Materialization {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "eq-realrepo-wt-"));
  fs.rmSync(worktreePath, { recursive: true, force: true });

  const add = git(
    repoRoot,
    ["worktree", "add", "--detach", worktreePath, task.base_sha],
    { timeoutMs: 120_000 },
  );
  if (add.status !== 0) {
    throw new Error(
      `git worktree add failed for ${task.task_id} @ ${task.base_sha}: ${add.stderr.trim()}`,
    );
  }

  try {
    for (const rel of task.oracle_test_files) {
      const content = readFileAtSha(repoRoot, task.head_sha, rel);
      if (content === null) {
        throw new Error(
          `oracle test ${rel} not found at head_sha ${task.head_sha} for ${task.task_id}`,
        );
      }
      const abs = path.join(worktreePath, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }

    const baseline = ensureNodeModulesBaseline(repoRoot, task.base_sha);
    const targetNm = path.join(worktreePath, "node_modules");
    if (!fs.existsSync(targetNm)) {
      fs.symlinkSync(baseline.dir, targetNm, "dir");
    }

    return {
      repoDir: worktreePath,
      backendDir: path.join(worktreePath, "apps", "backend"),
      nodeModulesFromCache: !baseline.installed,
      worktreePath,
    };
  } catch (e) {
    removeMaterialization(repoRoot, { worktreePath } as Materialization);
    throw e;
  }
}

export function removeMaterialization(
  repoRoot: string,
  m: Pick<Materialization, "worktreePath">,
): void {
  const nm = path.join(m.worktreePath, "node_modules");
  try {
    const st = fs.lstatSync(nm);
    if (st.isSymbolicLink()) fs.unlinkSync(nm);
  } catch {
  }
  const res = git(repoRoot, ["worktree", "remove", "--force", m.worktreePath]);
  if (res.status !== 0) {
    try {
      fs.rmSync(m.worktreePath, { recursive: true, force: true });
    } catch {
    }
    git(repoRoot, ["worktree", "prune"]);
  }
}

export function buildOracleCommand(
  task: RealRepoTask,
  backendDir: string,
  repoDir: string,
): string {
  const rels = task.oracle_test_files.map((p) => {
    const abs = path.resolve(repoDir, p);
    return path.relative(backendDir, abs);
  });
  const quoted = rels.map((r) => JSON.stringify(r)).join(" ");
  return `npx --no-install vitest run ${quoted}`;
}
