import { describe, it, expect } from "vitest";
import { __test__ } from "../post-run";
import {
  fundraisingEnvelopeSchema,
  type FundraisingInvestor,
} from "../output-schema";

const { buildCsv, csvField } = __test__;

function inv(over: Partial<FundraisingInvestor>): FundraisingInvestor {
  return {
    firm: "Firm",
    name: "",
    tier: 1,
    focus: "",
    stage_focus: "",
    check_size: "",
    fit_rationale: "fits",
    contact_hint: "",
    suggested_message: "",
    source: "investor_db",
    source_url: "",
    evidence_text: "",
    evidence_span: "",
    ...over,
  };
}

describe("fundraising CSV builder", () => {
  it("quotes + escapes fields with comma, quote, newline", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("emits a header row + one row per investor, sorted by tier 1->3", () => {
    const csv = buildCsv([
      inv({ firm: "C", tier: 3, fit_rationale: "broad" }),
      inv({ firm: "A", tier: 1, fit_rationale: "dream" }),
      inv({ firm: "B", tier: 2, fit_rationale: "solid" }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "Tier,Firm,Name,Focus,Stage,Check Size,Fit Rationale,Contact,Suggested Message",
    );
    expect(lines[1].startsWith("1,A,")).toBe(true);
    expect(lines[2].startsWith("2,B,")).toBe(true);
    expect(lines[3].startsWith("3,C,")).toBe(true);
  });

  it("escapes a comma-bearing rationale so columns stay aligned", () => {
    const csv = buildCsv([
      inv({ firm: "Acme", tier: 1, fit_rationale: "Backed X, Y, and Z" }),
    ]);
    const row = csv.split("\r\n")[1];
    expect(row).toContain('"Backed X, Y, and Z"');
  });
});

describe("fundraising envelope schema — stage anchor", () => {
  const base = {
    investors: [],
    rendered_markdown: "**Stage: Pre-seed** — pre-revenue\n\n## Investor shortlist",
  };

  it("accepts + carries a resolved stage + rationale", () => {
    const r = fundraisingEnvelopeSchema.safeParse({
      ...base,
      stage: "Pre-seed",
      stage_rationale: "pre-revenue, ~$1.5M target",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.stage).toBe("Pre-seed");
      expect(r.data.stage_rationale).toBe("pre-revenue, ~$1.5M target");
    }
  });

  it("is backward-compatible: a block with no stage still parses (stage → '')", () => {
    const r = fundraisingEnvelopeSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.stage).toBe("");
  });

  it("tolerates a casing variant instead of soft-failing the whole envelope", () => {
    const r = fundraisingEnvelopeSchema.safeParse({ ...base, stage: "Pre-Seed" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.stage).toBe("Pre-Seed");
  });
});
