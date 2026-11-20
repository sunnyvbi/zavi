import { describe, it, expect } from "vitest";
import {
  neutralizeSelfReportedTestClaim,
  NEUTRALIZE_MARKER,
} from "../neutralize-test-claim";

describe("neutralizeSelfReportedTestClaim — neutralizes false positive claims", () => {
  it("neutralizes an N/N pass line, keeps the rest of the line", () => {
    const r = neutralizeSelfReportedTestClaim("Tests: 29/29 auth tests pass · risk_class: low");
    expect(r.neutralized).toBe(true);
    expect(r.text).not.toMatch(/29\s*\/\s*29/);
    expect(r.text).toContain("test result unverified");
    expect(r.text).toContain("risk_class: low");
    expect(r.text).toContain(NEUTRALIZE_MARKER);
  });

  it("neutralizes a bare 'all tests pass' phrase", () => {
    const r = neutralizeSelfReportedTestClaim("Done — all tests pass now.");
    expect(r.neutralized).toBe(true);
    expect(r.text).not.toMatch(/all tests pass/i);
  });

  it("neutralizes 'test suite is green'", () => {
    const r = neutralizeSelfReportedTestClaim("The test suite is green.");
    expect(r.neutralized).toBe(true);
  });

  it("neutralizes a positive 'can confirm all tests pass' (bare 'can' is not a negation)", () => {
    const r = neutralizeSelfReportedTestClaim("I can confirm all tests pass.");
    expect(r.neutralized).toBe(true);
    expect(r.text).not.toMatch(/all tests pass/i);
  });

  it("preserves same-line prose around the claim (inline replacement)", () => {
    const r = neutralizeSelfReportedTestClaim("Fixed it — all tests pass. PR incoming.");
    expect(r.neutralized).toBe(true);
    expect(r.text).toContain("Fixed it");
    expect(r.text).toContain("PR incoming");
    expect(r.text).not.toMatch(/all tests pass/i);
  });

  it("preserves a leading list bullet + label", () => {
    const r = neutralizeSelfReportedTestClaim("- Tests: 12/12 passing");
    expect(r.neutralized).toBe(true);
    expect(r.text.split("\n")[0]).toMatch(/^- Tests: /);
    expect(r.text).not.toMatch(/12\s*\/\s*12/);
  });

  it("preserves a leading heading marker", () => {
    const r = neutralizeSelfReportedTestClaim("#### 8/8 tests pass");
    expect(r.neutralized).toBe(true);
    expect(r.text.split("\n")[0]).toMatch(/^#### /);
    expect(r.text).toContain("test result unverified");
  });

  it("neutralizes only the claim line, keeps surrounding prose", () => {
    const src = [
      "Rebuilt the dist bundle from source.",
      "Tests: 29/29 auth tests pass",
      "Files: apps/backend/dist/** regenerated.",
    ].join("\n");
    const r = neutralizeSelfReportedTestClaim(src);
    expect(r.neutralized).toBe(true);
    expect(r.text).toContain("Rebuilt the dist bundle from source.");
    expect(r.text).toContain("Files: apps/backend/dist/** regenerated.");
    expect(r.text).not.toMatch(/29\s*\/\s*29/);
  });
});

describe("neutralizeSelfReportedTestClaim — NEVER eats legit prose (goldens)", () => {
  const mustSurvive = [
    "I verified the migration applies cleanly.",
    "Tested the endpoint, it returns 200.",
    "I verified the fix against the installed source.",
    "This should make the failing test pass once merged.",
    "If the tests pass we can ship.",
    "Once tests pass, open the PR.",
    "The tests did not pass when I ran them.",
    "2 tests fail after this change.",
    "Running the tests will confirm the fix.",
    "I could not run the tests in the sandbox.",
    "I can't tell yet whether the tests pass.",
    "I cannot confirm the tests pass without running them.",
    "No tests exist for this module yet.",
    "The suite errored before any test ran.",
    "Confirmed the config loads without error.",
  ];
  for (const line of mustSurvive) {
    it(`leaves untouched: "${line}"`, () => {
      const r = neutralizeSelfReportedTestClaim(line);
      expect(r.neutralized).toBe(false);
      expect(r.text).toBe(line);
    });
  }

  it("does not touch a pass claim inside a fenced code block", () => {
    const src = ["```", "expect(result).toBe('all tests pass')", "```"].join("\n");
    const r = neutralizeSelfReportedTestClaim(src);
    expect(r.neutralized).toBe(false);
    expect(r.text).toBe(src);
  });

  it("does not touch the honest correction banner (a block quote)", () => {
    const src = "> ⚠️ **Correction:** the tests did not pass when I ran them.";
    const r = neutralizeSelfReportedTestClaim(src);
    expect(r.neutralized).toBe(false);
  });
});

describe("neutralizeSelfReportedTestClaim — idempotent + defensive", () => {
  it("is idempotent (second pass is a no-op)", () => {
    const first = neutralizeSelfReportedTestClaim("29/29 tests pass");
    expect(first.neutralized).toBe(true);
    const second = neutralizeSelfReportedTestClaim(first.text);
    expect(second.neutralized).toBe(false);
    expect(second.text).toBe(first.text);
  });

  it("handles empty / non-string input", () => {
    expect(neutralizeSelfReportedTestClaim("")).toEqual({ text: "", neutralized: false });
    expect(neutralizeSelfReportedTestClaim(null)).toEqual({ text: "", neutralized: false });
    expect(neutralizeSelfReportedTestClaim(undefined)).toEqual({ text: "", neutralized: false });
  });
});
