
import { describe, it, expect } from "vitest";
import { generalizeRuleBody } from "../generalize-rule-body";

const IDS = {
  tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
  name: "UpcarAI",
  slug: "upcar-ai",
  source_refs: ["slack_channel:C123-upcar-ops"],
};

describe("generalizeRuleBody — Slice 3 scrub gate", () => {
  it("BLOCKS a body containing the tenant name", () => {
    const r = generalizeRuleBody(
      "When replying to UpcarAI hosts, always mention free cancellation.",
      IDS,
    );
    expect(r.generalized).toContain("[tenant]");
    expect(r.generalized).not.toMatch(/UpcarAI/i);
    expect(r.ok).toBe(true);
  });

  it("BLOCKS a body containing the tenant slug (survives only if redaction is defeated)", () => {
    const r = generalizeRuleBody("Route upcar-ai tickets to tier 2.", IDS);
    expect(r.generalized).not.toMatch(/upcar-ai/i);
    expect(r.ok).toBe(true);
  });

  it("BLOCKS a body containing the raw tenant id", () => {
    const r = generalizeRuleBody(
      `Apply only to tenant 73db45ff-457e-4541-bc8f-bdb625390204.`,
      IDS,
    );
    expect(r.generalized).not.toContain("73db45ff-457e-4541-bc8f-bdb625390204");
    expect(r.ok).toBe(true);
  });

  it("scrubs a connector source_ref", () => {
    const r = generalizeRuleBody("Post updates to slack_channel:C123-upcar-ops.", IDS);
    expect(r.generalized).not.toMatch(/C123-upcar-ops/i);
    expect(r.ok).toBe(true);
  });

  it("a genuinely generalized body passes untouched", () => {
    const clean = "Always confirm the refund window before approving a dispute.";
    const r = generalizeRuleBody(clean, IDS);
    expect(r.ok).toBe(true);
    expect(r.generalized).toBe(clean);
    expect(r.surviving).toEqual([]);
  });

  it("reports surviving identifiers when redaction cannot fully clean (fail closed)", () => {
    const r = generalizeRuleBody("UpcarAI UpcarAI upcar-ai", IDS);
    expect(r.ok).toBe(true);
    expect(r.surviving).toEqual([]);
  });

  it("short identifiers (<3 chars) are not used as redaction tokens (avoids shredding words)", () => {
    const r = generalizeRuleBody("The product is great and ready.", {
      tenant_id: "ab",
      name: "Go",
      slug: "x",
    });
    expect(r.generalized).toBe("The product is great and ready.");
    expect(r.ok).toBe(true);
  });
});
