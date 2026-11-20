import { describe, it, expect } from "vitest";
import { resolveCompanyShape } from "../activate";

describe("resolveCompanyShape — what may reach every agent's prompt", () => {
  it("takes the operator's own answer over an inference", () => {
    expect(
      resolveCompanyShape([
        { kind: "inferred", shape: "saas", confidence: "high" },
        { kind: "operator", shape: "marketplace" },
      ]),
    ).toEqual({ shape: "marketplace", kind: "operator" });
  });

  it("refuses a low-confidence inference", () => {
    expect(resolveCompanyShape([{ kind: "inferred", shape: "saas", confidence: "low" }])).toBeNull();
    expect(resolveCompanyShape([{ kind: "inferred", shape: "other", confidence: "low" }])).toBeNull();
    expect(resolveCompanyShape([{ kind: "inferred", shape: "saas", confidence: undefined }])).toBeNull();
  });

  it("refuses an inferred 'other' even at high confidence", () => {
    expect(resolveCompanyShape([{ kind: "inferred", shape: "other", confidence: "high" }])).toBeNull();
  });

  it("accepts a high-confidence inference when the operator said nothing", () => {
    expect(
      resolveCompanyShape([{ kind: "inferred", shape: "marketplace", confidence: "high" }]),
    ).toEqual({ shape: "marketplace", kind: "inferred" });
  });

  it("prefers a high-confidence inference over an operator's bare 'other'", () => {
    expect(
      resolveCompanyShape([
        { kind: "operator", shape: "other" },
        { kind: "inferred", shape: "saas", confidence: "high" },
      ]),
    ).toEqual({ shape: "saas", kind: "inferred" });
  });

  it("falls back to the operator's 'other' when nothing else qualifies", () => {
    expect(
      resolveCompanyShape([
        { kind: "operator", shape: "other" },
        { kind: "inferred", shape: "saas", confidence: "low" },
      ]),
    ).toEqual({ shape: "other", kind: "operator" });
  });

  it("rejects anything outside the canonical shape set", () => {
    expect(resolveCompanyShape([{ kind: "operator", shape: "unicorn" }])).toBeNull();
    expect(resolveCompanyShape([{ kind: "operator", shape: "" }])).toBeNull();
    expect(resolveCompanyShape([{ kind: "operator", shape: null }])).toBeNull();
    expect(resolveCompanyShape([{ kind: "operator", shape: 42 }])).toBeNull();
  });

  it("normalizes case and whitespace", () => {
    expect(resolveCompanyShape([{ kind: "operator", shape: "  MarketPlace " }])).toEqual({
      shape: "marketplace",
      kind: "operator",
    });
  });

  it("returns null for no candidates, so the column stays NULL and fails open", () => {
    expect(resolveCompanyShape([])).toBeNull();
  });
});
