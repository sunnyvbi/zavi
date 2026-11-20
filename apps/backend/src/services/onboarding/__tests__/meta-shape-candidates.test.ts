import { describe, expect, it } from "vitest";
import { metaShapeCandidates } from "../shape-candidates";

describe("metaShapeCandidates: the website signup's scan is an inference (#4387)", () => {
  it("sends the scan's type at its confidence as an inference, ignoring the wizard fallback", () => {
    expect(metaShapeCandidates({ wizard: { marketplaceShape: "other" }, scan: { inferredShape: "saas", inferredStage: 3, shapeConfidence: "high" } }))
      .toEqual([{ kind: "inferred", shape: "saas", confidence: "high" }]);
    expect(metaShapeCandidates({ wizard: { marketplaceShape: "saas" }, scan: { inferredShape: "saas", shapeConfidence: "low" } }))
      .toEqual([{ kind: "inferred", shape: "saas", confidence: "low" }]);
  });
  it("offers nothing when the scan found nothing, so the wizard's 'other' is never saved as the founder's", () => {
    expect(metaShapeCandidates({ wizard: { marketplaceShape: "other" }, scan: { inferredShape: null, inferredStage: null, shapeConfidence: null } })).toEqual([]);
  });
  it("still takes the wizard shape as the founder's pick when no scan is sent", () => {
    expect(metaShapeCandidates({ wizard: { marketplaceShape: "fintech" } })).toEqual([{ kind: "operator", shape: "fintech" }]);
    expect(metaShapeCandidates(undefined)).toEqual([]);
    expect(metaShapeCandidates({ wizard: {} })).toEqual([]);
  });
});
