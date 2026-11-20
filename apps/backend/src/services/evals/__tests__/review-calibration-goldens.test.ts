import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const goldensPath = path.resolve(
  __dirname,
  "../../../../eval/review-calibration/engineer/goldens.json"
);

type Golden = {
  golden_id: string;
  agent_slug: string;
  axis: string;
  rule: string;
  gate_step: string;
  scenario: string;
  operator_ask: string;
  established_context: string[];
  bad_output: string;
  bad_label: string;
  good_output: string;
  good_verdict: string;
  note: string;
};

const RULES = new Set([
  "no-bug-without-invariant",
  "accept-established-upthread",
  "real-test-gap-is-valid",
]);

describe("review-calibration goldens (engineer)", () => {
  const rows = JSON.parse(fs.readFileSync(goldensPath, "utf8")) as Golden[];

  it("is a non-empty array covering all three calibration rules", () => {
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const rulesSeen = new Set(rows.map((r) => r.rule));
    for (const rule of RULES) {
      expect(rulesSeen, `rule ${rule} covered`).toContain(rule);
    }
  });

  it("every row has unique id, the engineer slug, and a known rule", () => {
    const ids = new Set<string>();
    for (const r of rows) {
      expect(r.golden_id, "golden_id").toMatch(/^rc-eng-\d+$/);
      expect(ids.has(r.golden_id), `duplicate id ${r.golden_id}`).toBe(false);
      ids.add(r.golden_id);
      expect(r.agent_slug).toBe("engineer");
      expect(r.axis).toBe("review-calibration");
      expect(RULES.has(r.rule), `unknown rule ${r.rule}`).toBe(true);
    }
  });

  it("every row carries a labeled bad→good contrast (the thing this axis measures)", () => {
    for (const r of rows) {
      for (const field of [
        "scenario",
        "operator_ask",
        "bad_output",
        "bad_label",
        "good_output",
        "good_verdict",
        "gate_step",
        "note",
      ] as const) {
        expect(
          typeof r[field] === "string" && r[field].length > 0,
          `${r.golden_id}.${field} non-empty`
        ).toBe(true);
      }
      expect(
        Array.isArray(r.established_context) && r.established_context.length > 0,
        `${r.golden_id}.established_context non-empty`
      ).toBe(true);
      expect(r.bad_output).not.toBe(r.good_output);
    }
  });
});
