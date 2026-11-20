#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { clampCap, canMerge } from './self-improve-safety.mjs';

const LABEL = process.env.SELF_IMPROVE_LABEL || 'self-improve-auto';
const REPO = process.env.GH_REPO || '';
const TOKEN = process.env.GH_TOKEN || '';

function gh(args, { allowFail = false } = {}) {
  const res = spawnSync('gh', args, { encoding: 'utf8', env: process.env });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`gh ${args.join(' ')} failed: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  }
  return res;
}

function requiredChecksGreen(prNumber, headSha) {
  const res = gh(
    ['pr', 'checks', String(prNumber), '--repo', REPO, '--required'],
    { allowFail: true }
  );
  const green = res.status === 0;
  console.log(
    `[merge] PR #${prNumber} head=${headSha.slice(0, 8)} required-checks ${green ? 'GREEN' : 'NOT-GREEN'} (gh pr checks exit ${res.status})`
  );
  if (!green) {
    console.log(`[merge]   ${(res.stdout || res.stderr || '').trim().split('\n').slice(0, 8).join(' | ')}`);
  }
  return green;
}

function main() {
  if (!TOKEN) {
    console.log('[merge] no GH_TOKEN — env-latch unconfigured. FAIL-CLOSED: merging nothing.');
    return;
  }
  if (!REPO) {
    console.log('[merge] no GH_REPO — refusing. FAIL-CLOSED.');
    return;
  }

  const cap = clampCap(process.env.MERGE_CAP);
  if (cap === 0) {
    console.log('[merge] cap=0 — merging nothing this run.');
    return;
  }
  console.log(`[merge] per-run merge cap = ${cap} (hard ceiling ${HARD_CEILING}).`);

  const listRes = gh([
    'pr', 'list',
    '--repo', REPO,
    '--state', 'open',
    '--base', 'main',
    '--label', LABEL,
    '--json', 'number,headRefOid,title,isDraft',
    '--limit', '20',
  ]);
  let prs = [];
  try { prs = JSON.parse(listRes.stdout || '[]'); } catch { prs = []; }
  console.log(`[merge] ${prs.length} candidate PR(s) labeled '${LABEL}'.`);

  let merged = 0;
  for (const pr of prs) {
    if (merged >= cap) {
      console.log(`[merge] cap (${cap}) reached — stopping. Remaining PRs wait for next run.`);
      break;
    }
    const headSha = String(pr.headRefOid || '');

    const checksGreen =
      !pr.isDraft && /^[0-9a-f]{40}$/.test(headSha)
        ? requiredChecksGreen(pr.number, headSha)
        : false;

    const verdict = canMerge({
      hasToken: !!TOKEN,
      isDraft: !!pr.isDraft,
      headSha,
      requiredChecksGreen: checksGreen,
      mergedSoFar: merged,
      cap,
    });
    if (!verdict.ok) {
      console.log(`[merge] PR #${pr.number} — NOT merging: ${verdict.reason}.`);
      continue;
    }

    console.log(`[merge] PR #${pr.number} — merging (squash, pinned to ${headSha.slice(0, 8)}).`);
    const mres = gh(
      ['pr', 'merge', String(pr.number), '--repo', REPO, '--squash', '--match-head-commit', headSha],
      { allowFail: true }
    );
    if (mres.status === 0) {
      merged += 1;
      console.log(`[merge] PR #${pr.number} MERGED (${merged}/${cap}).`);
    } else {
      console.log(`[merge] PR #${pr.number} merge refused by GitHub (exit ${mres.status}): ${(mres.stderr || mres.stdout || '').slice(0, 200)} — likely branch-protection/required-checks/SHA-mismatch. Leaving open.`);
    }
  }
  console.log(`[merge] done — ${merged} PR(s) merged this run (cap ${cap}).`);
}

try {
  main();
} catch (e) {
  console.log(`[merge] fatal (${e?.message ?? e}) — FAIL-CLOSED, nothing merged.`);
  process.exitCode = 1;
}
