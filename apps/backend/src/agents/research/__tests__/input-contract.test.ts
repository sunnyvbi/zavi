import { describe, it, expect } from "vitest";
import { researchInputSchema } from "../input-contract";

describe("researchInputSchema", () => {
  it("accepts a bare ask", () => {
    expect(researchInputSchema.safeParse({ ask: "research Turo" }).success).toBe(true);
  });
  it("accepts ask + clarification answers + parent_run_id", () => {
    const ok = researchInputSchema.safeParse({ ask: "x", clarification_answers: ["us only"], parent_run_id: "run_123" });
    expect(ok.success).toBe(true);
  });
  it("rejects an empty ask", () => {
    expect(researchInputSchema.safeParse({ ask: "" }).success).toBe(false);
  });
});
