import { describe, expect, it } from "vitest";
import { extractSignals } from "../signals";
import { scoreSignalRecall } from "../scorer";
import { CAP_RECALL_FIXTURES } from "../fixtures";

function fixture(name: string) {
  const fx = CAP_RECALL_FIXTURES.find((f) => f.name === name);
  if (!fx) throw new Error(`fixture not found: ${name}`);
  return fx;
}

describe("extractSignals", () => {
  it("pulls tsc codes + file(line,col) refs", () => {
    const sigs = extractSignals(
      "src/services/payments/refund.ts(142,7): error TS2345: Argument of type 'string'…",
    );
    expect(sigs).toContain("TS2345");
    expect(sigs).toContain("src/services/payments/refund.ts(142,7)");
  });

  it("pulls eslint rule ids", () => {
    const sigs = extractSignals(
      "  12:3   error    'amount' is assigned a value but never used        @typescript-eslint/no-unused-vars",
    );
    expect(sigs).toContain("@typescript-eslint/no-unused-vars");
  });

  it("pulls jest/vitest Expected/Received values + file:line (colon form)", () => {
    const sigs = extractSignals(
      ["   Expected: 80", "   Received: 90", "    ❯ src/cart/discount.test.ts:318:24"].join("\n"),
    );
    expect(sigs).toContain("Expected: 80");
    expect(sigs).toContain("Received: 90");
    expect(sigs).toContain("src/cart/discount.test.ts:318:24");
  });

  it("pulls vitest diff-style assertion values (no-colon - Expected / + Received form)", () => {
    const sigs = extractSignals(
      ["   - Expected", "   + Received", "", "   - 80", "   + 90"].join("\n"),
    );
    expect(sigs).toContain("- 80");
    expect(sigs).toContain("+ 90");
  });

  it("does NOT treat plain diff +/- lines as assertion values (no Expected/Received block)", () => {
    const sigs = extractSignals(
      ["diff --git a/foo.ts b/foo.ts", "-const x = 1;", "+const x = 2;"].join("\n"),
    );
    expect(sigs).toEqual([]);
  });

  it("fabricates no signals on clean output", () => {
    expect(extractSignals(" ✓ formats value correctly  2ms\n Tests  300 passed (300)")).toEqual([]);
  });
});

describe("scoreSignalRecall — engineer profile keeps every signal", () => {
  for (const name of ["buried-tsc", "mid-log-assertion", "mid-log-diff-assertion", "eslint-stylish"]) {
    it(`recall is 1.0 on ${name}`, () => {
      const fx = fixture(name);
      const r = scoreSignalRecall({
        raw: fx.raw,
        capBytes: fx.capBytes,
        capProfile: "engineer",
        nonZeroExit: fx.nonZeroExit,
      });
      expect(r.fullSignals.length).toBeGreaterThan(0);
      expect(r.dropped).toEqual([]);
      expect(r.recall).toBe(1);
    });
  }
});

describe("the semantic layer earns its keep", () => {
  it("DEFAULT (head+tail) recall is LOWER than engineer on the buried error", () => {
    const fx = fixture("buried-tsc");
    const engineer = scoreSignalRecall({
      raw: fx.raw,
      capBytes: fx.capBytes,
      capProfile: "engineer",
      nonZeroExit: fx.nonZeroExit,
    });
    const dflt = scoreSignalRecall({
      raw: fx.raw,
      capBytes: fx.capBytes,
      capProfile: "default",
      nonZeroExit: fx.nonZeroExit,
    });
    expect(engineer.recall).toBe(1);
    expect(dflt.recall).toBeLessThan(engineer.recall);
  });
});

describe("the whole curated set is the gate", () => {
  it("every fixture is at engineer recall 1.0 (the flip-the-flag bar)", () => {
    for (const fx of CAP_RECALL_FIXTURES) {
      const r = scoreSignalRecall({
        raw: fx.raw,
        capBytes: fx.capBytes,
        capProfile: "engineer",
        nonZeroExit: fx.nonZeroExit,
      });
      expect({ name: fx.name, dropped: r.dropped }).toEqual({ name: fx.name, dropped: [] });
    }
  });
});
