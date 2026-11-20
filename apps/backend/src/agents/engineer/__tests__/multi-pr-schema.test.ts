import { describe, it, expect } from "vitest";
import {
  prProposalModelOutputSchema,
  prProposalSchema,
  prProposalProductBuildSchema,
} from "../output-schema";

const baseModel = {
  repo: "rravi149/upcar",
  base_branch: "main",
  head_branch: "engineer/tos-update",
  title: "legal(tos): update arbitration clause",
  body: "body",
  rendered_markdown: "## Plan\nUpdate clause.",
  risk_class: "low",
  test_results: { passed: 0, failed: 0, output_tail: "" },
};

describe("pr_proposal base_branches (multi-PR fan-out)", () => {
  it("accepts a base_branches array on the model-output schema", () => {
    const r = prProposalModelOutputSchema.safeParse({
      ...baseModel,
      base_branches: ["development", "main"],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.base_branches).toEqual(["development", "main"]);
  });

  it("is fully optional — single-PR envelopes still validate without it", () => {
    const r = prProposalModelOutputSchema.safeParse(baseModel);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.base_branches).toBeUndefined();
  });

  it("rejects more than 5 bases (runaway fan-out guard)", () => {
    const r = prProposalModelOutputSchema.safeParse({
      ...baseModel,
      base_branches: ["a", "b", "c", "d", "e", "f"],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty base_branches array", () => {
    const r = prProposalModelOutputSchema.safeParse({
      ...baseModel,
      base_branches: [],
    });
    expect(r.success).toBe(false);
  });

  it("product-build schema accepts a single file with a >64KB synthesized create-diff", () => {
    const bigDiff = "+x\n".repeat(40_000);
    expect(bigDiff.length).toBeGreaterThan(64 * 1024);
    expect(bigDiff.length).toBeLessThan(1024 * 1024);
    const r = prProposalProductBuildSchema.safeParse({
      ...baseModel,
      head_branch: "product-builder/scaffold-dashboard",
      push_to_main: true,
      files: [
        {
          path: "lib/data/mocks.ts",
          action: "create",
          content: "x\n".repeat(40_000),
          diff: bigDiff,
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("strict (customer-PR) schema still rejects a >64KB per-file diff", () => {
    const bigDiff = "+x\n".repeat(40_000);
    const r = prProposalSchema.safeParse({
      ...baseModel,
      files: [
        {
          path: "lib/data/mocks.ts",
          action: "create",
          content: "x\n".repeat(40_000),
          diff: bigDiff,
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("carries base_branches through the decision-body schema (with files)", () => {
    const r = prProposalSchema.safeParse({
      ...baseModel,
      base_branches: ["development", "main"],
      files: [
        {
          path: "QA_TOUCH.md",
          action: "create",
          content: "qa touch 2026-05-20\n",
          diff: "+qa touch 2026-05-20",
        },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.base_branches).toEqual(["development", "main"]);
  });
});
