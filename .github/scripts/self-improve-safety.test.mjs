#!/usr/bin/env node

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampCap, isValidHeadSha, canMerge, HARD_CEILING } from './self-improve-safety.mjs';

const GOOD_SHA = 'a'.repeat(40);

test('HARD_CEILING is 2 (plan req #6)', () => {
  assert.equal(HARD_CEILING, 2);
});

test('clampCap never exceeds the hard ceiling of 2', () => {
  assert.equal(clampCap(2), 2);
  assert.equal(clampCap(3), 2);
  assert.equal(clampCap(99), 2);
  assert.equal(clampCap('5'), 2);
});

test('clampCap fails closed on garbage / negative / missing → 0', () => {
  assert.equal(clampCap('abc'), 0);
  assert.equal(clampCap(-1), 0);
  assert.equal(clampCap(undefined), 0);
  assert.equal(clampCap(null), 0);
  assert.equal(clampCap(''), 0);
  assert.equal(clampCap(NaN), 0);
});

test('clampCap passes through valid in-range values', () => {
  assert.equal(clampCap(0), 0);
  assert.equal(clampCap(1), 1);
  assert.equal(clampCap('1'), 1);
});

test('isValidHeadSha accepts only a full 40-hex SHA', () => {
  assert.equal(isValidHeadSha(GOOD_SHA), true);
  assert.equal(isValidHeadSha('abc123'), false);
  assert.equal(isValidHeadSha('A'.repeat(40)), false);
  assert.equal(isValidHeadSha('g'.repeat(40)), false);
  assert.equal(isValidHeadSha(''), false);
  assert.equal(isValidHeadSha(undefined), false);
  assert.equal(isValidHeadSha(null), false);
});

const BASE = {
  hasToken: true,
  isDraft: false,
  headSha: GOOD_SHA,
  requiredChecksGreen: true,
  mergedSoFar: 0,
  cap: 2,
};

test('canMerge: all-green happy path returns ok', () => {
  assert.equal(canMerge(BASE).ok, true);
});

test('canMerge FAILS CLOSED when the env-latch is unconfigured (no token)', () => {
  const r = canMerge({ ...BASE, hasToken: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /env-latch/);
});

test('canMerge BLOCKS when real GitHub required checks are not green on head SHA (plan req #2)', () => {
  assert.equal(canMerge({ ...BASE, requiredChecksGreen: false }).ok, false);
  assert.equal(canMerge({ ...BASE, requiredChecksGreen: undefined }).ok, false);
});

test('canMerge BLOCKS when head SHA is unpinnable (cannot TOCTOU-guard the merge)', () => {
  assert.equal(canMerge({ ...BASE, headSha: 'short' }).ok, false);
  assert.equal(canMerge({ ...BASE, headSha: undefined }).ok, false);
});

test('canMerge BLOCKS draft PRs (skill surfaces drafts; never auto-merges them)', () => {
  assert.equal(canMerge({ ...BASE, isDraft: true }).ok, false);
});

test('canMerge ENFORCES the per-run cap (plan req #6) — stops at the cap', () => {
  assert.equal(canMerge({ ...BASE, mergedSoFar: 2, cap: 2 }).ok, false);
  assert.equal(canMerge({ ...BASE, mergedSoFar: 1, cap: 2 }).ok, true);
  assert.equal(canMerge({ ...BASE, mergedSoFar: 0, cap: 0 }).ok, false);
});

test('canMerge: a SECOND merge in a 2-cap run is allowed, a THIRD is not', () => {
  let merged = 0;
  const cap = clampCap(2);
  for (let i = 0; i < 3; i++) {
    if (canMerge({ ...BASE, mergedSoFar: merged, cap }).ok) merged += 1;
  }
  assert.equal(merged, 2, 'exactly 2 merges land; the 3rd is held for next run');
});
