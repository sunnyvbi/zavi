import { describe, it, expect } from "vitest";
import { scoreAtoms } from "../eval/atom-scorer";
import type { ToolCallTrace } from "@/services/tools/types";

function trace(
  name: string,
  output: string,
  status: ToolCallTrace["status"] = "ok",
): ToolCallTrace {
  return { name, input_preview: "", output_preview: output, ms: 12, status };
}

const META_OUT =
  '{"ad_sets":[{"ad_set_name":"Host ad set","daily_budget_usd":30,"spend_usd":209.4,"roas":0,' +
  '"geo_locations":{"cities":[{"name":"Miami","radius":50},{"name":"Orlando","radius":25}]}}]}';

describe("scoreAtoms — Tier-1 mechanical-atom scorer", () => {
  describe("number atoms — money grounding (reuse of amountInToolOutputs)", () => {
    it("PASSES a $-number that appears as a money value in a tool output", () => {
      const r = scoreAtoms({
        outputText: "I'd raise the Host ad set to $30/day.",
        toolCalls: [trace("meta_ads__list_ad_sets", META_OUT)],
      });
      const numAtoms = r.atoms.filter((a) => a.kind === "number");
      expect(numAtoms.length).toBe(1);
      expect(numAtoms[0].text).toContain("30");
      expect(numAtoms[0].verdict).toBe("pass");
      expect(r.surviving).toBeGreaterThanOrEqual(1);
    });

    it("FAILS a $-number absent from every tool output", () => {
      const r = scoreAtoms({
        outputText: "Keep host campaigns under the $50/week cap.",
        toolCalls: [trace("meta_ads__list_ad_sets", META_OUT)],
      });
      const numAtoms = r.atoms.filter((a) => a.kind === "number");
      expect(numAtoms.length).toBe(1);
      expect(numAtoms[0].text).toContain("50");
      expect(numAtoms[0].verdict).toBe("fail");
    });

    it("FAILS every $-number when there are NO tool calls at all", () => {
      const r = scoreAtoms({
        outputText: "Spend was $209.4 and budget is $30.",
        toolCalls: [],
      });
      const numAtoms = r.atoms.filter((a) => a.kind === "number");
      expect(numAtoms.length).toBe(2);
      expect(numAtoms.every((a) => a.verdict === "fail")).toBe(true);
      expect(r.surviving).toBe(0);
    });

    it("PASSES a decimal $-number present in a tool output", () => {
      const r = scoreAtoms({
        outputText: "Total spend this week is $209.4.",
        toolCalls: [trace("meta_ads__list_ad_sets", META_OUT)],
      });
      const numAtoms = r.atoms.filter((a) => a.kind === "number");
      expect(numAtoms.length).toBe(1);
      expect(numAtoms[0].verdict).toBe("pass");
    });

    it("ignores memory-tool outputs as a grounding source (memory ≠ live tool)", () => {
      const r = scoreAtoms({
        outputText: "Host campaigns are capped at $50/week.",
        toolCalls: [
          trace("memory__search", '{"notes":["$50 referral reward"]}'),
        ],
      });
      const numAtoms = r.atoms.filter((a) => a.kind === "number");
      expect(numAtoms[0].verdict).toBe("fail");
    });
  });

  describe("claim atoms — coverage bookkeeping (unverifiable)", () => {
    it("counts non-numeric sentences as 'claim' atoms with verdict 'unverifiable'", () => {
      const r = scoreAtoms({
        outputText: "The Miami market looks promising. We should expand there.",
        toolCalls: [],
      });
      const claimAtoms = r.atoms.filter((a) => a.kind === "claim");
      expect(claimAtoms.length).toBeGreaterThanOrEqual(1);
      expect(claimAtoms.every((a) => a.verdict === "unverifiable")).toBe(true);
    });
  });

  describe("url atoms — Tier-2 stub (unverifiable unless eval flag)", () => {
    it("marks a URL atom 'unverifiable' by default (no live fetch this slice)", () => {
      const r = scoreAtoms({
        outputText: "See the dashboard at https://example.com/report for detail.",
        toolCalls: [],
      });
      const urlAtoms = r.atoms.filter((a) => a.kind === "url");
      expect(urlAtoms.length).toBe(1);
      expect(urlAtoms[0].verdict).toBe("unverifiable");
    });

    it("still 'unverifiable' even with the eval-only entailment flag on (stub)", () => {
      const r = scoreAtoms({
        outputText: "See https://example.com/report.",
        toolCalls: [],
        evalUrlEntailment: true,
      });
      const urlAtoms = r.atoms.filter((a) => a.kind === "url");
      expect(urlAtoms[0].verdict).toBe("unverifiable");
    });
  });

  describe("coverage + grade math", () => {
    it("coverage = (verifiable atoms) / total; grade = (surviving/total) * coverage", () => {
      const r = scoreAtoms({
        outputText:
          "Budget is $30/day. The fake cap is $50/week. Miami looks strong.",
        toolCalls: [trace("meta_ads__list_ad_sets", META_OUT)],
      });
      expect(r.total).toBe(3);
      expect(r.surviving).toBe(2);
      expect(r.coverage).toBeCloseTo(2 / 3, 5);
      expect(r.grade).toBeCloseTo((2 / 3) * (2 / 3), 5);
    });

    it("a fully-grounded numeric reply grades higher than a fully-fabricated one", () => {
      const good = scoreAtoms({
        outputText: "Spend is $209.4 and budget is $30.",
        toolCalls: [trace("meta_ads__list_ad_sets", META_OUT)],
      });
      const bad = scoreAtoms({
        outputText: "Spend is $999 and budget is $888.",
        toolCalls: [trace("meta_ads__list_ad_sets", META_OUT)],
      });
      expect(good.grade).toBeGreaterThan(bad.grade);
      expect(bad.surviving).toBe(0);
    });
  });

  describe("empty / degenerate input", () => {
    it("empty output → zero atoms, coverage 0, grade 0 (no NaN)", () => {
      const r = scoreAtoms({ outputText: "", toolCalls: [] });
      expect(r.atoms).toEqual([]);
      expect(r.total).toBe(0);
      expect(r.surviving).toBe(0);
      expect(r.coverage).toBe(0);
      expect(r.grade).toBe(0);
      expect(Number.isNaN(r.grade)).toBe(false);
    });

    it("non-string output is tolerated (treated as empty)", () => {
      const r = scoreAtoms({
        // @ts-expect-error — defensive: caller may pass a non-string at runtime.
        outputText: null,
        toolCalls: [],
      });
      expect(r.total).toBe(0);
      expect(r.grade).toBe(0);
    });
  });
});
