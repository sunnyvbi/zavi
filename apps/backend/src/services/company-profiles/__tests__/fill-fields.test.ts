import { describe, expect, it } from "vitest";
import { extractCompanyFields, fillFieldsPrompt, FILLABLE_FIELDS } from "../fill-fields";

const KEYS = ["avg_deal_size", "buyer", "gross_margin"];

describe("fillFieldsPrompt", () => {
  it("asks only for the requested fields and forbids guessing", () => {
    const prompt = fillFieldsPrompt(KEYS, "Upcar");
    expect(prompt).toContain("Upcar");
    expect(prompt).toContain("- avg_deal_size (Avg deal size)");
    expect(prompt).toContain("- buyer (Buyer)");
    expect(prompt).not.toContain("- personas");
    expect(prompt).toMatch(/memory__search first/);
    expect(prompt).toMatch(/COMPUTE it live from raw data/);
    expect(prompt).toMatch(/operator_db__query/);
    expect(prompt).toMatch(/Never use industry benchmarks/);
    expect(prompt).toContain("gross_margin (Gross margin): CALCULATE when the data allows");
    expect(prompt).toContain("<company_fields>");
  });

  it("covers every fillable slot key", () => {
    expect(new Set(FILLABLE_FIELDS.map((field) => field.key)).size).toBe(FILLABLE_FIELDS.length);
  });
});

describe("extractCompanyFields", () => {
  const output = [
    "Here is what I found from Stripe and the brain.",
    "<company_fields>",
    JSON.stringify({
      fields: [
        { key: "avg_deal_size", value: "$184", method: "calculated", source: "stripe charges, last 90 days", formula: "$57,408 ÷ 312", inputs: [{ name: "net revenue 90d", value: "$57,408" }, { name: "charges", value: "312" }], assumptions: "mean of 312 charges net of refunds", caveats: "single currency", confidence: "medium", evidence: ["312 charges, $57,408"] },
        { key: "buyer", value: "Car owners listing a vehicle", source: "company brain", assumptions: "", confidence: "high" },
        { key: "personas", value: "should be dropped", source: "", assumptions: "" },
        { key: "buyer", value: "duplicate", source: "", assumptions: "" },
      ],
      unfilled: [{ key: "gross_margin", reason: "no COGS on record" }, { key: "buyer", reason: "ignored because filled" }],
    }),
    "</company_fields>",
  ].join("\n");

  it("keeps only requested, first-seen fields and their unfilled reasons", () => {
    const result = extractCompanyFields(output, KEYS);
    expect(result?.fields.map((field) => field.key)).toEqual(["avg_deal_size", "buyer"]);
    expect(result?.fields[0]).toMatchObject({
      value: "$184",
      method: "calculated",
      formula: "$57,408 ÷ 312",
      inputs: [{ name: "net revenue 90d", value: "$57,408" }, { name: "charges", value: "312" }],
      caveats: "single currency",
      confidence: "medium",
      evidence: ["312 charges, $57,408"],
    });
    expect(result?.fields[1]).toMatchObject({ confidence: "high", method: "inferred", formula: "", inputs: [], caveats: "" });
    expect(result?.unfilled).toEqual([{ key: "gross_margin", reason: "no COGS on record" }]);
  });

  it("returns null without a well-formed envelope", () => {
    expect(extractCompanyFields("no block here", KEYS)).toBeNull();
    expect(extractCompanyFields("<company_fields>{not json}</company_fields>", KEYS)).toBeNull();
    expect(extractCompanyFields('<company_fields>{"fields":[{"key":"nope","value":"x"}]}</company_fields>', KEYS)).toBeNull();
    expect(extractCompanyFields(null, KEYS)).toBeNull();
  });

  it("tolerates a fenced JSON block", () => {
    const fenced = '<company_fields>```json\n{"fields":[],"unfilled":[]}\n```</company_fields>';
    expect(extractCompanyFields(fenced, KEYS)).toEqual({ fields: [], unfilled: [] });
  });
});
