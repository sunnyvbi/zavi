#!/usr/bin/env node

export const HARD_CEILING = 2;

export function clampCap(requested) {
  const n = typeof requested === 'number' ? requested : parseInt(String(requested ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, HARD_CEILING);
}

export function isValidHeadSha(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha);
}

export function canMerge({ hasToken, isDraft, headSha, requiredChecksGreen, mergedSoFar, cap }) {
  if (hasToken !== true) return { ok: false, reason: 'env-latch unconfigured (no merge token)' };
  if (mergedSoFar >= cap) return { ok: false, reason: `per-run cap reached (${mergedSoFar}/${cap})` };
  if (isDraft === true) return { ok: false, reason: 'PR is draft (surfaced, not auto-merge)' };
  if (!isValidHeadSha(headSha)) return { ok: false, reason: 'head SHA missing/invalid (cannot pin)' };
  if (requiredChecksGreen !== true) return { ok: false, reason: 'required checks not green on head SHA' };
  return { ok: true, reason: 'agent-prompt PR, checks green on head SHA, under cap' };
}
