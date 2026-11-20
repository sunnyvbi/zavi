import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const goldensPath = path.resolve(
  __dirname,
  "../../../../eval/review-calibration/operator/goldens.json",
);

const RULES = new Set(["depth-over-politeness", "no-manufactured-severity"]);

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
  why_bad: string;
  good_output: string;
  good_label: string;
  why_good: string;
};

describe("review-calibration goldens (operator)", () => {
  const rows = JSON.parse(fs.readFileSync(goldensPath, "utf8")) as Golden[];

  it("is a non-empty array covering both calibration directions", () => {
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const rulesSeen = new Set(rows.map((r) => r.rule));
    for (const rule of RULES) {
      expect(rulesSeen, `rule ${rule} covered`).toContain(rule);
    }
  });

  it("every row has a unique id, the operator slug, and a known rule", () => {
    const ids = new Set<string>();
    for (const r of rows) {
      expect(r.golden_id, "golden_id").toMatch(/^rc-op-\d+$/);
      expect(ids.has(r.golden_id), `duplicate id ${r.golden_id}`).toBe(false);
      ids.add(r.golden_id);
      expect(r.agent_slug).toBe("operator");
      expect(r.axis).toBe("review-calibration");
      expect(RULES.has(r.rule), `unknown rule ${r.rule}`).toBe(true);
    }
  });

  it("every row carries a labeled bad→good contrast with reasons", () => {
    for (const r of rows) {
      for (const field of [
        "scenario",
        "operator_ask",
        "bad_output",
        "bad_label",
        "why_bad",
        "good_output",
        "good_label",
        "why_good",
        "gate_step",
      ] as const) {
        expect(
          typeof r[field] === "string" && r[field].length > 0,
          `${r.golden_id}.${field} non-empty`,
        ).toBe(true);
      }
      expect(
        Array.isArray(r.established_context) && r.established_context.length > 0,
        `${r.golden_id}.established_context non-empty`,
      ).toBe(true);
      expect(r.bad_output, `${r.golden_id} bad≠good`).not.toBe(r.good_output);
    }
  });

  it("keeps the Monique incident as the canonical depth-over-politeness golden", () => {
    const monique = rows.find((r) => r.golden_id === "rc-op-001");
    expect(monique, "rc-op-001 present").toBeTruthy();
    expect(monique?.rule).toBe("depth-over-politeness");
    expect(monique?.bad_label).toBe("shallow-review-hedge");
  });
});
