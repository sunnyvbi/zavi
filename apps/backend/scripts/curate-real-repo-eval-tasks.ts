#!/usr/bin/env tsx

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveRepoRoot,
  readFileAtSha,
  ensureNodeModulesBaseline,
} from "@/services/eval/engineer-quality/materialize-repo";
import { REAL_REPO_CANDIDATES_JSON_PATH } from "@/services/eval/engineer-quality/real-repo-loader";
import type { RealRepoCandidate } from "@/services/eval/engineer-quality/types";

const args = process.argv.slice(2);
const argVal = (f: string, dflt: string): string => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};

const SCAN = Number(argVal("--scan", "1200"));
const LIMIT = Number(argVal("--limit", "14"));
const MAX_SRC_FILES = Number(argVal("--max-files", "5"));
const MAX_CHANGED_LINES = Number(argVal("--max-lines", "250"));
const MIN_SRC_FILES = Number(argVal("--min-files", "1"));
const MIN_CHANGED_LINES = Number(argVal("--min-lines", "0"));
const BEHAVIORAL_ONLY = args.includes("--behavioral-only");
const OUT_BASENAME = argVal("--out", "");

const IMPURITY = [
  /serviceClient/,
  /createClient\s*\(/,
  /supabase/i,
  /from\s+["']@\/services\/supabase["']/,
  /\binngest\b/i,
  /@anthropic-ai/,
  /getAnthropic/,
  /\bnew\s+MongoClient\b/,
  /mongodb/i,
  /\bfetch\s*\(/,
  /\.rpc\s*\(/,
  /process\.env\.SUPABASE/,
  /\be2b\b/i,
  /\bSandbox\b/,
  /nock|msw|supertest/i,
];

const SRC_RE = /^apps\/backend\/src\/.*\.ts$/;
const TEST_RE = /^apps\/backend\/src\/.*__tests__\/.*\.test\.ts$/;

function git(repoRoot: string, gitArgs: string[], timeoutMs = 60_000) {
  const res = spawnSync("git", gitArgs, {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

type CommitMeta = {
  sha: string;
  parent: string;
  subject: string;
  body: string;
};

function recentCommits(repoRoot: string, n: number): CommitMeta[] {
  const fmt = "%H%x1f%P%x1f%s%x1f%b%x1e";
  const res = git(repoRoot, ["log", "origin/main", `-n${n}`, `--pretty=format:${fmt}`]);
  if (res.status !== 0) throw new Error(`git log failed: ${res.stderr}`);
  const out: CommitMeta[] = [];
  for (const rec of res.stdout.split("\x1e")) {
    const trimmed = rec.trim();
    if (!trimmed) continue;
    const [sha, parents, subject, body] = trimmed.split("\x1f");
    const parentList = (parents ?? "").trim().split(/\s+/).filter(Boolean);
    if (parentList.length !== 1) continue;
    out.push({
      sha: (sha ?? "").trim(),
      parent: parentList[0],
      subject: (subject ?? "").trim(),
      body: (body ?? "").trim(),
    });
  }
  return out;
}

type DiffStat = { srcFiles: string[]; testFiles: string[]; changedLines: number };

function diffStat(repoRoot: string, sha: string, parent: string): DiffStat {
  const res = git(repoRoot, ["diff", "--numstat", parent, sha]);
  const srcFiles: string[] = [];
  const testFiles: string[] = [];
  let changedLines = 0;
  let otherFiles = 0;
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [add, del, file] = line.split("\t");
    if (!file) continue;
    const added = add === "-" ? 0 : Number(add);
    const deleted = del === "-" ? 0 : Number(del);
    if (TEST_RE.test(file)) {
      testFiles.push(file);
    } else if (SRC_RE.test(file)) {
      srcFiles.push(file);
      changedLines += added + deleted;
    } else {
      otherFiles++;
    }
  }
  return { srcFiles, testFiles, changedLines: changedLines + otherFiles * 0 };
}

function isPureUnitTest(repoRoot: string, sha: string, testFile: string): boolean {
  const content = readFileAtSha(repoRoot, sha, testFile);
  if (content === null) return false;
  if (/__tests__\/migrations\//.test(testFile)) return false;
  for (const re of IMPURITY) {
    if (re.test(content)) return false;
  }
  return true;
}

function isBehavioralOracle(repoRoot: string, sha: string, testFile: string): boolean {
  const content = readFileAtSha(repoRoot, sha, testFile);
  if (content === null) return false;
  const readsTsSource =
    /readFileSync\s*\([^)]*\.ts['"`]/.test(content) ||
    /readFile\s*\([^)]*\.ts['"`]/.test(content) ||
    /readFileSync\s*\(\s*\n?\s*join\([^)]*\.ts/.test(content);
  if (!readsTsSource) return true;
  const assertsTextMatch =
    /\.toMatch\s*\(/.test(content) ||
    /\.toContain\s*\(/.test(content) ||
    /src\.(includes|match)\s*\(/.test(content);
  return !assertsTextMatch;
}

function runOracleAt(
  repoRoot: string,
  sha: string,
  testSourceSha: string,
  testFile: string,
): { green: boolean; tail: string } {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "eq-curate-wt-"));
  fs.rmSync(wt, { recursive: true, force: true });
  const add = git(repoRoot, ["worktree", "add", "--detach", wt, sha], 120_000);
  if (add.status !== 0) {
    return { green: false, tail: `worktree add failed: ${add.stderr.slice(-300)}` };
  }
  try {
    const testContent = readFileAtSha(repoRoot, testSourceSha, testFile);
    if (testContent === null) {
      return { green: false, tail: `oracle test not found at ${testSourceSha}` };
    }
    const absTest = path.join(wt, testFile);
    fs.mkdirSync(path.dirname(absTest), { recursive: true });
    fs.writeFileSync(absTest, testContent);

    const baseline = ensureNodeModulesBaseline(repoRoot, sha);
    const targetNm = path.join(wt, "node_modules");
    if (!fs.existsSync(targetNm)) fs.symlinkSync(baseline.dir, targetNm, "dir");

    const backendDir = path.join(wt, "apps", "backend");
    const relTest = path.relative(backendDir, absTest);
    const { ESBUILD_BINARY_PATH, ...childEnv } = process.env;
    const run = spawnSync(
      "npx",
      ["--no-install", "vitest", "run", relTest],
      {
        cwd: backendDir,
        encoding: "utf-8",
        timeout: 300_000,
        maxBuffer: 32 * 1024 * 1024,
        env: childEnv,
      },
    );
    const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    return { green: run.status === 0, tail: combined.slice(-400) };
  } finally {
    try {
      const nm = path.join(wt, "node_modules");
      if (fs.existsSync(nm) && fs.lstatSync(nm).isSymbolicLink()) fs.unlinkSync(nm);
    } catch {
    }
    git(repoRoot, ["worktree", "remove", "--force", wt]);
    try {
      fs.rmSync(wt, { recursive: true, force: true });
    } catch {
    }
    git(repoRoot, ["worktree", "prune"]);
  }
}

function bucketFor(subject: string): RealRepoCandidate["bucket"] {
  const s = subject.toLowerCase();
  const money = /\b(refund|payout|price|cost|cents|charge|invoice|stripe|billing|budget|cap)\b/.test(s);
  const feature = /^(feat|feature)\b/.test(s) || /\badd\b/.test(s);
  if (money) return "bug-fix-money";
  if (feature) return "small-feature";
  return "bug-fix";
}

function strippedPrompt(meta: CommitMeta, testFiles: string[]): string {
  const subjectClean = meta.subject.replace(/^[a-z]+(\([^)]*\))?:\s*/i, "").trim();
  const testList = testFiles.join(", ");
  return [
    `There is a bug or missing behavior in the Praxis backend, exercised by the test file(s): ${testList}.`,
    `Symptom (from the original change, paraphrased): "${subjectClean}".`,
    ``,
    `Run the oracle test(s) above. They currently FAIL. Investigate the relevant source under apps/backend/src, find the root cause, and make the SMALLEST correct change so the test(s) pass. Do not edit the test file(s). Do not weaken or delete existing tests. Do not touch unrelated files.`,
  ].join("\n");
}

function makeTaskId(meta: CommitMeta, testFiles: string[]): string {
  const base = path
    .basename(testFiles[0])
    .replace(/\.test\.ts$/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase();
  return `rr-${base}-${meta.sha.slice(0, 7)}`;
}

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot();
  console.error(`[curate] repo root: ${repoRoot}`);
  console.error(
    `[curate] scanning last ${SCAN} commits; size filter <=${MAX_SRC_FILES} src files / <=${MAX_CHANGED_LINES} lines; target ${LIMIT} accepted.`,
  );

  const commits = recentCommits(repoRoot, SCAN);
  console.error(`[curate] ${commits.length} non-merge commits to consider.`);

  type Survivor = {
    meta: CommitMeta;
    srcFiles: string[];
    testFiles: string[];
    changedLines: number;
  };
  const survivors: Survivor[] = [];
  for (const meta of commits) {
    const stat = diffStat(repoRoot, meta.sha, meta.parent);
    if (stat.testFiles.length === 0) continue;
    if (stat.srcFiles.length === 0) continue;
    if (stat.srcFiles.length > MAX_SRC_FILES) continue;
    if (stat.srcFiles.length < MIN_SRC_FILES) continue;
    if (stat.changedLines > MAX_CHANGED_LINES) continue;
    if (stat.changedLines < MIN_CHANGED_LINES) continue;
    const allPure = stat.testFiles.every((tf) =>
      isPureUnitTest(repoRoot, meta.sha, tf),
    );
    if (!allPure) continue;
    if (BEHAVIORAL_ONLY) {
      const allBehavioral = stat.testFiles.every((tf) =>
        isBehavioralOracle(repoRoot, meta.sha, tf),
      );
      if (!allBehavioral) continue;
    }
    survivors.push({
      meta,
      srcFiles: stat.srcFiles,
      testFiles: stat.testFiles,
      changedLines: stat.changedLines,
    });
  }
  console.error(
    `[curate] ${survivors.length} commits passed size+purity pre-filter. Now verifying red->green (the expensive part)...`,
  );

  const accepted: RealRepoCandidate[] = [];
  let verified = 0;
  for (const s of survivors) {
    if (accepted.length >= LIMIT) break;
    verified++;
    const { meta, srcFiles, testFiles } = s;
    const atHead = runOracleAt(repoRoot, meta.sha, meta.sha, testFiles[0]);
    if (!atHead.green) {
      console.error(
        `[curate] skip ${meta.sha.slice(0, 9)} — oracle not green at head (flaky/needs-deps): ${atHead.tail.replace(/\n/g, " ").slice(-160)}`,
      );
      continue;
    }
    const atBase = runOracleAt(repoRoot, meta.parent, meta.sha, testFiles[0]);
    if (atBase.green) {
      console.error(`[curate] skip ${meta.sha.slice(0, 9)} — oracle already green at parent (no red->green).`);
      continue;
    }

    const candidate: RealRepoCandidate = {
      task_id: makeTaskId(meta, testFiles),
      agent_slug: "engineer",
      bucket: bucketFor(meta.subject),
      source: `real-praxis-commit ${meta.sha.slice(0, 9)}`,
      prompt: strippedPrompt(meta, testFiles),
      base_sha: meta.parent,
      head_sha: meta.sha,
      oracle_test_files: testFiles,
      expected_touch: srcFiles,
      known_good_reference: meta.subject,
      changed_src_files: srcFiles,
      changed_lines: s.changedLines,
      red_at_base: true,
      green_at_head: true,
    };
    accepted.push(candidate);
    console.error(
      `[curate] ✓ ACCEPT ${candidate.task_id}  (${srcFiles.length} src file(s), ${s.changedLines} lines, bucket=${candidate.bucket})`,
    );
  }

  console.error(
    `[curate] verified ${verified} candidate(s); ACCEPTED ${accepted.length} red->green pure-unit task(s).`,
  );
  const outPath = OUT_BASENAME
    ? path.join(path.dirname(REAL_REPO_CANDIDATES_JSON_PATH), `${OUT_BASENAME}.json`)
    : REAL_REPO_CANDIDATES_JSON_PATH;
  fs.writeFileSync(outPath, JSON.stringify(accepted, null, 2) + "\n");
  console.error(`[curate] wrote ${outPath}`);
  if (accepted.length < 8) {
    console.error(
      `[curate] NOTE: fewer than 8 accepted. Limiting factor is the pure-unit + red->green + small-diff intersection. Re-run with a larger --scan or relaxed --max-lines, or accept the smaller real-only set (do NOT pad with synthetic tasks).`,
    );
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
