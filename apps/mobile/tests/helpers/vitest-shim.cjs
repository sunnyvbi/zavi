const assert = require("node:assert/strict");
const test = require("node:test");

const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : x))));

function subset(actual, expected) {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => subset(actual[i], e));
  }
  return Object.keys(expected).every((k) => subset(actual[k], expected[k]));
}

function matchers(actual, negate, label) {
  const check = (pass, message) => {
    if (negate ? pass : !pass) assert.fail(`${label ? `${label}: ` : ""}${negate ? "not." : ""}${message}`);
  };
  return {
    toBe: (expected) => check(Object.is(actual, expected), `toBe: ${String(actual)} vs ${String(expected)}`),
    toEqual: (expected) => {
      let pass = true;
      try {
        assert.deepStrictEqual(plain(actual), plain(expected));
      } catch {
        pass = false;
      }
      check(pass, `toEqual: ${JSON.stringify(plain(actual))} vs ${JSON.stringify(plain(expected))}`);
    },
    toBeNull: () => check(actual === null, `toBeNull: ${String(actual)}`),
    toBeUndefined: () => check(actual === undefined, `toBeUndefined: ${String(actual)}`),
    toBeTruthy: () => check(Boolean(actual), `toBeTruthy: ${String(actual)}`),
    toBeFalsy: () => check(!actual, `toBeFalsy: ${String(actual)}`),
    toMatch: (re) => check(typeof re === "string" ? String(actual).includes(re) : re.test(String(actual)), `toMatch: ${String(actual)} ~ ${re}`),
    toContain: (item) => check(actual != null && actual.includes(item), `toContain: ${JSON.stringify(actual)} has ${JSON.stringify(item)}`),
    toHaveLength: (n) => check(actual != null && actual.length === n, `toHaveLength: ${actual?.length} vs ${n}`),
    toBeGreaterThan: (n) => check(actual > n, `toBeGreaterThan: ${actual} > ${n}`),
    toBeLessThan: (n) => check(actual < n, `toBeLessThan: ${actual} < ${n}`),
    toBeLessThanOrEqual: (n) => check(actual <= n, `toBeLessThanOrEqual: ${actual} <= ${n}`),
    toBeGreaterThanOrEqual: (n) => check(actual >= n, `toBeGreaterThanOrEqual: ${actual} >= ${n}`),
    toBeCloseTo: (n, digits = 2) => check(Math.abs(actual - n) < 10 ** -digits / 2, `toBeCloseTo: ${actual} ~ ${n}`),
    toHaveProperty: (key) =>
      check(actual != null && Object.prototype.hasOwnProperty.call(actual, key), `toHaveProperty: ${String(key)}`),
    toMatchObject: (expected) =>
      check(subset(plain(actual), plain(expected)), `toMatchObject: ${JSON.stringify(plain(actual))} has ${JSON.stringify(plain(expected))}`),
  };
}

function expect(actual, label) {
  return { ...matchers(actual, false, label), not: matchers(actual, true, label) };
}

const describe = (name, fn) => test.describe(name, fn);
const it = (name, fn) => test.it(name, fn);
const format = (name, args) => {
  let i = 0;
  return name.replace(/%[sjdio]/g, (m) => {
    const v = args[i++];
    return m === "%j" ? JSON.stringify(v) : String(v);
  });
};
it.each = (rows) => (name, fn) => {
  for (const row of rows) {
    const args = Array.isArray(row) ? row : [row];
    test.it(format(name, args), () => fn(...args));
  }
};

module.exports = { describe, it, expect };
